import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type ZeitguruObject = Record<string, unknown>
export type ZeitguruAction = 'start_work' | 'start_break' | 'stop_break' | 'stop_work'
export interface ZeitguruBinding { tenantId: string; userId: string; accountId: string; role: string }
export interface ZeitguruClockRow extends ZeitguruObject {
  id: string; userId: string; branchId: string; date: string; startTime: string;
  endTime?: string; breakMinutes: number; breakActivities?: { time: string; type: 'start' | 'end' }[];
  isAccepted?: boolean; isAutoClockOut?: boolean;
}
/** Server-only snapshot. Never expose provider profiles, configuration or tokens in a public DTO. */
export interface ZeitguruSnapshot {
  binding: ZeitguruBinding; tenant: ZeitguruObject; profile: ZeitguruObject;
  clockSettings: ZeitguruObject; rosterSettings: ZeitguruObject; branches: ZeitguruObject[];
  clockings: ZeitguruClockRow[]; credits: Record<string, ZeitguruObject>;
  observedAt: string; fromDate: string; toDate: string; etags: Record<string, string>;
}
export class ZeitguruProtocolError extends Error {
  readonly code: string
  readonly status = 409
  constructor(code: string) { super('Zeitguru needs review before this clock action can be mirrored.'); this.name = 'ZeitguruProtocolError'; this.code = code }
}
const reject = (code: string): never => { throw new ZeitguruProtocolError(code) }
export function zeitguruRecord(value: unknown): ZeitguruObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid_provider_data')
  return value as ZeitguruObject
}
export function zeitguruIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return reject('invalid_provider_identity')
  return value
}
export function zeitguruCanonical(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(ordered)
    const object = zeitguruRecord(item)
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, ordered(object[key])]))
  }
  return JSON.stringify(ordered(value))
}
export const zeitguruFingerprint = (value: unknown) => createHash('sha256').update(zeitguruCanonical(value)).digest('hex')
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const dayNumber = (date: string) => {
  if (!datePattern.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return reject('invalid_provider_time')
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000
}
export const zeitguruAddDays = (date: string, days: number) => new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10)
const timeMinutes = (time: unknown): number => {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return reject('invalid_provider_time')
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}
export function zeitguruWallTime(instant: string | number, timezone = 'Europe/Berlin') {
  const timestamp = typeof instant === 'number' ? instant : Date.parse(instant)
  if (!Number.isFinite(timestamp) || timezone !== 'Europe/Berlin') return reject('unsupported_timezone')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}
