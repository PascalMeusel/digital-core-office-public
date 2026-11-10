import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { RequestItem, TimeEntry } from '../shared/domain.ts'

const directory = mkdtempSync(join(tmpdir(), 'dco-time-integrity-'))
Object.assign(process.env, {
  TIME_TRACKER_DATA: join(directory, 'time.sqlite'), TIME_TRACKER_BACKUP_DIR: join(directory, 'backups'),
  INITIAL_ADMIN_NAME: 'Regression User', INITIAL_ADMIN_EMAIL: 'regression@example.invalid',
  INITIAL_ADMIN_PASSWORD: 'Unique!Temporary2026Secure', INITIAL_ADMIN_MUST_CHANGE_PASSWORD: 'false',
  REQUIRE_DATA_ENCRYPTION: 'false', DATA_ENCRYPTION_KEY: '', DCO_TIMEZONE: 'Europe/Berlin',
  DCO_CORE_URL: '',
})
const { readDatabase, writeDatabase, DatabaseConflictError, addAudit } = await import('../server/store.ts')
const { applyApprovedRequestEffects, undoApprovedRequestEffects } = await import('../server/requestEffects.ts')
const { entryWorkedMinutes, summaryForUser, vacationUsedDays, balanceDeductionsForRange } = await import('../server/calculations.ts')
const { importTimeCsv } = await import('../server/csvImport.ts')
const { buildTimeCsvExport } = await import('../server/csvExport.ts')
const { buildCalendarIcsExport } = await import('../server/calendarExport.ts')
const { isoFromDateAndTime, setOrganizationTimezone, businessDateKey } = await import('../shared/dates.ts')
const { provisionCoreUser } = await import('../server/coreAuth.ts')

function fresh() {
  const database = readDatabase()
  database.timeEntries = []
  database.absences = []
  database.requests = []
  database.calDavAccounts = []
  database.audit = []
  database.users[0].trackingStartDate = '2026-09-01'
  writeDatabase(database)
  return readDatabase()
}
function entry(userId: string, overrides: Partial<TimeEntry> = {}): TimeEntry {
  return { id: 'work-original', userId, date: '2026-09-01', startedAt: isoFromDateAndTime('2026-09-01', '09:00'), stoppedAt: isoFromDateAndTime('2026-09-01', '17:00'), breaks: [], source: 'clock', workLocation: 'office', createdAt: '2026-09-01T07:00:00.000Z', updatedAt: '2026-09-01T15:00:00.000Z', ...overrides }
}
function request(userId: string, overrides: Partial<RequestItem> = {}): RequestItem {
  return { id: 'request-1', userId, type: 'time_correction', status: 'approved', correctionDate: '2026-09-01', proposedStartTime: '09:00', proposedEndTime: '17:00', proposedBreakMinutes: 30, reason: 'Record missing break', createdAt: '2026-09-02T10:00:00.000Z', decidedAt: '2026-09-02T12:00:00.000Z', ...overrides }
}

test('an asynchronous stale snapshot preserves a concurrently committed clock entry', async () => {
  fresh()
  const slow = readDatabase()
  let release!: () => void
  const network = new Promise<void>((resolve) => { release = resolve })
  const sync = (async () => {
    await network
    slow.calDavAccounts.push({ id: 'calendar-1', userId: slow.users[0].id, name: 'Calendar', serverUrl: 'https://calendar.example.invalid', username: 'person', password: 'secret', shareEventTitles: false, syncEnabled: true, passwordConfigured: true, lastSyncStatus: 'error', createdAt: '2026-09-02T12:00:00Z', updatedAt: '2026-09-02T12:00:00Z' })
    writeDatabase(slow)
  })()
  const clock = readDatabase()
  clock.timeEntries.push(entry(clock.users[0].id, { stoppedAt: undefined }))
  writeDatabase(clock)
  release()
  await sync
  assert.equal(readDatabase().timeEntries.length, 1)
  assert.equal(readDatabase().timeEntries[0].stoppedAt, undefined)
  assert.equal(readDatabase().calDavAccounts.length, 1)
})

test('competing updates to the same record fail atomically instead of overwriting credentials', () => {
  fresh()
  const first = readDatabase(), stale = readDatabase()
  first.users[0].name = 'New name'
  writeDatabase(first)
  stale.users[0].name = 'Overwritten name'
  addAudit(stale, stale.users[0].id, 'must-not-persist', 'user', stale.users[0].id)
  assert.throws(() => writeDatabase(stale), DatabaseConflictError)
  assert.equal(readDatabase().users[0].name, 'New name')
  assert.ok(!readDatabase().audit.some((event) => event.action === 'must-not-persist'))
})

