import type { TimeEntry } from '../shared/domain.ts'
import { wallInstant, zeitguruAddDays, zeitguruIdentifier, zeitguruWallTime, ZeitguruProtocolError, type ZeitguruClockRow } from './zeitguruProtocol.ts'

export interface ZeitguruObservedClock { row: ZeitguruClockRow; entry: Pick<TimeEntry, 'date' | 'startedAt' | 'stoppedAt' | 'breaks' | 'manualBreakMinutes'> }

/** Incomplete historical auto-closes need review, not invented punches or a blocked new day. */
export function observeZeitguruRows(rows: ZeitguruClockRow[], remoteUserId: string, observedAt: string) {
  const observed: ZeitguruObservedClock[] = [], reviewDates = new Set<string>()
  const today = zeitguruWallTime(observedAt).date
  for (const row of rows) {
    // Identity and start-date validation must never be weakened by historical isolation.
    zeitguruIdentifier(row.id)
    if (row.userId !== remoteUserId || row.userId_date !== `${remoteUserId}_${row.date}`) throw new ZeitguruProtocolError('identity_mismatch')
    const start = wallInstant(row.date, row.startTime)
    try { observed.push(observedZeitguruClock(row, remoteUserId, observedAt)) }
    catch (error) {
      if (!(error instanceof ZeitguruProtocolError) || error.code !== 'unsupported_clock_row'
        || row.isAutoClockOut !== true || row.date >= today || start >= Date.parse(observedAt)) throw error
      reviewDates.add(row.date)
    }
  }
  return { observed, reviewDates: [...reviewDates].sort() }
}

/** A later clock action can prove an earlier delivery without replaying that earlier action. */
export function containsZeitguruTransition(desired: ZeitguruClockRow, observed: ZeitguruClockRow, credit: unknown, observedAt: string) {
  try {
    for (const key of ['id', 'userId', 'branchId', 'jobPositionId', 'date', 'startTime', 'userId_date', 'branchId_date', 'logS']) {
      if (desired[key] !== observed[key]) return false
    }
    if (desired.endTime && desired.endTime !== observed.endTime) return false
    const before = desired.breakActivities ?? [], after = observed.breakActivities ?? []
    if (before.length > after.length || before.some((event, index) => event.type !== after[index]?.type || event.time !== after[index]?.time)) return false
    const converted = observedZeitguruClock(observed, desired.userId, observedAt).entry
    const elapsed = converted.stoppedAt ? (Date.parse(converted.stoppedAt) - Date.parse(converted.startedAt)) / 60000 : 0
    const expectedCredit = observed.isAccepted ? Math.max(0, elapsed - (converted.stoppedAt ? observed.breakMinutes : 0)) : null
    return credit === expectedCredit
  } catch { return false }
}

/** Convert recorded provider instants; never invent a start, break or end. */
export function observedZeitguruClock(row: ZeitguruClockRow, remoteUserId: string, observedAt: string): ZeitguruObservedClock {
  const fail = (): never => { throw new ZeitguruProtocolError('unsupported_clock_row') }
  zeitguruIdentifier(row.id)
  if (row.userId !== remoteUserId || row.userId_date !== `${remoteUserId}_${row.date}` || row.isPaidBreak || row.isDynamicClocking || (row.isAutoClockOut && !row.endTime)) fail()
  if (row.isAccepted !== undefined && typeof row.isAccepted !== 'boolean') fail()
  const start = wallInstant(row.date, row.startTime), now = Date.parse(observedAt)
  if (!Number.isFinite(now) || start > now + 5000) fail()
  const after = (time: string, previous: number) => {
    let instant = wallInstant(row.date, time)
    if (instant < previous) instant = wallInstant(zeitguruAddDays(row.date, 1), time)
    if (instant < previous || instant - start >= 86400000 || instant > now + 5000) fail()
    return instant
  }
  let previous = start
  const breaks: TimeEntry['breaks'] = []
  if (!Array.isArray(row.breakActivities ?? [])) fail()
  for (const [index, event] of (row.breakActivities ?? []).entries()) {
    if (event.type !== (index % 2 ? 'end' : 'start')) fail()
    previous = after(event.time, previous)
    if (index % 2) breaks.at(-1)!.stoppedAt = new Date(previous).toISOString()
    else breaks.push({ id: `zg-${row.id}-${index}`, startedAt: new Date(previous).toISOString() })
  }
  const stop = row.endTime ? after(row.endTime, previous) : undefined
  // Zeitguru can close work while a break is open; that recorded end also ends the break.
  if (stop !== undefined && breaks.at(-1) && !breaks.at(-1)!.stoppedAt) breaks.at(-1)!.stoppedAt = new Date(stop).toISOString()
  const recordedBreak = breaks.reduce((sum, item) => sum + (item.stoppedAt ? (Date.parse(item.stoppedAt) - Date.parse(item.startedAt)) / 60000 : 0), 0)
  if (!Number.isFinite(row.breakMinutes) || row.breakMinutes < 0 || row.breakMinutes >= 1440) fail()
  if (stop !== undefined && row.breakMinutes > (stop - start) / 60000) fail()
  return { row, entry: { date: row.date, startedAt: new Date(start).toISOString(), ...(stop !== undefined ? { stoppedAt: new Date(stop).toISOString() } : {}), breaks,
    manualBreakMinutes: stop !== undefined ? Math.max(0, row.breakMinutes - recordedBreak) : 0 } }
}
