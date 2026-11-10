import { ZeitguruClientError, type ZeitguruClient, type ZeitguruTokens } from './zeitguruClient.ts'
import {
  zeitguruAddDays, zeitguruCreditPrefix, zeitguruIdentifier, zeitguruRecord, zeitguruWallTime,
  type ZeitguruBinding, type ZeitguruClockRow, type ZeitguruObject,
} from './zeitguruProtocol.ts'

/** Historical source evidence is server-only and must be encrypted by the archive store. */
export interface ZeitguruHistoryRow {
  sourceId: string; date: string; startedAt: string; stoppedAt: string;
  breakMinutes: number; workedMinutes: number; creditedMinutes: number | null;
  approved: boolean | null; autoClockOut: boolean; paidBreak: boolean; branchName?: string;
  details: { rawRow: ZeitguruClockRow; rawCredit: unknown; warnings: string[] }
}
export interface ZeitguruHistoryProgress { completedMonths: number; totalMonths: number; rowsRead: number }
export interface ZeitguruHistoryResult {
  fromDate: string | null; toDate: string; observedAt: string; rows: ZeitguruHistoryRow[];
  skipped: { count: number; reasons: string[] }; warnings: string[];
  /** Dates and safe reason codes only; no provider IDs, notes or credentials. */
  reviewDays: { date: string; reason: string }[];
}
type HistoryClient = Pick<ZeitguruClient, 'readSnapshot' | 'readOwnHistoryStart' | 'readOwnHistoryRange' | 'readOwnCreditRange'>
const maximumRows = 10_000, maximumMonths = 240
const fail = (code: string): never => { throw new ZeitguruClientError(code, 409) }
function validDate(date: string) {
  try { return zeitguruAddDays(date, 0) } catch { return fail('invalid_history_date') }
}
function minuteOfDay(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value)) return fail('invalid_history_row')
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}
function wallInstant(date: string, minute: number) {
  const actualDate = minute === 1440 ? zeitguruAddDays(date, 1) : date
  const actualMinute = minute === 1440 ? 0 : minute
  const time = `${String(Math.floor(actualMinute / 60)).padStart(2, '0')}:${String(actualMinute % 60).padStart(2, '0')}`
  const nominal = Date.parse(`${actualDate}T${time}:00Z`)
  // Berlin's modern wall times have either one, zero (spring gap), or two (fall fold)
  // matching instants. Never choose an arbitrary occurrence of an ambiguous punch.
  const matches = [60, 120].map((offset) => nominal - offset * 60_000).filter((instant) => {
    const wall = zeitguruWallTime(instant); return wall.date === actualDate && wall.time === time
  })
  if (matches.length !== 1) return fail('ambiguous_daylight_saving_time')
  return { instant: matches[0], date: actualDate }
}
function optionalBoolean(value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') return fail('invalid_history_row')
  return value
}
function creditForRow(row: ZeitguruClockRow, rawCredit: unknown, collides: boolean, workedMinutes: number, approved: boolean | null) {
  const warnings: string[] = []
  if (collides) return { creditedMinutes: null, warnings: ['credit_prefix_collision'] }
  if (rawCredit === null || rawCredit === undefined) {
    if (approved === true) warnings.push('accepted_credit_missing')
    return { creditedMinutes: approved === false ? 0 : null, warnings }
  }
  let group: ZeitguruObject
  try { group = zeitguruRecord(rawCredit) } catch { return { creditedMinutes: null, warnings: ['invalid_credit_data'] } }
  // C alone is not the complete credited amount when legacy/surcharge components coexist.
  // Keep every original component as evidence, but do not label a partial amount as credited.
  if (Object.keys(group).some((key) => key !== 'C')) return { creditedMinutes: null, warnings: ['additional_credit_components'] }
  const credit = group.C
  if (credit === undefined || credit === null) {
    if (approved === true) warnings.push('accepted_credit_missing')
    return { creditedMinutes: approved === false && !warnings.length ? 0 : null, warnings }
  }
  if (typeof credit !== 'number' || !Number.isFinite(credit) || credit < 0 || credit > 1440) return { creditedMinutes: null, warnings: [...warnings, 'invalid_credit_data'] }
  if (approved !== true) warnings.push('credit_approval_mismatch')
  if (credit !== workedMinutes) warnings.push('credit_duration_mismatch')
  if (!row.endTime) warnings.push('unfinished_row_credit')
  return { creditedMinutes: credit, warnings }
}

