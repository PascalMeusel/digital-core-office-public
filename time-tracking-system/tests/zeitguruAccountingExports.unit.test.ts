import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from 'csv-parse/sync'
import type { AbsenceDay, TimeEntry, User } from '../shared/domain.ts'
import type { ZeitguruAccountingContext } from '../shared/timeAccounting.ts'
import type { Database } from '../server/store.ts'
import { buildTimeCsvExport } from '../server/csvExport.ts'
import { buildCalendarIcsExport } from '../server/calendarExport.ts'

const user: User = { id: 'own-user', name: 'Synthetic employee', email: 'own@example.invalid', role: 'employee', active: true, mustChangePassword: false,
  expectedWeeklyMinutes: 0, yearlyVacationDays: 0, balanceAdjustmentMinutes: 0, vacationAdjustmentDays: 0, trackingStartDate: '2026-09-07', employmentTerms: [], calendarAccessUserIds: [] }
const entry: TimeEntry = { id: 'zeitguru-archive-1', userId: user.id, date: '2026-09-01', startedAt: '2026-09-01T07:00:00Z', stoppedAt: '2026-09-01T15:00:00Z',
  breaks: [], manualBreakMinutes: 30, source: 'zeitguru', createdAt: '2026-09-07T10:00:00Z', updatedAt: '2026-09-07T10:00:00Z',
  zeitguru: { workedMinutes: 450, creditedMinutes: 0, approved: false, readOnly: true, batchId: 'batch' } }
const context: ZeitguruAccountingContext = { batchId: 'batch', fromDate: '2026-09-01', toDate: '2026-09-01', observedAt: '2026-09-07T10:00:00Z',
  openingKnown: false, balanceBasis: 'period_delta', openingBalanceMinutes: 0, closingBalanceMinutes: -480,
  days: [{ date: '2026-09-01', expectedMinutes: 480, workedMinutes: 0, actualWorkedMinutes: 450, actualBreakMinutes: 30, absenceMinutes: 0, holidayMinutes: 0, correctionMinutes: 0, creditedMinutes: 0, exactDeltaMinutes: -480, balanceMinutes: -480 }],
  forecast: [{ date: '2026-09-07', expectedMinutes: 480 }], warnings: [{ date: '2026-09-01', code: 'source_clock_unapproved' }] }
function database(entries: TimeEntry[] = [entry], absences: AbsenceDay[] = []): Database {
  return { timeEntries: entries, absences, requests: [], holidayOverrides: [], holidaySettings: { country: 'DE', state: 'HE', language: 'en' } } as unknown as Database
}

test('CSV separates actual attendance and breaks from unapproved credited time and source balance', () => {
  const db = database(), before = JSON.stringify(db)
  const output = buildTimeCsvExport(db, user, 'day', '2026-09-01', 'en', context)
  const [row] = parse(output.csv, { columns: true, delimiter: ';', bom: true })
  assert.equal(row['Worked hours'], '7.5'); assert.equal(row['Break hours'], '0.5'); assert.equal(row['Credited hours'], '0')
  assert.equal(row['Expected hours'], '8'); assert.equal(row['Overtime hours'], '-8'); assert.equal(row['Balance basis'], 'period_delta')
  assert.equal(row['Sources'], 'zeitguru'); assert.equal(JSON.stringify(db), before)
  assert.equal(output.csv.includes('batch'), false); assert.equal(output.csv.includes('zeitguru-archive-1'), false)
})

test('CSV forward targets honor a later explicit DCO term and a native approved absence', () => {
  const laterUser = { ...user, employmentTerms: [{ id: 'term', effectiveFrom: '2026-09-07', expectedWeeklyMinutes: 1200, yearlyVacationDays: 0, createdAt: '2026-09-07T11:00:00Z' }] }
  const rows = (db: Database) => parse(buildTimeCsvExport(db, laterUser, 'day', '2026-09-07', 'en', context).csv, { columns: true, delimiter: ';', bom: true })
  assert.equal(rows(database([]))[0]['Expected hours'], '4')
  const absence: AbsenceDay = { id: 'absence', userId: user.id, date: '2026-09-07', type: 'vacation', requestId: 'request', label: 'Vacation', createdAt: '2026-09-07T11:00:00Z' }
  assert.equal(rows(database([], [absence]))[0]['Expected hours'], '0')
})

test('all-time CSV includes a ledger-only missing day rather than truncating to available shifts', () => {
  const ledgerOnly = { ...context, fromDate: '2026-08-31', days: [{ ...context.days[0], date: '2026-08-31', workedMinutes: 0, actualWorkedMinutes: 0, actualBreakMinutes: 0 }, ...context.days] }
  const output = buildTimeCsvExport(database(), user, 'all', '2026-09-07', 'en', ledgerOnly)
  const rows = parse(output.csv, { columns: true, delimiter: ';', bom: true })
  assert.equal(output.startDate, '2026-08-31'); assert.equal(rows.length, 2); assert.equal(rows[0]['Worked hours'], '0'); assert.equal(rows[0]['Expected hours'], '8')
})

test('calendar includes only selected users source absences, escapes text and suppresses duplicate native absence', () => {
  const source = { ...context, days: [{ ...context.days[0], absence: { typeCode: 'vacation', typeName: 'Source; vacation\ncontinued', startsHalfDay: false, endsHalfDay: false } }] }
  const options = { users: [user], holidays: [], absences: [] as AbsenceDay[], externalEvents: [], customEvents: [], startDate: '2026-09-01', endDate: '2026-09-01', mode: 'day' as const, language: 'en' as const, accounting: { [user.id]: source, hiddenUser: { ...source, days: [{ ...source.days[0], absence: { ...source.days[0].absence!, typeName: 'Hidden private absence' } }] } } }
  const first = buildCalendarIcsExport(options).ics
  assert.equal(first.includes('Source\\; vacation\\ncontinued'), true); assert.equal(first.includes('Hidden private absence'), false)
  assert.equal((first.match(/BEGIN:VEVENT/g) ?? []).length, 1)
  const second = buildCalendarIcsExport({ ...options, absences: [{ id: 'native-absence', userId: user.id, date: '2026-09-01', type: 'vacation', requestId: 'request', label: 'Native absence', createdAt: '2026-09-07T11:00:00Z' }] }).ics
  assert.equal((second.match(/BEGIN:VEVENT/g) ?? []).length, 1); assert.equal(second.includes('Source\\; vacation'), false)
})