export function wallInstant(date: string, time: string) {
  const nominal = dayNumber(date) * 86_400_000 + timeMinutes(time) * 60_000
  const matches = [60, 120].map((offset) => nominal - offset * 60_000).filter((instant) => {
    const wall = zeitguruWallTime(instant); return wall.date === date && wall.time === time
  })
  if (matches.length !== 1) return reject('ambiguous_daylight_saving_time')
  return matches[0]
}
function booleanSetting(settings: ZeitguruObject, name: string) {
  if (settings[name] === undefined || settings[name] === null) return false
  if (typeof settings[name] !== 'boolean') return reject('unsupported_settings')
  return settings[name] as boolean
}
const clockRelevant = ['allowUserTimClockInBrowser', 'breaksNeedToBeClocked', 'applyAtLeastPlannedBreakTime', 'clockingsAreAutoApprovedV2', 'capEarlyClockinsV2', 'capEarlyClockinsAtTimeV2', 'capLateClockoutsAtTimeV2']
const rosterRelevant = ['breakRules', 'breakRulesOnlyOnExceedingMinutes', 'breakRulesIncludePrecidingBreakMinutes', 'breaksArePaid', 'timezone']
function noRelevantPersonalization(settings: ZeitguruObject, keys: string[]) {
  if (settings.specifications === undefined || settings.specifications === null) return
  const specifications = zeitguruRecord(settings.specifications)
  if (keys.some((key) => Object.hasOwn(specifications, key))) reject('unsupported_personalization')
}
function validateSettings(snapshot: ZeitguruSnapshot) {
  const { clockSettings: clock, rosterSettings: roster, profile, binding, tenant } = snapshot
  if (tenant.isV2 !== true || tenant.id !== binding.tenantId || profile.id !== binding.userId || profile.accountId !== binding.accountId || profile.role !== binding.role || binding.role !== 'employee') reject('identity_mismatch')
  if (profile.isDeleted || profile.isInactive || tenant.state === 'deactivated') reject('permission_denied')
  if (typeof profile.lastWorkDay === 'string' && profile.lastWorkDay < zeitguruWallTime(snapshot.observedAt).date) reject('permission_denied')
  if (roster.timezone !== 'Europe/Berlin') reject('unsupported_timezone')
  noRelevantPersonalization(clock, clockRelevant); noRelevantPersonalization(roster, rosterRelevant)
  if (!booleanSetting(clock, 'allowUserTimClockInBrowser')) reject('browser_clocking_disabled')
  if (booleanSetting(clock, 'capEarlyClockinsV2') || clock.capLateClockoutsAtTimeV2 || booleanSetting(roster, 'breaksArePaid')) reject('unsupported_settings')
  for (const key of ['breaksNeedToBeClocked', 'applyAtLeastPlannedBreakTime', 'clockingsAreAutoApprovedV2']) booleanSetting(clock, key)
  for (const key of ['breakRulesOnlyOnExceedingMinutes', 'breakRulesIncludePrecidingBreakMinutes']) booleanSetting(roster, key)
}
/** Matches the observed V2 rule precedence; unknown/inactive rules are rejected rather than guessed. */
export function zeitguruRuleBreakMinutes(roster: ZeitguruObject, elapsedMinutes: number): number {
  if (!Number.isInteger(elapsedMinutes) || elapsedMinutes < 0 || elapsedMinutes >= 1440) return reject('invalid_provider_time')
  const rules = roster.breakRules ?? []
  if (!Array.isArray(rules)) return reject('unsupported_break_rules')
  const parsed = rules.map((value) => {
    const rule = zeitguruRecord(value)
    if (Object.keys(rule).some((key) => !['isActive', 'workingHours', 'workingMinutes', 'breakMinutes'].includes(key)) || (rule.isActive !== undefined && rule.isActive !== true)) return reject('unsupported_break_rules')
    const hours = rule.workingHours ?? 0, minutes = rule.workingMinutes ?? 0, deduction = rule.breakMinutes
    if (![hours, minutes, deduction].every((number) => Number.isSafeInteger(number) && Number(number) >= 0) || Number(hours) >= 24 || Number(minutes) >= 60 || Number(deduction) >= 1440) return reject('unsupported_break_rules')
    return { threshold: Number(hours) * 60 + Number(minutes), deduction: Number(deduction) }
  })
  if (new Set(parsed.map((rule) => rule.threshold)).size !== parsed.length) return reject('unsupported_break_rules')
  const selected = parsed.sort((a, b) => b.threshold - a.threshold).find((rule) => elapsedMinutes >= rule.threshold)
  if (!selected) return 0
  if (!booleanSetting(roster, 'breakRulesOnlyOnExceedingMinutes')) return selected.deduction
  const preceding = booleanSetting(roster, 'breakRulesIncludePrecidingBreakMinutes') ? parsed.filter((rule) => rule.threshold < selected.threshold).reduce((total, rule) => total + rule.deduction, 0) : 0
  return Math.min(elapsedMinutes - selected.threshold, selected.deduction) + preceding
}
export function zeitguruCreditPrefix(id: string) { zeitguruIdentifier(id); return id.slice(0, 3) === '001' ? '00z' : id.slice(0, 3) }
function occupiedPrefixes(snapshot: ZeitguruSnapshot, date: string, exceptId?: string) {
  return new Set([
    ...snapshot.clockings.filter((row) => row.userId === snapshot.binding.userId && row.date === date && row.id !== exceptId).map((row) => zeitguruCreditPrefix(row.id)),
    ...Object.keys(snapshot.credits[date] ?? {}).filter((prefix) => prefix !== (exceptId ? zeitguruCreditPrefix(exceptId) : '')),
  ])
}
/** Allocate once, then persist this ID with the local shift before any delivery attempt. */
export function allocateZeitguruClockId(snapshot: ZeitguruSnapshot, date: string): string {
  const occupied = occupiedPrefixes(snapshot, date), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let attempt = 0; attempt < 1000; attempt++) {
    const prefix = [...randomBytes(3)].map((byte) => alphabet[byte % alphabet.length]).join('')
    const id = prefix + randomUUID().slice(3)
    if (!occupied.has(zeitguruCreditPrefix(id))) return id
  }
  return reject('clock_id_collision')
}
export interface ZeitguruTransitionInput {
  action: ZeitguruAction; occurredAt: string; expectedRow: ZeitguruClockRow | null;
  branchId?: string; remoteClockId?: string;
  /** Server-only: a durable, proven-unsent captured punch may be merged onto fresh provider state. */
  capturedPast?: boolean;
}
export interface ZeitguruMutationPlan {
  action: ZeitguruAction; occurredAt: string; tenantId: string; userId: string;
  expectedRow: ZeitguruClockRow | null; desiredRow: ZeitguruClockRow;
  patch: Record<string, unknown>; expectedCredit: unknown; creditPath: string;
  settingsFingerprint: string;
  evidence: { rowId: string; beforeFingerprint: string; afterFingerprint: string; creditFingerprint: string };
}
/** Pure planning only. The caller must atomically write the complete patch and reconcile unknown outcomes. */
export function planZeitguruTransition(snapshot: ZeitguruSnapshot, input: ZeitguruTransitionInput): ZeitguruMutationPlan {
  validateSettings(snapshot)
  if (typeof input.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt)) return reject('invalid_provider_time')
  const occurred = Date.parse(input.occurredAt), observed = Date.parse(snapshot.observedAt)
  if (!Number.isFinite(occurred) || !Number.isFinite(observed) || occurred > observed + 5000 || observed - occurred > (input.capturedPast ? 86400000 : 120_000)) return reject('stale_event')
  const wall = zeitguruWallTime(occurred), { binding } = snapshot
  if (wall.date < snapshot.fromDate || wall.date > snapshot.toDate || !Object.hasOwn(snapshot.credits, wall.date)) return reject('incomplete_snapshot')
  for (const id of [binding.tenantId, binding.userId, binding.accountId]) zeitguruIdentifier(id)
  if (!Array.isArray(snapshot.profile.branchIds) || !Array.isArray(snapshot.profile.jobPositionIds)) return reject('invalid_provider_data')
  if (snapshot.clockings.some((row) => row.userId !== binding.userId)) return reject('identity_mismatch')
  const active = snapshot.clockings.filter((row) => !row.endTime && !row.isAutoClockOut)
  if (active.length > 1) return reject('multiple_active_rows')
  const before = active[0] ?? null
  if (zeitguruCanonical(before) !== zeitguruCanonical(input.expectedRow)) return reject('remote_conflict')
  if ((input.action === 'start_work') !== (before === null)) return reject('invalid_clock_transition')
  const branchId = before?.branchId ?? input.branchId
  const branch = snapshot.branches.find((item) => item.id === branchId)
  if (!branch || !snapshot.profile.branchIds.includes(branchId) || branch.isClockingEnabled !== true || branch.isInactive || branch.isDisabled) return reject('location_not_allowed')
  let row: ZeitguruClockRow
  let elapsed = 0
  if (!before) {
    if (input.action !== 'start_work') return reject('invalid_clock_transition')
    const id = zeitguruIdentifier(input.remoteClockId), jobPositionId = zeitguruIdentifier(snapshot.profile.jobPositionIds[0])
    if (id.length < 3 || snapshot.clockings.some((existing) => existing.id === id) || occupiedPrefixes(snapshot, wall.date).has(zeitguruCreditPrefix(id))) return reject('clock_id_collision')
    row = { id, userId: binding.userId, branchId: zeitguruIdentifier(branchId), jobPositionId, date: wall.date, startTime: wall.time, breakMinutes: 0, logS: `B_${binding.userId}_${Math.floor(occurred / 1000)}`, branchId_date: `${branchId}_${wall.date}`, userId_date: `${binding.userId}_${wall.date}` }
  } else {
    zeitguruIdentifier(before.id)
    if (before.isPaidBreak || before.isDynamicClocking || before.branchId_date !== `${before.branchId}_${before.date}` || before.userId_date !== `${before.userId}_${before.date}`) return reject('unsupported_clock_row')
    if (!Object.hasOwn(snapshot.credits, before.date)) return reject('incomplete_snapshot')
    if (occupiedPrefixes(snapshot, before.date, before.id).has(zeitguruCreditPrefix(before.id))) return reject('clock_id_collision')
    elapsed = (dayNumber(wall.date) - dayNumber(before.date)) * 1440 + timeMinutes(wall.time) - timeMinutes(before.startTime)
    if (elapsed < 0 || elapsed >= 1440) return reject('invalid_provider_time')
    const start = wallInstant(before.date, before.startTime)
    if (Math.floor(occurred / 60_000) - start / 60_000 !== elapsed) return reject('ambiguous_daylight_saving_time')
    const activities = structuredClone(before.breakActivities ?? [])
    if (!Array.isArray(activities)) return reject('invalid_break_history')
    let previousMinute = timeMinutes(before.startTime), totalBreak = 0, breakStart = 0
    activities.forEach((event, index) => {
      if (!event || event.type !== (index % 2 ? 'end' : 'start')) return reject('invalid_break_history')
      let minute = timeMinutes(event.time)
      while (minute < previousMinute) minute += 1440
      if (minute - timeMinutes(before.startTime) > elapsed) return reject('invalid_break_history')
      if (index % 2) totalBreak += minute - breakStart; else breakStart = minute
      previousMinute = minute
    })
    const inBreak = activities.length % 2 === 1
    if (inBreak) totalBreak += timeMinutes(before.startTime) + elapsed - breakStart
    row = structuredClone(before)
    if (input.action === 'start_break' || input.action === 'stop_break') {
      if (!booleanSetting(snapshot.clockSettings, 'breaksNeedToBeClocked')) return reject('break_clocking_disabled')
      if ((input.action === 'start_break') === inBreak) return reject('invalid_clock_transition')
      activities.push({ time: wall.time, type: input.action === 'start_break' ? 'start' : 'end' })
      row.breakActivities = activities; row.breakMinutes = totalBreak; row.logB = 'B'
    } else if (input.action === 'stop_work') {
      const ruleMinutes = zeitguruRuleBreakMinutes(snapshot.rosterSettings, elapsed)
      row.endTime = wall.time
      row.breakMinutes = booleanSetting(snapshot.clockSettings, 'breaksNeedToBeClocked') ? totalBreak : ruleMinutes
      if (booleanSetting(snapshot.clockSettings, 'applyAtLeastPlannedBreakTime') && totalBreak < ruleMinutes) row.breakMinutes = ruleMinutes
      row.isAccepted = booleanSetting(snapshot.clockSettings, 'clockingsAreAutoApprovedV2')
      row.logE = `B_${binding.userId}_${Math.floor(occurred / 1000)}`
    } else return reject('invalid_clock_transition')
  }
  // Validate rule shape even when current recorded-break settings do not use it.
  zeitguruRuleBreakMinutes(snapshot.rosterSettings, elapsed)
  const creditPath = `credits/${binding.userId}_${row.date}/${zeitguruCreditPrefix(row.id)}/C`
  const existingCreditGroup = snapshot.credits[row.date]?.[zeitguruCreditPrefix(row.id)]
  const expectedCredit = existingCreditGroup === undefined || existingCreditGroup === null ? null : zeitguruRecord(existingCreditGroup).C ?? null
  const patch: Record<string, unknown> = { [`timeClockings/${row.id}`]: row }
  const netMinutes = row.endTime ? Math.max(0, elapsed - row.breakMinutes) : 0
  if (before || row.isAccepted) patch[creditPath] = row.isAccepted ? netMinutes : null
  return {
    action: input.action, occurredAt: new Date(occurred).toISOString(), tenantId: binding.tenantId, userId: binding.userId,
    expectedRow: structuredClone(before), desiredRow: row, patch, expectedCredit, creditPath,
    settingsFingerprint: zeitguruFingerprint({ clock: snapshot.clockSettings, roster: snapshot.rosterSettings, profile: snapshot.profile, branches: snapshot.branches, tenant: snapshot.tenant }),
    evidence: { rowId: row.id, beforeFingerprint: zeitguruFingerprint(before), afterFingerprint: zeitguruFingerprint(row), creditFingerprint: zeitguruFingerprint(Object.hasOwn(patch, creditPath) ? patch[creditPath] : expectedCredit) },
  }
}