test('correction replaces the day with 7.5 hours and undo restores the original persisted records', () => {
  let database = fresh()
  database.timeEntries.push(entry(database.users[0].id))
  writeDatabase(database)
  database = readDatabase()
  const originals = structuredClone(database.timeEntries)
  const item = request(database.users[0].id)
  database.requests.push(item)
  applyApprovedRequestEffects(database, item, database.users[0].id)
  writeDatabase(database)
  database = readDatabase()
  assert.equal(database.timeEntries.length, 1)
  assert.equal(entryWorkedMinutes(database.timeEntries[0]), 450)
  assert.equal(database.timeEntries[0].workLocation, 'office')
  const audit = database.audit.find((event) => event.action === 'time_correction_applied')
  assert.ok(audit)
  assert.equal((audit.details.originalEntries as TimeEntry[])[0].id, originals[0].id)
  undoApprovedRequestEffects(database, database.requests[0])
  database.requests[0].status = 'undone'
  writeDatabase(database)
  assert.deepEqual(readDatabase().timeEntries, originals)
})

test('undo does not overwrite newer time changes and running timers cannot be corrected', () => {
  const database = fresh(), userId = database.users[0].id
  database.timeEntries.push(entry(userId, { stoppedAt: undefined }))
  assert.throws(() => applyApprovedRequestEffects(database, request(userId), userId), /Stop the running timer/)
  database.timeEntries[0].stoppedAt = isoFromDateAndTime('2026-09-01', '17:00')
  const item = request(userId)
  applyApprovedRequestEffects(database, item, userId)
  database.timeEntries.push(entry(userId, { id: 'later-import' }))
  assert.throws(() => undoApprovedRequestEffects(database, item), /day changed/)
})

test('payout and compensatory leave have persisted dated deductions that undo reverses', () => {
  let database = fresh(), user = database.users[0]
  const payout = request(user.id, { type: 'overtime_payout', minutes: 120 })
  const leave = request(user.id, { id: 'leave-1', type: 'overtime_time_off', startDate: '2026-09-03', endDate: '2026-09-06' })
  for (const item of [payout, leave]) { database.requests.push(item); applyApprovedRequestEffects(database, item, user.id) }
  writeDatabase(database)
  database = readDatabase(); user = database.users[0]
  assert.deepEqual(database.requests.find((item) => item.id === payout.id)?.balanceEffects, [{ date: '2026-09-02', minutes: 120 }])
  assert.deepEqual(database.requests.find((item) => item.id === leave.id)?.balanceEffects, [{ date: '2026-09-03', minutes: 480 }, { date: '2026-09-04', minutes: 480 }])
  const reference = new Date('2026-09-06T12:00:00Z')
  const baseline = summaryForUser(user, [], [], [], reference).year.plusMinusMinutes
  const settled = summaryForUser(user, [], database.absences, [], reference, database.requests).year.plusMinusMinutes
  assert.equal(settled, baseline - 120, 'time off consumes its normal day deficit; the payout consumes two additional hours')
  const csv = buildTimeCsvExport(database, user, 'day', '2026-09-02', 'en').csv
  assert.match(csv, /Overtime deduction: 120 min/)
  for (const item of database.requests) { undoApprovedRequestEffects(database, item); item.status = 'undone' }
  writeDatabase(database)
  assert.equal(balanceDeductionsForRange(readDatabase().requests, user.id, '2026-01-01', '2026-12-31'), 0)
  assert.equal(readDatabase().absences.length, 0)
})

test('overlapping leave is rejected and legacy duplicate vacation rows count once', () => {
  const database = fresh(), user = database.users[0]
  const vacation = request(user.id, { type: 'vacation', startDate: '2026-09-03', endDate: '2026-09-03' })
  applyApprovedRequestEffects(database, vacation, user.id)
  assert.throws(() => applyApprovedRequestEffects(database, { ...vacation, id: 'duplicate' }, user.id), /overlaps/)
  assert.equal(vacationUsedDays(user, [...database.absences, ...database.absences], [], 2026), 1)
})

