import { ZeitguruClientError, type ZeitguruClient, type ZeitguruTokens } from './zeitguruClient.ts'
import { zeitguruAddDays, zeitguruIdentifier, zeitguruRecord, zeitguruWallTime, type ZeitguruBinding, type ZeitguruObject, type ZeitguruSnapshot } from './zeitguruProtocol.ts'
import type { ZeitguruAccountingContract, ZeitguruAccountingDay, ZeitguruAccountingReport, ZeitguruWeekDay } from '../shared/zeitguruAccounting.ts'

export interface ZeitguruAccountingSource {
  snapshot: ZeitguruSnapshot; contracts: ZeitguruObject[]; creditCorrections: ZeitguruObject[];
  absences: ZeitguruObject[]; absenceTypes: ZeitguruObject[]; holidays: ZeitguruObject[];
  credits: Record<string, ZeitguruObject>;
}
export interface ZeitguruAccountingRange { fromDate: string; toDate: string; forecastThroughDate?: string }
const weekDays: ZeitguruWeekDay[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']
const fail = (code: string): never => { throw new ZeitguruClientError(code, 409) }
function date(value: unknown): string {
  if (typeof value !== 'string') return fail('invalid_accounting_data')
  try { return zeitguruAddDays(value, 0) } catch { return fail('invalid_accounting_data') }
}
function number(value: unknown, fallback = 0, bound = 100_000_000): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > bound) return fail('invalid_accounting_data')
  return value
}
function nonnegative(value: unknown, fallback = 0, bound = 100_000_000) {
  const result = number(value, fallback, bound)
  if (result < 0) return fail('invalid_accounting_data')
  return result
}
function bool(value: unknown) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') return fail('unsupported_accounting_setting')
  return value
}
function record(value: unknown) {
  try { return zeitguruRecord(value) } catch { return fail('invalid_accounting_data') }
}
function id(value: unknown) {
  try { return zeitguruIdentifier(value) } catch { return fail('identity_mismatch') }
}
function dates(from: string, to: string, limit = 7_400) {
  date(from); date(to)
  if (from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= limit) return fail('accounting_limit_exceeded')
  const result: string[] = []
  for (let day = from; day <= to; day = zeitguruAddDays(day, 1)) result.push(day)
  return result
}
const weekday = (day: string) => weekDays[new Date(`${day}T00:00:00Z`).getUTCDay()]
const yearOf = (day: string) => day.slice(0, 4)

function normalizeContracts(raw: ZeitguruObject[], binding: ZeitguruBinding): ZeitguruAccountingContract[] {
  if (!raw.length || raw.length > 500) return fail('unsupported_contract_history')
  const ids = new Set<string>()
  const contracts = raw.map((row) => {
    const sourceId = id(row.id)
    if (row.userId !== binding.userId || ids.has(sourceId)) return fail('identity_mismatch')
    ids.add(sourceId)
    const validFrom = date(row.validFrom), validTo = date(row.validTo), quota = record(row.dailyQuota)
    if (validFrom > validTo || !['weekly', 'monthly'].includes(String(row.interval)) || Object.keys(quota).some((key) => !weekDays.includes(key as ZeitguruWeekDay))) return fail('unsupported_contract_history')
    const dailyQuota = Object.fromEntries(weekDays.map((key) => [key, quota[key] === undefined || quota[key] === null ? null : nonnegative(quota[key], 0, 1440)])) as Record<ZeitguruWeekDay, number | null>
    const intervalStartDay = number(row.intervalStartDay, 1, 28)
    if (!Number.isInteger(intervalStartDay) || intervalStartDay < 1) return fail('unsupported_monthly_interval')
    if (row.interval === 'monthly' && !Object.values(dailyQuota).some((value) => value !== null)) return fail('unsupported_contract_history')
    return {
      sourceId, validFrom, validTo, interval: row.interval as 'weekly' | 'monthly', totalHours: nonnegative(row.totalHours, 0, 10_000), dailyQuota, intervalStartDay,
      ...(row.mainBranchId ? { mainBranchId: id(row.mainBranchId) } : {}),
      applyQuotaOnHolidays: bool(row.applyQuotaOnHolidays), applyFixedValueOnHolidays: bool(row.applyFixedValueOnHolidays),
      minutesToApplyOnHolidays: nonnegative(row.minutesToApplyOnHolidays, 0, 1440),
      vacationDayCredit: row.vacationDayCredit == null ? null : nonnegative(row.vacationDayCredit, 0, 1440),
      illnessDayCredit: row.illnessDayCredit == null ? null : nonnegative(row.illnessDayCredit, 0, 1440),
    }
  }).sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  for (let index = 1; index < contracts.length; index++) if (contracts[index].validFrom <= contracts[index - 1].validTo) fail('ambiguous_contract_history')
  return contracts
}
function contractOn(contracts: ZeitguruAccountingContract[], day: string) {
  const contract = contracts.find((candidate) => candidate.validFrom <= day && candidate.validTo >= day)
  if (!contract) return fail('contract_coverage_missing')
  return contract
}
/** Public-client YS/Aue: zero is a workday marker for the monthly denominator,
 * but earns zero quota on that day; null excludes the day entirely. */
