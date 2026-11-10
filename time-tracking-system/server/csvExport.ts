import type { AbsenceDay, AbsenceType, Holiday, RequestItem, TimeEntry, User, WorkLocation } from '../shared/domain.ts'
import {
  clampDateRange,
  dateKeysBetween,
  endOfMonth,
  endOfWeek,
  endOfYear,
  isSensibleDateKey,
  isWeekend,
  parseDateKey,
  pad2,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from '../shared/dates.ts'
import { termForDate } from '../shared/terms.ts'
import { balanceDeductionsForRange, entryWorkedMinutes } from './calculations.ts'
import type { Database } from './store.ts'
import { holidaysForYears, yearsForDateRange } from './holidays.ts'
import { accountingDay, periodTotalsWithAccounting, type ZeitguruAccountingContext } from '../shared/timeAccounting.ts'

export type TimeExportPeriod = 'day' | 'week' | 'month' | 'year' | 'all'
export type TimeExportLanguage = 'en' | 'de'

const headers = {
  en: [
    'Date',
    'Weekday',
    'Employee',
    'Email',
    'Period',
    'Expected hours',
    'Worked hours',
    'Break hours',
    'Overtime hours',
    'Start times',
    'Stop times',
    'Breaks',
    'Entry count',
    'Absence',
    'Holiday',
    'Free percent',
    'Work locations',
    'Sources',
    'Notes',
  ],
  de: [
    'Datum',
    'Wochentag',
    'Mitarbeiter',
    'E-Mail',
    'Zeitraum',
    'Sollstunden',
    'Iststunden',
    'Pausenstunden',
    'Überstunden',
    'Startzeiten',
    'Endzeiten',
    'Pausen',
    'Einträge',
    'Abwesenheit',
    'Feiertag',
    'Freier Anteil %',
    'Arbeitsorte',
    'Quellen',
    'Notizen',
  ],
} satisfies Record<TimeExportLanguage, string[]>

const absenceLabels: Record<TimeExportLanguage, Record<AbsenceType, string>> = {
  en: {
    vacation: 'Vacation',
    overtime_time_off: 'Overtime time off',
    sick_leave: 'Sick leave',
    child_sick_leave: 'Child sick leave',
  },
  de: {
    vacation: 'Urlaub',
    overtime_time_off: 'Überstunden Ausgleich',
    sick_leave: 'Krankmeldung',
    child_sick_leave: 'Kind krank',
  },
}

const workLocationLabels: Record<TimeExportLanguage, Record<WorkLocation, string>> = {
  en: {
    office: 'In office',
    homeoffice: 'In homeoffice',
    remote: 'Remote',
    customer: 'At customer site',
    business_trip: 'Business trip',
  },
  de: {
    office: 'Im Büro',
    homeoffice: 'Im Homeoffice',
    remote: 'Remote',
    customer: 'Beim Kunden',
    business_trip: 'Auf Dienstreise',
  },
}

function percentToFraction(percent: number | undefined) {
  if (!Number.isFinite(percent)) {
    return 1
  }

  return Math.min(1, Math.max(0, Number(percent) / 100))
}

function displayUserName(user: Pick<User, 'name' | 'role'>) {
  const trailingRole = user.role === 'employee' ? /\s+(Employee|Mitarbeiter)$/i : /\s+(Admin|Administrator)$/i
  const cleanedName = user.name.replace(trailingRole, '').trim()
  return cleanedName || user.name
}

function holidayDisplayName(holiday: Holiday | undefined) {
  if (!holiday) {
    return ''
  }

  return holiday.name
}

function localTime(value: string | undefined) {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function weekdayLabel(dateKey: string, language: TimeExportLanguage) {
  return parseDateKey(dateKey).toLocaleDateString(language === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long' })
}

function formatNumber(value: number, language: TimeExportLanguage) {
  const fixed = Number(value.toFixed(2))
  return language === 'de' ? String(fixed).replace('.', ',') : String(fixed)
}

function breakMinutesForEntry(entry: TimeEntry, now: Date) {
  const tracked = entry.breaks.reduce((total, segment) => {
    const stop = segment.stoppedAt ? new Date(segment.stoppedAt) : now
    return total + Math.max(0, Math.round((stop.getTime() - new Date(segment.startedAt).getTime()) / 60000))
  }, 0)

  return tracked + (entry.manualBreakMinutes ?? 0)
}

function breaksLabel(entry: TimeEntry, language: TimeExportLanguage) {
  const tracked = entry.breaks.map((segment) => {
    const start = localTime(segment.startedAt)
    const stop = segment.stoppedAt ? localTime(segment.stoppedAt) : language === 'de' ? 'offen' : 'open'
    return `${start}-${stop}`
  })

  if (entry.manualBreakMinutes) {
    tracked.push(`${language === 'de' ? 'manuell' : 'manual'} ${entry.manualBreakMinutes} min`)
  }

  return tracked.join(' | ')
}

function expectedMinutesForDate(
  user: User,
  date: string,
  absences: AbsenceDay[],
  holiday: Holiday | undefined,
) {
  if (user.trackingStartDate && date < user.trackingStartDate) {
    return 0
  }

  if (isWeekend(date) || absences.some((absence) => absence.userId === user.id && absence.date === date)) {
    return 0
  }

  const dailyMinutes = termForDate(user, date).expectedWeeklyMinutes / 5
  const expectedFraction = holiday ? 1 - percentToFraction(holiday.freePercent) : 1
  return Math.round(dailyMinutes * expectedFraction)
}

function rangeForPeriod(
  period: TimeExportPeriod,
  referenceDate: string,
  userId: string,
  entries: TimeEntry[],
  absences: AbsenceDay[],
  requests: RequestItem[],
  accounting?: ZeitguruAccountingContext,
) {
  if (period === 'day') {
    return [referenceDate, referenceDate] as const
  }

  const reference = parseDateKey(referenceDate)
  if (period === 'week') {
    return clampDateRange(startOfWeek(reference), endOfWeek(reference))
  }
  if (period === 'month') {
    return clampDateRange(startOfMonth(reference), endOfMonth(reference))
  }
  if (period === 'year') {
    return clampDateRange(startOfYear(reference), endOfYear(reference))
  }

  const userDates = [
    ...(accounting ? [accounting.fromDate, accounting.toDate] : []),
    ...entries.filter((entry) => entry.userId === userId).map((entry) => entry.date),
    ...absences.filter((absence) => absence.userId === userId).map((absence) => absence.date),
    ...requests.filter((request) => request.userId === userId && request.status === 'approved').flatMap((request) => request.balanceEffects?.map((effect) => effect.date) ?? []),
  ]
    .filter((date) => isSensibleDateKey(date))
    .sort()

  return [userDates[0] ?? referenceDate, userDates.at(-1) ?? referenceDate] as const
}

function csvCell(value: string | number) {
  const text = String(value)
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvLine(values: Array<string | number>) {
  return values.map(csvCell).join(';')
}

function safeFilenamePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

export function buildTimeCsvExport(
  database: Database,
  user: User,
  period: TimeExportPeriod,
  referenceDate: string,
  language: TimeExportLanguage,
  accounting?: ZeitguruAccountingContext,
) {
  const [startDate, endDate] = rangeForPeriod(period, referenceDate, user.id, database.timeEntries, database.absences, database.requests, accounting)
  const holidays = holidaysForYears(yearsForDateRange(startDate, endDate), database.holidayOverrides, database.holidaySettings)
  const holidaysByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]))
  const now = new Date()
  const employeeName = displayUserName(user)
  const periodRange = startDate === endDate ? startDate : `${startDate} - ${endDate}`

  const rows = dateKeysBetween(startDate, endDate).map((date) => {
    const dayEntries = database.timeEntries
      .filter((entry) => entry.userId === user.id && entry.date === date)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    const dayAbsences = database.absences.filter((absence) => absence.userId === user.id && absence.date === date)
    const holiday = holidaysByDate.get(date)
    const sourceDay = accountingDay(accounting, date)
    const sourceTotals = accounting ? periodTotalsWithAccounting(user, database.timeEntries, database.absences, holidays, date, date, accounting, { requests: database.requests, now }) : undefined
    const expectedMinutes = sourceTotals?.expectedMinutes ?? expectedMinutesForDate(user, date, dayAbsences, holiday)
    const workedMinutes = dayEntries.reduce((total, entry) => total + entryWorkedMinutes(entry, now), 0)
    const breakMinutes = dayEntries.reduce((total, entry) => total + breakMinutesForEntry(entry, now), 0)
    const deductedMinutes = balanceDeductionsForRange(database.requests, user.id, date, date)
    const balanceMinutes = sourceTotals ? sourceTotals.plusMinusMinutes + (sourceDay ? 0 : workedMinutes - sourceTotals.workedMinutes) : workedMinutes - expectedMinutes - deductedMinutes
    const absenceNames = [...new Set([...dayAbsences.map((absence) => absenceLabels[language][absence.type]), ...(sourceDay?.absence ? [sourceDay.absence.typeName] : [])])]
    const sources = [...new Set(dayEntries.map((entry) => entry.source))]
    const workLocations = [
      ...new Set(dayEntries.map((entry) => (entry.workLocation ? workLocationLabels[language][entry.workLocation] : '')).filter(Boolean)),
    ]

    return [
      date,
      weekdayLabel(date, language),
      employeeName,
      user.email,
      periodRange,
      formatNumber(expectedMinutes / 60, language),
      formatNumber(workedMinutes / 60, language),
      formatNumber(breakMinutes / 60, language),
      formatNumber(balanceMinutes / 60, language),
      dayEntries.map((entry) => localTime(entry.startedAt)).join(' | '),
      dayEntries.map((entry) => localTime(entry.stoppedAt) || (language === 'de' ? 'offen' : 'open')).join(' | '),
      dayEntries.map((entry) => breaksLabel(entry, language)).filter(Boolean).join(' | '),
      dayEntries.length,
      absenceNames.join(' | '),
      sourceDay ? (sourceDay.holidayMinutes ? 'Zeitguru' : '') : holidayDisplayName(holiday),
      sourceDay ? '' : holiday ? formatNumber(holiday.freePercent, language) : '',
      workLocations.join(' | '),
      sources.join(' | '),
      [...dayEntries.map((entry) => entry.note ?? '').filter(Boolean), ...(deductedMinutes ? [`${language === 'de' ? 'Überstundenabbau' : 'Overtime deduction'}: ${deductedMinutes} min`] : [])].join(' | '),
      ...(accounting ? [
        sourceDay ? formatNumber(sourceDay.creditedMinutes / 60, language) : '',
        sourceDay ? formatNumber(sourceDay.absenceMinutes / 60, language) : '',
        sourceDay ? formatNumber(sourceDay.holidayMinutes / 60, language) : '',
        sourceDay ? formatNumber(sourceDay.correctionMinutes / 60, language) : '',
        accounting.openingKnown ? 'source_opening' : 'period_delta',
        accounting.warnings.filter(warning => warning.date === date).map(warning => warning.code).join(' | '),
      ] : []),
    ]
  })

  const accountingHeaders = language === 'de' ? ['Gutschriftstunden', 'Abwesenheitsgutschrift', 'Feiertagsgutschrift', 'Korrekturstunden', 'Kontobasis', 'Prüfhinweise'] : ['Credited hours', 'Absence credit hours', 'Holiday credit hours', 'Correction hours', 'Balance basis', 'Review warnings']
  const csv = `\uFEFF${[[...headers[language], ...(accounting ? accountingHeaders : [])], ...rows].map(csvLine).join('\r\n')}\r\n`
  const periodPart = period === 'all' ? 'all-time' : period
  const namePart = safeFilenamePart(employeeName) || 'user'
  const filename = `nrw-time-export-${namePart}-${periodPart}-${startDate}-${endDate}.csv`

  return { csv, filename, startDate, endDate }
}
