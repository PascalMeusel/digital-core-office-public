import type { AbsenceDay, AbsenceType, CustomCalendarEvent, ExternalCalendarEvent, Holiday, User } from '../shared/domain.ts'
import { addDays, dateKeysBetween, isoFromDateAndTime, toDateKey } from '../shared/dates.ts'
import type { ZeitguruAccountingContexts } from '../shared/timeAccounting.ts'

export type CalendarExportMode = 'day' | 'week' | 'month'
export type CalendarExportLanguage = 'en' | 'de'

interface CalendarIcsExportOptions {
  users: User[]
  holidays: Holiday[]
  absences: AbsenceDay[]
  externalEvents: ExternalCalendarEvent[]
  customEvents: CustomCalendarEvent[]
  startDate: string
  endDate: string
  mode: CalendarExportMode
  language: CalendarExportLanguage
  accounting?: ZeitguruAccountingContexts
}

const absenceLabels: Record<CalendarExportLanguage, Record<AbsenceType, string>> = {
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

function displayUserName(user: Pick<User, 'name' | 'role'> | undefined) {
  if (!user) {
    return ''
  }

  const trailingRole = user.role === 'employee' ? /\s+(Employee|Mitarbeiter)$/i : /\s+(Admin|Administrator)$/i
  const cleanedName = user.name.replace(trailingRole, '').trim()
  return cleanedName || user.name
}

function escapeIcsText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function foldLine(line: string) {
  if (line.length <= 74) {
    return line
  }

  const lines: string[] = []
  let remaining = line
  while (remaining.length > 74) {
    lines.push(remaining.slice(0, 74))
    remaining = ` ${remaining.slice(74)}`
  }
  lines.push(remaining)
  return lines.join('\r\n')
}

function icsDate(date: string) {
  return date.replace(/-/g, '')
}

function icsDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function localDateTime(date: string, time: string) {
  return new Date(isoFromDateAndTime(date, time))
}

function eventOverlapsDateRange(startAt: string, endAt: string, startDate: string, endDate: string) {
  const eventStart = toDateKey(new Date(startAt))
  const eventEnd = toDateKey(new Date(endAt))
  return eventStart <= endDate && eventEnd >= startDate
}

function safeFilenamePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function vevent(lines: string[]) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT']
}

function eventLine(name: string, value: string) {
  return foldLine(`${name}:${escapeIcsText(value)}`)
}

function allDayEvent(id: string, summary: string, date: string, stamp: string, description?: string) {
  return vevent([
    eventLine('UID', `${id}@arbeitszeitbuero`),
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(date)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(date, 1))}`,
    eventLine('SUMMARY', summary),
    ...(description ? [eventLine('DESCRIPTION', description)] : []),
  ])
}

function timedEvent(id: string, summary: string, startAt: Date | string, endAt: Date | string, stamp: string, description?: string) {
  const start = startAt instanceof Date ? startAt : new Date(startAt)
  const end = endAt instanceof Date ? endAt : new Date(endAt)
  const safeEnd = end.getTime() > start.getTime() ? end : new Date(start.getTime() + 30 * 60_000)
  return vevent([
    eventLine('UID', `${id}@arbeitszeitbuero`),
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsDateTime(start)}`,
    `DTEND:${icsDateTime(safeEnd)}`,
    eventLine('SUMMARY', summary),
    ...(description ? [eventLine('DESCRIPTION', description)] : []),
  ])
}

export function buildCalendarIcsExport({
  users,
  holidays,
  absences,
  externalEvents,
  customEvents,
  startDate,
  endDate,
  mode,
  language,
  accounting = {},
}: CalendarIcsExportOptions) {
  const userById = new Map(users.map((user) => [user.id, user]))
  const stamp = icsDateTime(new Date())
  const events: string[][] = []

  for (const holiday of holidays.filter((holiday) => holiday.date >= startDate && holiday.date <= endDate)) {
    events.push(allDayEvent(`holiday-${holiday.id}-${holiday.date}`, holiday.name, holiday.date, stamp))
  }

  for (const absence of absences.filter((absence) => absence.date >= startDate && absence.date <= endDate)) {
    const name = displayUserName(userById.get(absence.userId))
    const label = absenceLabels[language][absence.type]
    events.push(allDayEvent(`absence-${absence.id}`, `${name}: ${label}`, absence.date, stamp, absence.label))
  }

  for (const user of users) {
    for (const day of accounting[user.id]?.days ?? []) {
      if (!day.absence || day.date < startDate || day.date > endDate || absences.some(absence => absence.userId === user.id && absence.date === day.date)) continue
      events.push(allDayEvent(`zeitguru-absence-${user.id}-${day.date}`, `${displayUserName(user)}: ${day.absence.typeName}`, day.date, stamp, 'Zeitguru'))
    }
  }

  for (const event of customEvents.filter((item) => item.date >= startDate && item.date <= endDate)) {
    const name = displayUserName(userById.get(event.userId))
    const summary = `${name}: ${event.title}`
    if (event.isAllDay || !event.startTime || !event.endTime) {
      events.push(allDayEvent(`custom-${event.id}`, summary, event.date, stamp, event.description))
    } else {
      events.push(
        timedEvent(
          `custom-${event.id}`,
          summary,
          localDateTime(event.date, event.startTime),
          localDateTime(event.date, event.endTime),
          stamp,
          event.description,
        ),
      )
    }
  }

  for (const event of externalEvents.filter((item) => eventOverlapsDateRange(item.startAt, item.endAt, startDate, endDate))) {
    const name = displayUserName(userById.get(event.userId))
    const summary = `${name}: ${event.title || (language === 'de' ? 'Beschäftigt' : 'Busy')}`
    if (event.isAllDay) {
      const eventStart = toDateKey(new Date(event.startAt))
      const eventEnd = toDateKey(new Date(event.endAt))
      for (const date of dateKeysBetween(eventStart, eventEnd > eventStart ? addDays(eventEnd, -1) : eventStart)) {
        if (date >= startDate && date <= endDate) {
          events.push(allDayEvent(`external-${event.id}-${date}`, summary, date, stamp))
        }
      }
    } else {
      events.push(timedEvent(`external-${event.id}`, summary, event.startAt, event.endAt, stamp))
    }
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Digital Core Office Time//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    eventLine('X-WR-CALNAME', 'Digital Core Office Time'),
    ...events.flat(),
    'END:VCALENDAR',
  ]
  const ics = `${lines.join('\r\n')}\r\n`
  const filename = `digital-core-office-time-calendar-${safeFilenamePart(mode)}-${startDate}-${endDate}.ics`

  return { ics, filename, startDate, endDate }
}
