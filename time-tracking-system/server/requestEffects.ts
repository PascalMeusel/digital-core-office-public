import { randomUUID } from 'node:crypto'
import type { RequestItem, TimeEntry } from '../shared/domain.ts'
import { addDays, dateKeysBetween, isoFromDateAndTime, isWeekend, toDateKey } from '../shared/dates.ts'
import { termForDate } from '../shared/terms.ts'
import { addAudit, nowIso, type Database } from './store.ts'
import { holidaysForYears, yearsForDateRange } from './holidays.ts'

export function validateTimeCorrection(request: RequestItem) {
  const validTime = (value: string | undefined) => Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
  if (!request.correctionDate || !validTime(request.proposedStartTime) || !validTime(request.proposedEndTime)) {
    throw new Error('A valid date, start time, and end time are required for time corrections')
  }
  if (request.proposedStartTime === request.proposedEndTime) throw new Error('The corrected interval must have a positive duration')
  const startedAt = isoFromDateAndTime(request.correctionDate, request.proposedStartTime!)
  const endDate = request.proposedEndTime! < request.proposedStartTime! ? addDays(request.correctionDate, 1) : request.correctionDate
  const stoppedAt = isoFromDateAndTime(endDate, request.proposedEndTime!)
  const elapsedMinutes = (Date.parse(stoppedAt) - Date.parse(startedAt)) / 60_000
  const breakMinutes = request.proposedBreakMinutes ?? 0
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes >= elapsedMinutes) {
    throw new Error('Break minutes must be smaller than the corrected interval')
  }
  return { startedAt, stoppedAt, breakMinutes }
}

export function applyApprovedRequestEffects(database: Database, request: RequestItem, actorId: string) {
  const employee = database.users.find((user) => user.id === request.userId)
  if (!employee) throw new Error('Employee not found')
  request.balanceEffects = []
  if (request.type === 'time_correction') {
    const { startedAt, stoppedAt, breakMinutes } = validateTimeCorrection(request)
    const originals = database.timeEntries.filter((entry) => entry.userId === request.userId && entry.date === request.correctionDate)
    if (originals.some((entry) => !entry.stoppedAt)) throw new Error('Stop the running timer before correcting this day')
    const timestamp = nowIso()
    const replacement: TimeEntry = {
      id: randomUUID(), userId: request.userId, date: request.correctionDate!, startedAt, stoppedAt,
      breaks: [], manualBreakMinutes: breakMinutes, workLocation: originals[0]?.workLocation,
      source: 'approved_correction', requestId: request.id, note: request.reason, createdAt: timestamp, updatedAt: timestamp,
    }
    database.timeEntries = database.timeEntries.filter((entry) => !originals.some((original) => original.id === entry.id))
    database.timeEntries.push(replacement)
    // Audit details are encrypted by the store. Keep original timestamps, breaks,
    // source and IDs so an undo can restore the exact records.
    addAudit(database, actorId, 'time_correction_applied', 'request', request.id, { originalEntries: originals, replacementEntry: replacement })
    return
  }
  if (request.type === 'overtime_payout') {
    if (!Number.isSafeInteger(request.minutes) || Number(request.minutes) <= 0) throw new Error('Payout minutes must be a positive whole number')
    request.balanceEffects = [{ date: toDateKey(new Date(request.decidedAt ?? nowIso())), minutes: request.minutes! }]
  } else if (['vacation', 'sick_leave', 'child_sick_leave', 'overtime_time_off'].includes(request.type)) {
    if (!request.startDate || !request.endDate) throw new Error('A start and end date are required')
    const dates = dateKeysBetween(request.startDate, request.endDate)
    if (database.absences.some((absence) => absence.userId === request.userId && dates.includes(absence.date) && absence.requestId !== request.id)) {
      throw new Error('This request overlaps an existing approved absence. Undo that approval before replacing it.')
    }
    const holidays = new Map(holidaysForYears(yearsForDateRange(request.startDate, request.endDate), database.holidayOverrides, database.holidaySettings).map((holiday) => [holiday.date, holiday]))
    for (const date of dates) {
      database.absences.push({ id: randomUUID(), userId: request.userId, date, type: request.type as 'vacation' | 'sick_leave' | 'child_sick_leave' | 'overtime_time_off', requestId: request.id, label: request.type.replaceAll('_', ' '), createdAt: nowIso() })
      if (request.type === 'overtime_time_off' && !isWeekend(date)) {
        const freePercent = holidays.get(date)?.freePercent ?? 0
        const minutes = Math.round(termForDate(employee, date).expectedWeeklyMinutes / 5 * (1 - Math.max(0, Math.min(100, freePercent)) / 100))
        if (minutes > 0) request.balanceEffects.push({ date, minutes })
      }
    }
  }
  if (request.balanceEffects.length) addAudit(database, actorId, 'overtime_deduction_applied', 'request', request.id, { effects: request.balanceEffects })
}

export function undoApprovedRequestEffects(database: Database, request: RequestItem) {
  const correctionAudit = database.audit.find((event) => event.action === 'time_correction_applied' && event.targetId === request.id)
  if (correctionAudit) {
    const replacement = correctionAudit.details.replacementEntry as TimeEntry
    const current = database.timeEntries.filter((entry) => entry.userId === request.userId && entry.date === request.correctionDate)
    if (current.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(replacement)) {
      // SQLite normalizes optional fields. Compare the material persisted values
      // below before rejecting a harmless round trip.
      if (current.length !== 1 || current[0].id !== replacement.id || current[0].updatedAt !== replacement.updatedAt) {
        throw new Error('This day changed after the correction. Undo later corrections first or submit a new correction.')
      }
    }
    database.timeEntries = database.timeEntries.filter((entry) => entry.id !== replacement.id)
    database.timeEntries.push(...structuredClone(correctionAudit.details.originalEntries as TimeEntry[]))
  } else {
    database.timeEntries = database.timeEntries.filter((entry) => entry.requestId !== request.id || entry.source !== 'approved_correction')
  }
  database.absences = database.absences.filter((absence) => absence.requestId !== request.id)
  // The stored deductions remain in the request/audit history. Calculations
  // include approved requests only, so changing status to undone reverses them.
}