export function zeitguruExpectedMinutes(contract: ZeitguruAccountingContract, day: string): number | null {
  date(day)
  const assigned = contract.dailyQuota[weekday(day)]
  if (assigned === 0) return 0
  if (assigned === null) return null
  if (contract.interval === 'weekly') return assigned
  const month = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  if (Number(day.slice(8)) < contract.intervalStartDay) month.setUTCMonth(month.getUTCMonth() - 1)
  const monthEnd = new Date(month); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0)
  const count = monthEnd.getUTCDate()
  month.setUTCDate(contract.intervalStartDay)
  const beginning = month.toISOString().slice(0, 10)
  const workingDays = dates(beginning, zeitguruAddDays(beginning, count - 1), 32).filter((date) => contract.dailyQuota[weekday(date)] !== null).length
  if (!workingDays) return fail('unsupported_contract_history')
  return Math.round(contract.totalHours * 60 / workingDays * 1000) / 1000
}
/** Public-client mi0/pi0: C/T/S base precedence, fixed-hour and percentage
 * supplements rounded independently, then R. Unknown components fail closed. */
export function zeitguruDailySourceCredits(groups: ZeitguruObject): number {
  let total = 0
  for (const value of Object.values(groups)) {
    const group = record(value)
    if (Object.keys(group).some((key) => !['C', 'T', 'S', 'AA', 'AP', 'R'].includes(key))) return fail('unsupported_credit_components')
    const c = nonnegative(group.C, 0, 1440), t = nonnegative(group.T, 0, 1440), s = nonnegative(group.S, 0, 1440)
    const base = group.T === 0 ? 0 : c || t || s || 0
    const fixed = number(group.AA, 0, 10_000), percentage = number(group.AP, 0, 10_000), adjustment = number(group.R, 0, 1_000_000)
    total += base + Math.round(fixed * 60) + Math.round(base * percentage / 100) + adjustment
  }
  return number(total)
}
function holidayOn(holidays: ZeitguruObject[], day: string, branchId?: string) {
  const candidates = holidays.filter((holiday) => holiday.date === day)
  const global = candidates.filter((holiday) => !holiday.branchId), branch = branchId ? candidates.filter((holiday) => holiday.branchId === branchId) : []
  if (global.length > 1 || branch.length > 1) return fail('ambiguous_holiday_configuration')
  return global[0] ?? branch[0]
}
function halfAbsence(absence: ZeitguruObject, day: string) {
  return bool(absence.startsHalfDay) && day === absence.startDate || bool(absence.endsHalfDay) && day === absence.endDate
}
function absenceCredit(day: string, quota: number, absence: ZeitguruObject, type: ZeitguruObject, contract: ZeitguruAccountingContract, shifts: number, holiday: ZeitguruObject | undefined, roster: ZeitguruObject) {
  const countHoliday = bool(roster.holidaysInAbsenceCountAsHolidays), zeroAsDay = bool(roster.countDailyQuotaZeroAsWorkDay)
  const monthly = contract.interval === 'monthly', weekly = !monthly, holidayEnabled = contract.applyQuotaOnHolidays || contract.applyFixedValueOnHolidays
  const fixedVacation = bool(roster.canSetFixedVacationCreditForWeeklyContracts) && weekly && Boolean(contract.vacationDayCredit)
  const fixedIllness = bool(roster.canSetFixedIllnessCreditForWeeklyContracts) && weekly && Boolean(contract.illnessDayCredit)
  const onlyOnShift = bool(type.creditOnlyOnDaysWithShift), earning = String(absence.earning), code = String(absence.typeCode)
  const isWorkDay = Boolean(contract.dailyQuota[weekday(day)]) || zeroAsDay && contract.dailyQuota[weekday(day)] === 0
  if ((!quota && earning !== 'asPlaned' && !(earning === 'meanQuota' && zeroAsDay && isWorkDay) && !(monthly && code === 'vacation') && !(monthly && code === 'illness' && contract.illnessDayCredit) && !onlyOnShift)
    || (onlyOnShift && !shifts) || (holiday && !bool(holiday.isHalfHoliday) && countHoliday && holidayEnabled)) return 0
  const assigned = Object.values(contract.dailyQuota).filter((value): value is number => value !== null)
  let credit: number
  switch (earning) {
    case 'none': credit = 0; break
    case 'dailyQuota': credit = quota; break
    case 'meanQuota': credit = weekly ? assigned.reduce((sum, value) => sum + value, 0) / assigned.length : quota; break
    case 'asPlaned': credit = shifts; break
    default: return fail('unsupported_absence_earning')
  }
  const fixed = nonnegative(type.creditFixedValue, 0, 1440)
  if (fixed) credit = fixed
  if (code === 'vacation' && (monthly || fixedVacation) && earning !== 'asPlaned' && earning !== 'none') credit = contract.dailyQuota[weekday(day)] !== null ? contract.vacationDayCredit || 0 : 0
  if (code === 'illness' && (monthly || fixedIllness) && contract.illnessDayCredit && earning !== 'none') credit = contract.dailyQuota[weekday(day)] !== null ? contract.illnessDayCredit : 0
  const half = halfAbsence(absence, day) || Boolean(holiday && bool(holiday.isHalfHoliday) && countHoliday && holidayEnabled)
  return half && earning !== 'asPlaned' ? Math.floor(credit / 2) : credit
}
function holidayCredit(holiday: ZeitguruObject, contract: ZeitguruAccountingContract, quota: number | null, roster: ZeitguruObject, absence?: ZeitguruObject) {
  const enabled = contract.applyQuotaOnHolidays || contract.applyFixedValueOnHolidays
  const allowed = !absence || absence.earning === 'asPlaned' || bool(roster.holidaysInAbsenceCountAsHolidays) && enabled
  const value = contract.applyQuotaOnHolidays ? quota : contract.applyFixedValueOnHolidays && quota !== null ? contract.minutesToApplyOnHolidays : 0
  const credit = enabled && allowed && value ? value : 0
  return bool(holiday.isHalfHoliday) ? Math.round(credit / 2) : credit
}

