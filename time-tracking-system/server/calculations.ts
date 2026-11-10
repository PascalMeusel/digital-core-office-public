import type {
  AbsenceDay,
  ClockStatus,
  Holiday,
  PeriodTotals,
  RequestItem,
  TimeEntry,
  User,
  UserSummary,
} from '../shared/domain.ts'
import {
  clampDateRange,
  dateKeysBetween,
  endOfMonth,
  endOfWeek,
  isWeekend,
  startOfMonth,
  startOfWeek,
  startOfYear,
  toDateKey,
} from '../shared/dates.ts'
import { holidayByDate } from './holidays.ts'
import { termForDate } from '../shared/terms.ts'
import { balanceDeductionsForRange } from '../shared/balances.ts'
import { accountingEntryWorkedMinutes, periodTotalsWithAccounting, type ZeitguruAccountingContext, type ZeitguruAccountingContexts } from '../shared/timeAccounting.ts'
export { balanceDeductionsForRange } from '../shared/balances.ts'

function percentToFraction(percent: number | undefined) {
  if (!Number.isFinite(percent)) {
    return 1
  }

  return Math.min(1, Math.max(0, Number(percent) / 100))
}

export function entryWorkedMinutes(entry: TimeEntry, now = new Date()) {
  return accountingEntryWorkedMinutes(entry, now)
}

export function clockStatusForUser(entries: TimeEntry[], userId: string): ClockStatus {
  const openEntry = entries.find((entry) => entry.userId === userId && !entry.stoppedAt)
  if (!openEntry) {
    return 'off_work'
  }

  const openBreak = openEntry.breaks.some((segment) => !segment.stoppedAt)
  return openBreak ? 'on_break' : 'working'
}

export function openEntryForUser(entries: TimeEntry[], userId: string) {
  return entries.find((entry) => entry.userId === userId && !entry.stoppedAt)
}

function expectedMinutesForRange(
  user: User,
  startDate: string,
  endDate: string,
  holidays: Holiday[],
  absences: AbsenceDay[],
  entriesForClosedTodayCheck?: TimeEntry[],
) {
  const effectiveStartDate = user.trackingStartDate && user.trackingStartDate > startDate ? user.trackingStartDate : startDate
  if (effectiveStartDate > endDate) {
    return 0
  }

  const holidaysByDate = holidayByDate(holidays)
  const absenceDates = new Set(
    absences
      .filter((absence) => absence.userId === user.id && absence.date >= effectiveStartDate && absence.date <= endDate)
      .map((absence) => absence.date),
  )
  const closedEntryDates = entriesForClosedTodayCheck
    ? new Set(
        entriesForClosedTodayCheck
          .filter((entry) => entry.userId === user.id && entry.stoppedAt && entry.date >= effectiveStartDate && entry.date <= endDate)
          .map((entry) => entry.date),
      )
    : undefined
  const today = closedEntryDates ? toDateKey(new Date()) : undefined

  return dateKeysBetween(effectiveStartDate, endDate).reduce((total, date) => {
    if (isWeekend(date) || absenceDates.has(date)) {
      return total
    }
    if (date === today && !closedEntryDates?.has(date)) {
      return total
    }

    const dailyMinutes = termForDate(user, date).expectedWeeklyMinutes / 5
    const holiday = holidaysByDate.get(date)
    const expectedFraction = holiday ? 1 - percentToFraction(holiday.freePercent) : 1
    return total + dailyMinutes * expectedFraction
  }, 0)
}

function workedMinutesForRange(entries: TimeEntry[], userId: string, startDate: string, endDate: string) {
  return entries
    .filter((entry) => entry.userId === userId && entry.date >= startDate && entry.date <= endDate && entry.stoppedAt)
    .reduce((total, entry) => total + entryWorkedMinutes(entry), 0)
}

