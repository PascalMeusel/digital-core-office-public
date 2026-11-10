import type { AbsenceDay, Holiday, PeriodTotals, RequestItem, TimeEntry, User } from './domain.ts'
import type { ZeitguruAccountingDay, ZeitguruAccountingForecastDay } from './zeitguruAccounting.ts'
import { dateKeysBetween, isWeekend, toDateKey } from './dates.ts'
import { termForDate } from './terms.ts'
import { balanceDeductionsForRange } from './balances.ts'

export type ZeitguruAccountingPublicDay = Omit<ZeitguruAccountingDay, 'details'> & {
  actualWorkedMinutes?: number; actualBreakMinutes?: number;
  importClassification?: { type: 'vacation'|'holiday'|'illness'; basis: 'company_8h_zero_break'|'company_calendar'|'source_comment'|'source_absence'; originalWorkedMinutes: number; version: 1 };
  localAbsenceApplied?: boolean;
  approvedAutomaticClockOut?: boolean;
}
export interface ZeitguruAccountingContext {
  initialImportReconstruction?: ImportReconstruction;
  batchId: string; fromDate: string; toDate: string; observedAt: string;
  openingKnown: boolean; balanceBasis: 'source_opening' | 'period_delta';
  openingBalanceMinutes: number; closingBalanceMinutes: number;
  days: ZeitguruAccountingPublicDay[]; forecast: ZeitguruAccountingForecastDay[];
  warnings: { date: string; code: string }[];
}
export interface ImportReconstructionDay {
  date: string; originalStart?: string; originalEnd?: string; originalMinutes: number;
  proposedStart: string; proposedEnd: string; proposedBreakMinutes: number; proposedMinutes: number;
  reasons: Array<'ten_hours' | 'eleven_hours' | 'receives_time'>;
  status: 'proposal' | 'applied' | 'changed';
}
export interface ImportReconstruction {
  version: 1; throughDate: string; days: ImportReconstructionDay[];
  transfers: Array<{ fromDate: string; toDate: string; minutes: number }>;
  unallocated: Array<{ date: string; minutes: number }>;
}
export type ZeitguruAccountingContexts = Record<string, ZeitguruAccountingContext | undefined>

/** Imported wall-clock/paid-break evidence is not interchangeable with elapsed UTC time. */
export function accountingEntryWorkedMinutes(entry: TimeEntry, now = new Date()) {
  if (entry.source === 'zeitguru' && entry.zeitguru && Number.isFinite(entry.zeitguru.workedMinutes)) return entry.zeitguru.workedMinutes
  const stop = entry.stoppedAt ? new Date(entry.stoppedAt) : now
  const elapsed = Math.max(0, (stop.getTime() - new Date(entry.startedAt).getTime()) / 60_000)
  const breaks = entry.breaks.reduce((total, segment) => total + Math.max(0,
    ((segment.stoppedAt ? new Date(segment.stoppedAt) : now).getTime() - new Date(segment.startedAt).getTime()) / 60_000), 0)
  return Math.max(0, Math.round(elapsed - breaks - (entry.manualBreakMinutes ?? 0)))
}

const cache = new WeakMap<ZeitguruAccountingContext, { days: Map<string, ZeitguruAccountingPublicDay>; forecast: Map<string, number> }>()
function indexes(context: ZeitguruAccountingContext) {
  let value = cache.get(context)
  if (!value) { value = { days: new Map(context.days.map(day => [day.date, day])), forecast: new Map(context.forecast.map(day => [day.date, day.expectedMinutes])) }; cache.set(context, value) }
  return value
}
export function accountingDay(context: ZeitguruAccountingContext | undefined, date: string) { return context ? indexes(context).days.get(date) : undefined }
export function accountingExpectedMinutes(context: ZeitguruAccountingContext | undefined, date: string) {
  return context ? indexes(context).days.get(date)?.expectedMinutes ?? indexes(context).forecast.get(date) : undefined
}
/** A later explicit DCO term takes precedence over the imported forward schedule. */
export function accountingExpectedMinutesForUser(user: User, context: ZeitguruAccountingContext | undefined, date: string) {
  if (context && date > context.toDate) {
    const term = termForDate(user, date)
    if (term.effectiveFrom <= date && (term.createdAt > context.observedAt || (term.effectiveFrom > context.toDate && term.expectedWeeklyMinutes > 0))) return undefined
  }
  return accountingExpectedMinutes(context, date)
}