/** Reproduces the inspected client's nP1/pC hour-account math. Missing opening
 * correction is explicitly a period delta, never a verified lifetime balance. */
export function calculateZeitguruAccounting(source: ZeitguruAccountingSource, range: ZeitguruAccountingRange): ZeitguruAccountingReport {
  const { snapshot } = source, { binding } = snapshot
  if (snapshot.tenant.id !== binding.tenantId || snapshot.profile.id !== binding.userId || snapshot.profile.accountId !== binding.accountId || snapshot.profile.role !== binding.role || snapshot.tenant.isV2 !== true) fail('identity_mismatch')
  if (snapshot.rosterSettings.timezone !== 'Europe/Berlin') fail('unsupported_timezone')
  const through = date(range.toDate), requestedFrom = date(range.fromDate), today = zeitguruWallTime(snapshot.observedAt).date
  if (through >= today || requestedFrom > through) fail('outside_accounting_range')
  const contracts = normalizeContracts(source.contracts, binding), roster = snapshot.rosterSettings
  for (const key of ['holidaysInAbsenceCountAsHolidays', 'canSetFixedVacationCreditForWeeklyContracts', 'canSetFixedIllnessCreditForWeeklyContracts', 'countDailyQuotaZeroAsWorkDay']) bool(roster[key])
  const corrections = source.creditCorrections.map((row) => {
    id(row.id); if (row.userId !== binding.userId) fail('identity_mismatch')
    date(row.date); number(row.minutes)
    if (!['initial', 'manual'].includes(String(row.type))) fail('unsupported_credit_correction')
    return row
  })
  const initial = corrections.filter((row) => row.type === 'initial')
  if (initial.length > 1) fail('ambiguous_opening_balance')
  const from = initial.length ? date(initial[0].date) : requestedFrom
  if (from > through) fail('opening_balance_after_history')
  const opening = { date: from, minutes: initial.length ? number(initial[0].minutes) : 0 }, openingKnown = initial.length === 1
  const warnings = new Set<string>(openingKnown ? [] : ['source_opening_balance_not_configured'])
  const dayList = dates(from, through), forecastTo = date(range.forecastThroughDate ?? zeitguruAddDays(through, 400))
  const forecastDates = forecastTo > through ? dates(zeitguruAddDays(through, 1), forecastTo, 730) : []
  if (forecastTo < through) fail('outside_accounting_range')
  const typeMap = new Map(source.absenceTypes.map((type) => {
    const typeId = id(type.id); bool(type.creditOnlyOnDaysWithShift); nonnegative(type.creditFixedValue, 0, 1440)
    return [typeId, type] as const
  }))
  if (typeMap.size !== source.absenceTypes.length) fail('ambiguous_absence_configuration')
  const absences = source.absences.filter((row) => {
    id(row.id); if (row.userId !== binding.userId) fail('identity_mismatch')
    if (!['active', 'requested', 'rejected'].includes(String(row.status))) fail('unsupported_absence_status')
    if (date(row.startDate) > date(row.endDate)) fail('invalid_accounting_data')
    return row.status === 'active' && String(row.startDate) <= forecastTo && String(row.endDate) >= from
  })
  for (const absence of absences) {
    if (!typeMap.has(id(absence.typeId)) || !['none', 'dailyQuota', 'meanQuota', 'asPlaned'].includes(String(absence.earning)) || typeof absence.typeCode !== 'string') fail('unsupported_absence_earning')
    bool(absence.startsHalfDay); bool(absence.endsHalfDay)
  }
  for (const holiday of source.holidays) { id(holiday.id); date(holiday.date); bool(holiday.isHalfHoliday); if (holiday.branchId) id(holiday.branchId) }
  const sourceHolidayYears = new Set(source.holidays.map((holiday) => yearOf(String(holiday.date))))
  const missingHolidayYears = new Set<string>(), days: ZeitguruAccountingDay[] = []
  let running = opening.minutes
  const employed = (day: string) => !snapshot.profile.isDeleted && (!snapshot.profile.lastWorkDay || day <= String(snapshot.profile.lastWorkDay))
  for (const day of dayList) {
    const contract = contractOn(contracts, day), active = employed(day), quota = active ? zeitguruExpectedMinutes(contract, day) : 0
    const matches = absences.filter((absence) => String(absence.startDate) <= day && String(absence.endDate) >= day)
    if (matches.length > 1) fail('ambiguous_absence_history')
    const absence = matches[0], type = absence ? typeMap.get(String(absence.typeId))! : undefined
    const holiday = holidayOn(source.holidays, day, contract.mainBranchId)
    if ((contract.applyQuotaOnHolidays || contract.applyFixedValueOnHolidays) && !sourceHolidayYears.has(yearOf(day))) missingHolidayYears.add(yearOf(day))
    const sourceCredit = zeitguruDailySourceCredits(source.credits[day] ?? {})
    const absenceMinutes = absence && active ? absenceCredit(day, quota || 0, absence, type!, contract, sourceCredit, holiday, roster) : 0
    const holidayMinutes = holiday && active ? holidayCredit(holiday, contract, quota, roster, absence) : 0
    const manual = corrections.filter((row) => row.type === 'manual' && row.date === day)
    if (manual.length > 1) fail('ambiguous_credit_correction')
    const correctionMinutes = manual.length ? number(manual[0].minutes) : 0
    const workedMinutes = absence && !halfAbsence(absence, day) ? 0 : sourceCredit
    const exactCredit = workedMinutes + absenceMinutes + holidayMinutes + correctionMinutes, expectedMinutes = quota || 0
    const exactDeltaMinutes = exactCredit - expectedMinutes
    running += exactDeltaMinutes
    days.push({ date: day, expectedMinutes, workedMinutes, absenceMinutes, holidayMinutes, correctionMinutes,
      creditedMinutes: exactCredit, balanceMinutes: Math.round(running), exactDeltaMinutes,
      ...(absence ? { absence: { typeCode: String(absence.typeCode), typeName: typeof type?.name === 'string' ? type.name : String(absence.typeCode), startsHalfDay: bool(absence.startsHalfDay), endsHalfDay: bool(absence.endsHalfDay) } } : {}),
      details: { sourceCreditMinutes: sourceCredit, displayCreditedMinutes: Math.round(exactCredit), exactBalanceMinutes: running, contractId: contract.sourceId, absenceId: absence?.id ?? null, holidayId: holiday?.id ?? null, correctionId: manual[0]?.id ?? null },
    })
  }
  const forecast = forecastDates.map((day) => {
    if (!employed(day)) return { date: day, expectedMinutes: 0, quotaMinutes: 0, absenceMinutes: 0, holidayMinutes: 0 }
    const contract = contractOn(contracts, day), quota = zeitguruExpectedMinutes(contract, day), matches = absences.filter((absence) => String(absence.startDate) <= day && String(absence.endDate) >= day)
    if (matches.length > 1) fail('ambiguous_absence_history')
    const absence = matches[0], type = absence ? typeMap.get(String(absence.typeId))! : undefined, holiday = holidayOn(source.holidays, day, contract.mainBranchId)
    // Planned-shift/fixed-on-shift absence credits depend on future assignments that
    // this own clock-history reader cannot establish. Do not invent a work target.
    if (absence && (absence.earning === 'asPlaned' || bool(type?.creditOnlyOnDaysWithShift))) fail('unsupported_forecast_earning')
    const absenceMinutes = absence ? absenceCredit(day, quota || 0, absence, type!, contract, 0, holiday, roster) : 0
    const holidayMinutes = holiday ? holidayCredit(holiday, contract, quota, roster, absence) : 0
    if ((contract.applyQuotaOnHolidays || contract.applyFixedValueOnHolidays) && !sourceHolidayYears.has(yearOf(day))) missingHolidayYears.add(yearOf(day))
    return { date: day, expectedMinutes: Math.max(0, (quota || 0) - absenceMinutes - holidayMinutes), quotaMinutes: quota || 0, absenceMinutes, holidayMinutes }
  })
  if (missingHolidayYears.size) warnings.add('source_holiday_configuration_missing_for_years')
  return { fromDate: from, toDate: through, observedAt: snapshot.observedAt, opening, openingKnown, balanceBasis: openingKnown ? 'source_opening' : 'period_delta',
    openingBalanceMinutes: opening.minutes, closingBalanceMinutes: Math.round(running), days, contracts, forecast, warnings: [...warnings].sort(),
    details: { source: structuredClone(source), exactClosingBalanceMinutes: running, missingHolidayYears: [...missingHolidayYears].sort() },
  }
}