function totalsForRange(
  user: User,
  entries: TimeEntry[],
  absences: AbsenceDay[],
  holidays: Holiday[],
  startDate: string,
  endDate: string,
  skipTodayUntilClosed = false,
  requests: RequestItem[] = [],
  accounting?: ZeitguruAccountingContext,
): PeriodTotals {
  if (accounting) return periodTotalsWithAccounting(user, entries, absences, holidays, startDate, endDate, accounting, { skipTodayUntilClosed, requests })
  const workedMinutes = workedMinutesForRange(entries, user.id, startDate, endDate)
  const expectedMinutes = Math.round(
    expectedMinutesForRange(user, startDate, endDate, holidays, absences, skipTodayUntilClosed ? entries : undefined),
  )
  return {
    workedMinutes,
    expectedMinutes,
    plusMinusMinutes: workedMinutes - expectedMinutes - balanceDeductionsForRange(requests, user.id, startDate, endDate),
  }
}

export function vacationUsedDays(user: User, absences: AbsenceDay[], holidays: Holiday[], year: number) {
  const holidaysByDate = holidayByDate(holidays)
  const counted = new Set<string>()
  return absences.reduce((total, absence) => {
    if (absence.userId !== user.id || absence.type !== 'vacation' || !absence.date.startsWith(`${year}-`) || isWeekend(absence.date)) {
      return total
    }

    if (counted.has(absence.date)) return total
    counted.add(absence.date)
    const holiday = holidaysByDate.get(absence.date)
    return total + (holiday ? 1 - percentToFraction(holiday.freePercent) : 1)
  }, 0)
}

export function summaryForUser(
  user: User,
  entries: TimeEntry[],
  absences: AbsenceDay[],
  holidays: Holiday[],
  referenceDate = new Date(),
  requests: RequestItem[] = [],
  accounting?: ZeitguruAccountingContext,
): UserSummary {
  const [weekStart, weekEnd] = clampDateRange(startOfWeek(referenceDate), endOfWeek(referenceDate))
  const [monthStart, monthEnd] = clampDateRange(startOfMonth(referenceDate), endOfMonth(referenceDate))
  const yearStart = toDateKey(startOfYear(referenceDate))
  const yearEnd = toDateKey(referenceDate)
  const year = referenceDate.getFullYear()
  const usedDays = vacationUsedDays(user, absences, holidays, year)
  const yearlyVacationDays = termForDate(user, toDateKey(referenceDate)).yearlyVacationDays

  const week = totalsForRange(user, entries, absences, holidays, weekStart, weekEnd, false, requests, accounting)
  const month = totalsForRange(user, entries, absences, holidays, monthStart, monthEnd, false, requests, accounting)
  const yearTotals = accounting
    ? periodTotalsWithAccounting(user, entries, absences, holidays, yearStart, yearEnd, accounting, { skipTodayUntilClosed: true, requests, includePriorCarry: true })
    : totalsForRange(user, entries, absences, holidays, yearStart, yearEnd, true, requests)
  const yearWithAdjustment = {
    ...yearTotals,
    plusMinusMinutes: Math.round(yearTotals.plusMinusMinutes + user.balanceAdjustmentMinutes),
  }

  return {
    userId: user.id,
    balanceReviewRequired: Boolean(accounting && (!accounting.openingKnown || accounting.warnings.length)) || requests.some((request) => request.userId === user.id && request.status === 'approved' && (request.type === 'overtime_payout' || request.type === 'overtime_time_off') && request.balanceEffects === undefined),
    week,
    month,
    year: yearWithAdjustment,
    vacation: {
      yearlyDays: yearlyVacationDays,
      usedDays,
      remainingDays: yearlyVacationDays + user.vacationAdjustmentDays - usedDays,
    },
  }
}

export function summariesForUsers(
  users: User[],
  entries: TimeEntry[],
  absences: AbsenceDay[],
  holidays: Holiday[],
  requests: RequestItem[] = [],
  accounting: ZeitguruAccountingContexts = {},
) {
  return users.map((user) => summaryForUser(user, entries, absences, holidays, new Date(), requests, accounting[user.id]))
}


export function todayEntry(entries: TimeEntry[], userId: string) {
  const today = toDateKey(new Date())
  return entries.find((entry) => entry.userId === userId && entry.date === today && !entry.stoppedAt)
}