/** Pure archive mapping. Uses saved historical punches and credit leaves, never today's rules. */
export function mapZeitguruHistoryRows(
  rows: ZeitguruClockRow[], credits: Record<string, ZeitguruObject>, binding: ZeitguruBinding,
  throughDate: string, branchNames: ReadonlyMap<string, string> = new Map(),
): Pick<ZeitguruHistoryResult, 'rows' | 'skipped' | 'warnings' | 'reviewDays'> {
  validDate(throughDate)
  const mapped: ZeitguruHistoryRow[] = [], reasons = new Set<string>(), warnings = new Set<string>(), prefixes = new Map<string, number>(), ids = new Set<string>()
  let skippedCount = 0
  const reviewDays = new Map<string, { date: string; reason: string }>()
  const review = (day: string, reason: string) => {
    try { validDate(day) } catch { return }
    if (day <= throughDate) reviewDays.set(`${day}/${reason}`, { date: day, reason })
  }
  for (const row of rows) {
    if (row.userId !== binding.userId || row.userId_date !== `${binding.userId}_${row.date}`) fail('identity_mismatch')
    try { zeitguruIdentifier(row.id) } catch { return fail('invalid_history_row') }
    if (ids.has(row.id)) fail('duplicate_history_identity')
    ids.add(row.id)
    const key = `${row.date}/${zeitguruCreditPrefix(row.id)}`
    prefixes.set(key, (prefixes.get(key) ?? 0) + 1)
  }
  for (const row of rows) {
    try {
      validDate(row.date)
      if (row.date > throughDate) fail('outside_history_range')
      if (row.endTime === undefined || row.endTime === null || row.endTime === '') fail('unfinished_clock_row')
      const start = minuteOfDay(row.startTime), end = minuteOfDay(row.endTime)
      const endDate = end < start ? zeitguruAddDays(row.date, 1) : row.date
      const started = wallInstant(row.date, start), stopped = wallInstant(endDate, end)
      if (started.date > throughDate || stopped.date > throughDate) fail('outside_history_range')
      const elapsed = end - start + (end < start ? 1440 : 0)
      const breakMinutes = row.breakMinutes ?? 0
      if (!Number.isSafeInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 1440) fail('invalid_history_row')
      const paidBreak = optionalBoolean(row.isPaidBreak) === true, autoClockOut = optionalBoolean(row.isAutoClockOut) === true, approved = optionalBoolean(row.isAccepted)
      // Mirrors the public V2 client's I3: wall-clock overnight wrap; paid breaks are not deducted.
      const workedMinutes = Math.max(0, elapsed - (paidBreak ? 0 : breakMinutes))
      const prefix = zeitguruCreditPrefix(row.id), rawCredit = credits[row.date]?.[prefix] ?? null
      const attributed = creditForRow(row, rawCredit, (prefixes.get(`${row.date}/${prefix}`) ?? 0) > 1, workedMinutes, approved)
      if (elapsed !== (stopped.instant - started.instant) / 60_000) attributed.warnings.push('wall_clock_duration_differs_from_elapsed')
      if (breakMinutes > elapsed) attributed.warnings.push('break_exceeds_shift_duration')
      if (autoClockOut) attributed.warnings.push('automatic_clock_out')
      if (approved !== true) attributed.warnings.push(approved === false ? 'not_approved' : 'approval_unknown')
      attributed.warnings.forEach((warning) => { warnings.add(warning); review(row.date, warning) })
      const branchName = branchNames.get(row.branchId)
      mapped.push({
        sourceId: row.id, date: row.date, startedAt: new Date(started.instant).toISOString(), stoppedAt: new Date(stopped.instant).toISOString(),
        breakMinutes, workedMinutes, creditedMinutes: attributed.creditedMinutes, approved, autoClockOut, paidBreak,
        ...(branchName ? { branchName } : {}), details: { rawRow: structuredClone(row), rawCredit: structuredClone(rawCredit), warnings: attributed.warnings },
      })
    } catch (error) {
      if (!(error instanceof ZeitguruClientError)) throw error
      skippedCount++; reasons.add(error.code); review(row.date, error.code)
    }
  }
  for (const [date, groups] of Object.entries(credits)) for (const prefix of Object.keys(groups)) {
    if (!prefixes.has(`${date}/${prefix}`)) { warnings.add('unattributed_credit_data'); review(date, 'unattributed_credit_data') }
  }
  return { rows: mapped.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sourceId.localeCompare(b.sourceId)), skipped: { count: skippedCount, reasons: [...reasons].sort() }, warnings: [...warnings].sort(), reviewDays: [...reviewDays.values()].sort((a, b) => a.date.localeCompare(b.date) || a.reason.localeCompare(b.reason)) }
}