/** All network operations are authenticated own-account reads. The provider has no mutation path. */
export async function readZeitguruAccounting(client: ZeitguruClient, tokens: ZeitguruTokens, binding: ZeitguruBinding, range: ZeitguruAccountingRange): Promise<ZeitguruAccountingReport> {
  const snapshot = await client.readSnapshot(tokens, binding)
  const [contracts, creditCorrections, absences] = await Promise.all([
    client.readOwnContracts(tokens, binding), client.readOwnCreditCorrections(tokens, binding), client.readOwnAbsences(tokens, binding),
  ])
  const initial = creditCorrections.filter((row) => row.type === 'initial')
  if (initial.length > 1) fail('ambiguous_opening_balance')
  const from = initial.length ? date(initial[0].date) : date(range.fromDate), through = date(range.toDate), forecastTo = date(range.forecastThroughDate ?? zeitguruAddDays(through, 400))
  dates(from, through)
  if (forecastTo > through) dates(zeitguruAddDays(through, 1), forecastTo, 730)
  const typeIds = [...new Set(absences.filter((row) => row.status === 'active' && String(row.startDate) <= forecastTo && String(row.endDate) >= from).map((row) => id(row.typeId)))]
  const [absenceTypes, holidays] = await Promise.all([
    client.readAccountingAbsenceTypes(tokens, binding, typeIds),
    client.readAccountingHolidays(tokens, binding, from, forecastTo, [...new Set(contracts.filter((row) => row.mainBranchId).map((row) => id(row.mainBranchId)))]),
  ])
  const credits: Record<string, ZeitguruObject> = {}
  let sourceBytes = Buffer.byteLength(JSON.stringify({ snapshot, contracts, creditCorrections, absences, absenceTypes, holidays }))
  if (sourceBytes > 32 * 1024 * 1024) fail('accounting_limit_exceeded')
  let cursor = from, chunks = 0
  while (cursor <= through) {
    if (++chunks > 240) fail('accounting_limit_exceeded')
    const next = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1)
    const monthEnd = zeitguruAddDays(next.toISOString().slice(0, 10), -1), end = monthEnd < through ? monthEnd : through
    const chunk = await client.readOwnCreditRange(tokens, binding, cursor, end)
    sourceBytes += Buffer.byteLength(JSON.stringify(chunk))
    if (sourceBytes > 32 * 1024 * 1024) fail('accounting_limit_exceeded')
    Object.assign(credits, chunk)
    cursor = zeitguruAddDays(end, 1)
  }
  return calculateZeitguruAccounting({ snapshot, contracts, creditCorrections, absences, absenceTypes, holidays, credits }, range)
}