/** Exact prior-period carry; the initial anchor is applied once, never once per calendar year. */
export function accountingCarryBefore(context: ZeitguruAccountingContext | undefined, date: string) {
  if (!context?.openingKnown || date <= context.fromDate) return 0
  return context.openingBalanceMinutes + context.days.filter(day => day.date < date).reduce((total, day) => total + day.exactDeltaMinutes, 0)
}

/** Shared server/browser accounting. Source days replace their native-day subtotal, not the native records. */
export function periodTotalsWithAccounting(
  user: User, entries: TimeEntry[], absences: AbsenceDay[], holidays: Holiday[], startDate: string, endDate: string,
  accounting?: ZeitguruAccountingContext,
  options: { skipTodayUntilClosed?: boolean; now?: Date; requests?: RequestItem[]; includePriorCarry?: boolean } = {},
): PeriodTotals {
  const today = toDateKey(options.now ?? new Date()), ownEntries = entries.filter(entry => entry.userId === user.id && entry.stoppedAt)
  const days = new Map<string, TimeEntry[]>()
  for (const entry of ownEntries) days.set(entry.date, [...(days.get(entry.date) ?? []), entry])
  const absenceDates = new Set(absences.filter(absence => absence.userId === user.id).map(absence => absence.date))
  const holidayMap = new Map(holidays.map(holiday => [holiday.date, holiday]))
  let workedMinutes = 0, expectedMinutes = 0, plusMinusMinutes = 0
  for (const date of dateKeysBetween(startDate, endDate)) {
    const sourceDay = accountingDay(accounting, date)
    if (sourceDay) {
      workedMinutes += (days.get(date) ?? []).reduce((sum, entry) => sum + accountingEntryWorkedMinutes(entry), 0)
      expectedMinutes += sourceDay.expectedMinutes; plusMinusMinutes += sourceDay.exactDeltaMinutes
      continue
    }
    const dayEntries = days.get(date) ?? [], worked = dayEntries.reduce((sum, entry) => sum + accountingEntryWorkedMinutes(entry), 0)
    const sourceTarget = accountingExpectedMinutesForUser(user, accounting, date)
    let expected = sourceTarget ?? ((date >= user.trackingStartDate && !isWeekend(date)) ? termForDate(user, date).expectedWeeklyMinutes / 5 : 0)
    if (absenceDates.has(date) || (options.skipTodayUntilClosed && date === today && !dayEntries.length)) expected = 0
    else if (sourceTarget === undefined) expected *= 1 - Math.min(1, Math.max(0, (holidayMap.get(date)?.freePercent ?? 0) / 100))
    workedMinutes += worked; expectedMinutes += expected; plusMinusMinutes += worked - expected
  }
  // Source anchor is a dated correction; include it exactly in its containing period.
  if (accounting?.openingKnown && startDate <= accounting.fromDate && endDate >= accounting.fromDate) plusMinusMinutes += accounting.openingBalanceMinutes
  if (options.includePriorCarry) plusMinusMinutes += accountingCarryBefore(accounting, startDate)
  plusMinusMinutes -= balanceDeductionsForRange(options.requests ?? [], user.id, startDate, endDate)
  return { workedMinutes: Math.round(workedMinutes), expectedMinutes: Math.round(expectedMinutes), plusMinusMinutes: Math.round(plusMinusMinutes) }
}