/** Read-only, complete-result import source. Limits throw; no partial history is presented as complete. */
export async function readZeitguruHistory(
  client: HistoryClient, tokens: ZeitguruTokens, binding: ZeitguruBinding, throughDate: string,
  progress?: (value: ZeitguruHistoryProgress) => void | Promise<void>,
): Promise<ZeitguruHistoryResult> {
  validDate(throughDate)
  const snapshot = await client.readSnapshot(tokens, binding)
  if (snapshot.binding.tenantId !== binding.tenantId || snapshot.binding.userId !== binding.userId || snapshot.binding.accountId !== binding.accountId || snapshot.binding.role !== binding.role) fail('identity_mismatch')
  if (snapshot.rosterSettings.timezone !== 'Europe/Berlin') fail('unsupported_timezone')
  if (throughDate >= zeitguruWallTime(snapshot.observedAt).date) fail('outside_history_range')
  const fromDate = await client.readOwnHistoryStart(tokens, binding, throughDate)
  const result: ZeitguruHistoryResult = { fromDate, toDate: throughDate, observedAt: snapshot.observedAt, rows: [], skipped: { count: 0, reasons: [] }, warnings: [], reviewDays: [] }
  if (fromDate === null) return result
  validDate(fromDate)
  if (fromDate > throughDate) fail('outside_history_range')
  const totalMonths = (Number(throughDate.slice(0, 4)) - Number(fromDate.slice(0, 4))) * 12 + Number(throughDate.slice(5, 7)) - Number(fromDate.slice(5, 7)) + 1
  if (totalMonths > maximumMonths) fail('history_limit_exceeded')
  const branchNames = new Map(snapshot.branches.filter((branch) => typeof branch.id === 'string' && typeof branch.name === 'string').map((branch) => [String(branch.id), String(branch.name)]))
  const seen = new Set<string>(), reasons = new Set<string>(), warnings = new Set<string>()
  let cursor = fromDate, completedMonths = 0
  while (cursor <= throughDate) {
    const nextMonth = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`)
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    const monthEnd = zeitguruAddDays(nextMonth.toISOString().slice(0, 10), -1), end = monthEnd < throughDate ? monthEnd : throughDate
    const rows = await client.readOwnHistoryRange(tokens, binding, cursor, end)
    for (const row of rows) {
      if (row.date < cursor || row.date > end) fail('outside_history_range')
      if (seen.has(row.id)) fail('duplicate_history_identity')
      seen.add(row.id)
    }
    if (seen.size > maximumRows) fail('history_limit_exceeded')
    const credits = await client.readOwnCreditRange(tokens, binding, cursor, end)
    const mapped = mapZeitguruHistoryRows(rows, credits, binding, throughDate, branchNames)
    result.rows.push(...mapped.rows); result.skipped.count += mapped.skipped.count
    result.reviewDays.push(...mapped.reviewDays)
    mapped.skipped.reasons.forEach((reason) => reasons.add(reason)); mapped.warnings.forEach((warning) => warnings.add(warning))
    completedMonths++
    if (progress) await progress({ completedMonths, totalMonths, rowsRead: seen.size })
    cursor = zeitguruAddDays(end, 1)
  }
  result.skipped.reasons = [...reasons].sort(); result.warnings = [...warnings].sort()
  result.rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sourceId.localeCompare(b.sourceId))
  return result
}