test('upgraded historical overtime is flagged for reconciliation instead of silently settled twice', () => {
  let database = fresh(), user = database.users[0]
  database.requests.push(request(user.id, { type: 'overtime_payout', minutes: 120, balanceEffects: undefined }))
  writeDatabase(database)
  database = readDatabase(); user = database.users[0]
  assert.equal(database.requests[0].balanceEffects, undefined)
  assert.equal(summaryForUser(user, [], [], [], new Date('2026-09-03T12:00:00Z'), database.requests).balanceReviewRequired, true)
  assert.equal(balanceDeductionsForRange(database.requests, user.id, '2026-01-01', '2026-12-31'), 0)
})

test('CSV rejects impossible dates without normalizing them onto another workday', () => {
  const database = fresh(), userId = database.users[0].id
  const batch = importTimeCsv(database, { userId, importedBy: userId, fileName: 'dates.csv', csv: 'Date;Start;End\n2026-02-31;09:00;17:00\n2026-13-01;09:00;17:00\n2026-02-28;09:00;17:00' })
  assert.equal(batch.importedRows, 1)
  assert.equal(batch.skippedRows, 2)
  assert.equal(database.timeEntries[0].date, '2026-02-28')
})

test('organization timezone controls wall-clock input, midnight dates and ICS across DST', () => {
  setOrganizationTimezone('Europe/Berlin')
  assert.equal(isoFromDateAndTime('2026-09-01', '09:00'), '2026-09-01T07:00:00.000Z')
  assert.equal(isoFromDateAndTime('2026-01-05', '09:00'), '2026-01-05T08:00:00.000Z')
  assert.equal(businessDateKey(new Date('2026-09-01T22:30:00Z')), '2026-09-02')
  assert.throws(() => isoFromDateAndTime('2026-03-29', '02:30'), /does not exist/)
  const user = readDatabase().users[0]
  const ics = buildCalendarIcsExport({ users: [user], holidays: [], absences: [], externalEvents: [], customEvents: [{ id: 'event-1', userId: user.id, date: '2026-09-01', title: 'Meeting', startTime: '09:00', endTime: '10:00', isAllDay: false, shareWithCalendarUsers: false, createdAt: '', updatedAt: '' }], startDate: '2026-09-01', endDate: '2026-09-01', mode: 'day', language: 'en' }).ics
  assert.match(ics, /DTSTART:20260901T070000Z/)
})

test('Core profile binding preserves legacy employee history and survives an email change', () => {
  const database = fresh(), original = database.users[0]
  original.expectedWeeklyMinutes = 1800
  original.employmentTerms = []
  database.timeEntries.push(entry(original.id))
  writeDatabase(database)
  const identity = { id: 'core-profile-1', name: 'Canonical Person', email: original.email, role: 'admin' as const, moduleRole: 'employee', active: true, mustChangePassword: false, readOnly: false }
  let linked = provisionCoreUser(identity)
  assert.equal(linked.id, original.id)
  assert.equal(linked.expectedWeeklyMinutes, 1800)
  assert.equal(linked.role, 'employee')
  assert.throws(() => provisionCoreUser({ ...identity, id: 'different-core-person' }), /different linked account/, 'reusing an email cannot transfer another employee\'s history')
  assert.equal(readDatabase().users[0].coreUserId, identity.id)
  linked = provisionCoreUser({ ...identity, email: 'renamed@example.invalid' })
  assert.equal(linked.id, original.id)
  assert.equal(readDatabase().users.length, 1)
  assert.equal(readDatabase().timeEntries[0].userId, original.id)
})

test('weekly online backup includes committed WAL records while an old reader is open', async () => {
  let database = fresh()
  const reader = new DatabaseSync(join(directory, 'time.sqlite'), { readOnly: true })
  reader.exec('BEGIN')
  reader.prepare('SELECT COUNT(*) FROM time_entries').get()
  try {
    database.timeEntries.push(entry(database.users[0].id, { id: 'committed-in-wal' }))
    writeDatabase(database)
    const { ensureWeeklyBackup } = await import('../server/store.ts')
    const [first, second] = await Promise.all([ensureWeeklyBackup(), ensureWeeklyBackup()])
    assert.equal(first, second)
    const restored = new DatabaseSync(first, { readOnly: true })
    try {
      assert.equal((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
      assert.ok(restored.prepare('SELECT id FROM time_entries WHERE id = ?').get('committed-in-wal'))
    } finally { restored.close() }
    database = readDatabase()
    assert.equal(database.timeEntries.length, 1)
  } finally { reader.exec('ROLLBACK'); reader.close() }
})
