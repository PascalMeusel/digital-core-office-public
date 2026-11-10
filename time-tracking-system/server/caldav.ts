import ical, { type VEvent } from 'node-ical'
import { DAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav'
import { randomUUID } from 'node:crypto'
import type { ExternalCalendarEvent } from '../shared/domain.ts'
import type { Database, StoredCalDavAccount } from './store.ts'
import { nowIso } from './store.ts'

const syncPastDays = 30
const syncFutureDays = 365

function syncWindow() {
  const start = new Date()
  start.setDate(start.getDate() - syncPastDays)
  start.setHours(0, 0, 0, 0)

  const end = new Date()
  end.setDate(end.getDate() + syncFutureDays)
  end.setHours(23, 59, 59, 999)

  return { start, end }
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

function displayName(value: DAVCalendar['displayName']) {
  if (!value) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  const text = Object.values(value).find((item): item is string => typeof item === 'string')
  return text ?? ''
}

function sameCalendarUrl(left: string | undefined, right: string) {
  return Boolean(left && normalizeUrl(left) === normalizeUrl(right))
}

function eventOverlapsRange(startAt: Date, endAt: Date, rangeStart: Date, rangeEnd: Date) {
  return startAt <= rangeEnd && endAt >= rangeStart
}

function eventTitle(event: VEvent) {
  if (typeof event.summary === 'string') {
    return event.summary.trim()
  }
  return ''
}

function toExternalEvents(account: StoredCalDavAccount, object: DAVCalendarObject, rangeStart: Date, rangeEnd: Date) {
  const externalEvents: ExternalCalendarEvent[] = []
  if (typeof object.data !== 'string') {
    return externalEvents
  }

  const parsed = ical.sync.parseICS(object.data)
  for (const [key, component] of Object.entries(parsed)) {
    if (!component || component.type !== 'VEVENT') {
      continue
    }

    const event = component as VEvent
    if (event.status === 'CANCELLED' || event.transparency === 'TRANSPARENT') {
      continue
    }

    const instances = event.rrule
      ? ical.expandRecurringEvent(event, { from: rangeStart, to: rangeEnd, expandOngoing: true })
      : [
          {
            start: event.start,
            end: event.end ?? event.start,
            isFullDay: event.datetype === 'date' || Boolean(event.start.dateOnly),
            event,
          },
        ]

    for (const instance of instances) {
      const startAt = new Date(instance.start)
      const endAt = new Date(instance.end)
      if (!eventOverlapsRange(startAt, endAt, rangeStart, rangeEnd)) {
        continue
      }

      const startIso = startAt.toISOString()
      const endIso = endAt.toISOString()
      externalEvents.push({
        id: randomUUID(),
        userId: account.userId,
        accountId: account.id,
        externalId: `${object.url}#${event.uid ?? key}#${startIso}`,
        title: eventTitle(instance.event),
        startAt: startIso,
        endAt: endIso,
        isAllDay: instance.isFullDay,
        busy: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
    }
  }

  return externalEvents
}

function selectCalendar(calendars: DAVCalendar[], account: StoredCalDavAccount) {
  if (account.calendarUrl) {
    return calendars.find((calendar) => sameCalendarUrl(account.calendarUrl, calendar.url))
  }

  return calendars.find((calendar) => !calendar.components || calendar.components.includes('VEVENT')) ?? calendars[0]
}

export async function syncCalDavAccount(database: Database, account: StoredCalDavAccount) {
  const { start, end } = syncWindow()
  const client = new DAVClient({
    serverUrl: account.serverUrl,
    credentials: {
      username: account.username,
      password: account.password,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })

  await client.login()
  const calendars = await client.fetchCalendars()
  const calendar = selectCalendar(calendars, account)
  if (!calendar) {
    throw new Error('No CalDAV calendar was found for this account.')
  }

  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    expand: true,
  })

  const nextEvents = objects.flatMap((object) => toExternalEvents(account, object, start, end))
  const seen = new Set<string>()
  const dedupedEvents = nextEvents.filter((event) => {
    const key = `${event.externalId}:${event.startAt}:${event.endAt}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })

  const now = nowIso()
  database.externalCalendarEvents = [
    ...database.externalCalendarEvents.filter((event) => event.accountId !== account.id),
    ...dedupedEvents,
  ].sort((left, right) => left.startAt.localeCompare(right.startAt))

  account.calendarUrl = calendar.url
  account.calendarName = displayName(calendar.displayName) || account.calendarName || account.name
  account.lastSyncAt = now
  account.lastSyncStatus = 'success'
  account.lastSyncError = undefined
  account.updatedAt = now

  return dedupedEvents.length
}
