import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import type { User, TimeEntry } from '../shared/domain.ts'
import type { ZeitguruAccountingDay, ZeitguruAccountingReport } from '../shared/zeitguruAccounting.ts'
import { accountingCarryBefore, periodTotalsWithAccounting, type ZeitguruAccountingContext } from '../shared/timeAccounting.ts'
import { ZeitguruAccountingStore } from '../server/zeitguruAccountingStore.ts'
import { ZeitguruHistoryStore, type ZeitguruHistoryInputRow } from '../server/zeitguruHistoryStore.ts'
import { encryptText } from '../server/fieldCrypto.ts'
import { dayIssuesForUsers } from '../server/dayIssues.ts'
import { entryWorkedMinutes, summaryForUser } from '../server/calculations.ts'
import { classifyLegacyAbsence } from '../server/zeitguruLegacyAbsence.ts'
import { applyApprovedRequestEffects, undoApprovedRequestEffects } from '../server/requestEffects.ts'
import type { Database, StoredUser } from '../server/store.ts'
import type { Holiday, RequestItem } from '../shared/domain.ts'

const user: User = { id: 'own-user', name: 'Synthetic', email: 'own@example.invalid', role: 'employee', active: true, mustChangePassword: false,
  expectedWeeklyMinutes: 0, yearlyVacationDays: 0, balanceAdjustmentMinutes: 0, vacationAdjustmentDays: 0, trackingStartDate: '2026-09-07', employmentTerms: [], calendarAccessUserIds: [] }
function day(date: string, workedMinutes = 450, expectedMinutes = 480): ZeitguruAccountingDay {
  return { date, workedMinutes, expectedMinutes, absenceMinutes: 0, holidayMinutes: 0, correctionMinutes: 0, creditedMinutes: workedMinutes, exactDeltaMinutes: workedMinutes - expectedMinutes, balanceMinutes: 0, details: { privateAccountingMarker: 'must-stay-encrypted' } }
}
function report(days: ZeitguruAccountingDay[] = [day('2026-09-01')], overrides: Partial<ZeitguruAccountingReport> = {}): ZeitguruAccountingReport {
  const openingBalanceMinutes = overrides.openingBalanceMinutes ?? 0
  let balance = openingBalanceMinutes
  return { fromDate: days[0].date, toDate: days.at(-1)!.date, observedAt: '2026-09-07T10:00:00Z', openingKnown: false, balanceBasis: 'period_delta',
    opening: { date: days[0].date, minutes: 0 }, openingBalanceMinutes,
    days: days.map(value => ({ ...value, balanceMinutes: Math.round(balance += value.exactDeltaMinutes) })), closingBalanceMinutes: Math.round(openingBalanceMinutes + days.reduce((sum, value) => sum + value.exactDeltaMinutes, 0)),
    forecast: [], contracts: [], warnings: [], details: { privateReportMarker: 'must-stay-encrypted-report' }, ...overrides }
}
function row(date = '2026-09-01', overrides: Partial<ZeitguruHistoryInputRow> = {}): ZeitguruHistoryInputRow {
  return { sourceId: `private-source-${date}`, date, startedAt: `${date}T09:00:00+02:00`, stoppedAt: `${date}T17:00:00+02:00`, breakMinutes: 30, workedMinutes: 450, creditedMinutes: 450, approved: true, details: { rawRow: { id: `private-source-${date}` } }, ...overrides }
}
function native(date = '2026-09-01', overrides: Partial<TimeEntry> = {}): TimeEntry {
  const source = row(date)
  return { id: 'native-1', userId: user.id, date, startedAt: source.startedAt, stoppedAt: source.stoppedAt, breaks: [], manualBreakMinutes: 30,
    source: 'clock', createdAt: '2026-09-07T10:00:00Z', updatedAt: '2026-09-07T10:00:00Z', ...overrides }
}
function fixture(t: TestContext) {
  const oldKey = process.env.DATA_ENCRYPTION_KEY
  process.env.DATA_ENCRYPTION_KEY = 'synthetic-accounting-test-key-32-characters'
  const directory = mkdtempSync(join(tmpdir(), 'dco-zeitguru-accounting-')), path = join(directory, 'time.sqlite')
  const history = new ZeitguruHistoryStore(path, { now: () => Date.parse('2026-09-07T10:00:00Z') }), accounting = new ZeitguruAccountingStore(path), sql = new DatabaseSync(path)
  sql.exec("CREATE TABLE users(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE time_entries(id TEXT PRIMARY KEY,value TEXT);INSERT INTO users VALUES('own-user','native-profile');INSERT INTO time_entries VALUES('native-existing','native-record');")
  t.after(() => { sql.close(); accounting.close(); history.close(); rmSync(directory, { recursive: true, force: true }); if (oldKey === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = oldKey })
  const importReport = (value = report(), rows = [row()], clientRequestId = 'request-1', userId = user.id) => history.importBatch({ userId, providerKey: 'tenant/private-provider-user', expectedGeneration: 0, clientRequestId, fromDate: value.fromDate, toDate: value.toDate, rows, accounting: value })
  return { history, accounting, sql, path, importReport }
}

test('accounting commits encrypted with history, projects immutable evidence and changes native-zero-target totals without changing native records', t => {
  const f = fixture(t), beforeUsers = f.sql.prepare('SELECT * FROM users').all(), beforeEntries = f.sql.prepare('SELECT * FROM time_entries').all()
  f.importReport()
  const projection = f.accounting.projection(user.id), context = projection.accounting!
  assert.equal(projection.entries.length, 1); assert.equal(projection.entries[0].source, 'zeitguru'); assert.equal(projection.entries[0].zeitguru?.readOnly, true)
  assert.equal(entryWorkedMinutes(projection.entries[0]), 450)
  const summary = summaryForUser(user, projection.entries, [], [], new Date('2026-09-07T12:00:00'), [], context)
  assert.equal(summary.year.expectedMinutes, 480); assert.equal(summary.year.workedMinutes, 450); assert.equal(summary.year.plusMinusMinutes, -30); assert.equal(summary.balanceReviewRequired, true)
  assert.equal(context.openingKnown, false)
  const visible = JSON.stringify(projection), disk = readFileSync(f.path)
  for (const secret of ['private-source-', 'private-provider-user', 'privateAccountingMarker', 'must-stay-encrypted', 'privateReportMarker']) {
    assert.equal(visible.includes(secret), false); assert.equal(disk.includes(Buffer.from(secret)), false)
  }
  assert.deepEqual(f.sql.prepare('SELECT * FROM users').all(), beforeUsers); assert.deepEqual(f.sql.prepare('SELECT * FROM time_entries').all(), beforeEntries)
  assert.deepEqual(f.accounting.projection('other-user'), { entries: [] })
})

test('company eight-hour absence classification preserves credits and raw evidence through undo and reimport',t=>{
  const f=fixture(t),dates=['2026-09-01','2026-09-02','2026-09-03'],value=report(dates.map(date=>day(date,480)),{openingKnown:true,balanceBasis:'source_opening'})
  const rows=dates.map((date,index)=>row(date,{breakMinutes:0,workedMinutes:480,creditedMinutes:480,details:{rawRow:{comment:index===2?'krank':''}}}))
  const holidays:Holiday[]=[{id:'holiday',date:'2026-09-02',name:'Synthetic holiday',source:'custom',freePercent:100}]
  const imported=f.importReport(value,rows)
  const rawBefore=JSON.stringify(f.sql.prepare('SELECT * FROM zeitguru_history_rows ORDER BY id').all())
  assert.equal(f.accounting.projection(user.id).entries.length,3,'the convention is off outside the company evaluation')
  const overlay=new ZeitguruAccountingStore(f.path,{legacyVacationRule:true,inputs:()=>({absences:[],holidays})})
  try{
    for(let attempt=0;attempt<2;attempt++){
      const projection=overlay.projection(user.id)
      assert.equal(projection.entries.length,0);assert.equal(projection.accounting!.closingBalanceMinutes,0)
      assert.deepEqual(projection.accounting!.days.map(day=>day.importClassification?.type),['vacation','holiday','illness'])
      assert(projection.accounting!.days.every(day=>day.actualWorkedMinutes===0&&day.creditedMinutes===480&&day.exactDeltaMinutes===0))
      assert.equal(projection.accounting!.days[0].absenceMinutes,480);assert.equal(projection.accounting!.days[1].holidayMinutes,480)
      const issues=dayIssuesForUsers([user],projection.entries,[],holidays,new Date('2026-09-07T12:00:00Z'),{[user.id]:projection.accounting})
      assert(!issues.some(issue=>dates.includes(issue.date)&&['missing_day','insufficient_break','sunday_or_holiday_work'].includes(issue.rule)))
      if(attempt===0){
        assert.equal(JSON.stringify(f.sql.prepare('SELECT * FROM zeitguru_history_rows ORDER BY id').all()),rawBefore)
        f.history.undoBatch(user.id,imported.batch.id,imported.batch.fingerprint)
        assert.deepEqual(overlay.projection(user.id),{entries:[]})
        f.importReport(value,rows,'second-import')
      }
    }
    assert.equal(f.history.status(user.id).totalRecords,3);assert.equal(f.history.status(user.id).totalWorkedMinutes,1440,'raw archive retains original values')
  }finally{overlay.close()}
})

test('absence convention excludes nonmatching work, native records, ambiguous approval, overlap and partial leave',()=>{
  const value=day('2026-09-01',480),source=row('2026-09-01',{breakMinutes:0,workedMinutes:480,creditedMinutes:480})
  assert.equal(classifyLegacyAbsence(value,[source],[],[])?.type,'vacation')
  for(const changed of [{workedMinutes:479},{workedMinutes:481},{breakMinutes:30},{approved:false},{approved:null},{creditedMinutes:null},{details:{rawRow:{isAutoClockOut:true}}}])assert.equal(classifyLegacyAbsence(value,[{...source,...changed}],[],[]),undefined)
  assert.equal(classifyLegacyAbsence(value,[source],[native()],[]),undefined)
  assert.equal(classifyLegacyAbsence(value,[{...source,workedMinutes:240},{...source,sourceId:'overlap',workedMinutes:240}],[],[]),undefined)
  assert.equal(classifyLegacyAbsence({...value,absence:{typeCode:'vacation',typeName:'Vacation',startsHalfDay:true,endsHalfDay:false}},[source],[],[]),undefined)
  const holiday:Holiday={id:'configured',date:value.date,name:'State holiday',source:'template',freePercent:100}
  assert.equal(classifyLegacyAbsence(value,[{...source,details:{rawRow:{comment:'Urlaub'}}}],[],[holiday])?.type,'holiday','the state holiday calendar takes priority over vacation placeholders')
})

test('one approved vacation request credits five missing imported days and undo restores the original balance and issues',t=>{
  const f=fixture(t),dates=['2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04']
  f.importReport(report(dates.map(date=>day(date,0)),{openingKnown:true,balanceBasis:'source_opening'}),[])
  const database={users:[user as StoredUser],timeEntries:[],absences:[],requests:[],audit:[],holidaySettings:{country:'DE',language:'en'},holidayOverrides:[]} as unknown as Database
  const overlay=new ZeitguruAccountingStore(f.path,{legacyVacationRule:false,inputs:()=>({absences:database.absences,holidays:[]})})
  try{
    const before=overlay.projection(user.id),request={id:'week-vacation',userId:user.id,type:'vacation',status:'approved',startDate:dates[0],endDate:dates.at(-1),reason:'Confirmed week of vacation',createdAt:'2026-09-07T12:00:00Z'} as RequestItem
    assert.equal(before.accounting!.closingBalanceMinutes,-2400)
    database.requests.push(request);applyApprovedRequestEffects(database,request,user.id)
    assert.equal(database.absences.length,5)
    const approved=overlay.projection(user.id)
    assert.equal(approved.accounting!.closingBalanceMinutes,0);assert(approved.accounting!.days.every(day=>day.localAbsenceApplied&&day.absenceMinutes===480))
    assert(!dayIssuesForUsers([user],[],database.absences,[],new Date('2026-09-07T12:00:00Z'),{[user.id]:approved.accounting}).some(issue=>issue.rule==='missing_day'&&dates.includes(issue.date)))
    assert.deepEqual(overlay.projection(user.id),approved,'repeat reads do not add credit twice')
    undoApprovedRequestEffects(database,request);request.status='undone'
    assert.deepEqual(overlay.projection(user.id),before);assert.equal(database.absences.length,0)
    assert.equal(dayIssuesForUsers([user],[],[],[],new Date('2026-09-07T12:00:00Z'),{[user.id]:before.accounting}).filter(issue=>issue.rule==='missing_day'&&dates.includes(issue.date)).length,5)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM zeitguru_accounting_snapshots').get()!.n,1)
  }finally{overlay.close()}
})

test('invalid or discontinuous accounting rolls back all archive inserts and the batch', t => {
  const f = fixture(t)
  assert.throws(() => f.importReport(report([day('2026-09-01')], { closingBalanceMinutes: 1000 })))
  assert.equal(f.history.status(user.id).totalRecords, 0); assert.equal(f.history.status(user.id).lastImport, undefined)
  assert.throws(() => f.importReport(report([day('2026-09-01'), day('2026-09-03')]), [row()]))
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM zeitguru_accounting_snapshots').get()!.n, 0)
})

test('snapshot-only duplicate batches undo newest first and restore the previous accounting without removing native data', t => {
  const f = fixture(t), first = f.importReport()
  const secondReport = report([{ ...day('2026-09-01'), correctionMinutes: 60, creditedMinutes: 510, exactDeltaMinutes: 30 }])
  const second = f.importReport(secondReport, [row()], 'request-2')
  assert.equal(second.batch.added, 0); assert.equal(second.batch.duplicates, 1); assert.equal(second.batch.canUndo, true)
  assert.equal(f.accounting.projection(user.id).accounting!.closingBalanceMinutes, 30)
  assert.throws(() => f.history.undoBatch(user.id, first.batch.id, first.batch.fingerprint), (error: unknown) => (error as { code: string }).code === 'newer_accounting_import_exists')
  f.history.undoBatch(user.id, second.batch.id, second.batch.fingerprint)
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM zeitguru_accounting_snapshots WHERE batchId=?').get(second.batch.id)!.n, 0)
  assert.equal(f.accounting.projection(user.id).accounting!.closingBalanceMinutes, -30)
  assert.equal(f.history.status(user.id).totalRecords, 1)
  f.history.undoBatch(user.id, first.batch.id, first.batch.fingerprint)
  assert.deepEqual(f.accounting.projection(user.id), { entries: [] })
  assert.equal(f.history.status(user.id).totalRecords, 0); assert.equal(f.sql.prepare('SELECT value FROM time_entries').get()!.value, 'native-record')
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM zeitguru_accounting_snapshots').get()!.n, 0)
  assert.equal(f.history.batchForRequest(user.id, 'request-2')!.undone, true)
})

test('duplicate request IDs cannot attach changed accounting evidence', t => {
  const f = fixture(t), first = f.importReport()
  assert.equal(f.importReport().batch.id, first.batch.id)
  assert.throws(() => f.importReport(report([day('2026-09-01')], { warnings: ['source_changed'] })), (error: unknown) => (error as { code: string }).code === 'request_conflict')
})

test('verified provider checkpoint deduplicates the physical shift and the accounting credit', t => {
  const f = fixture(t); f.importReport()
  f.sql.exec('CREATE TABLE zeitguru_row_checkpoints(userId TEXT,localEntryId TEXT,providerKey TEXT,rowCipher TEXT)')
  f.sql.prepare('INSERT INTO zeitguru_row_checkpoints VALUES(?,?,?,?)').run(user.id, 'native-1', createHash('sha256').update('tenant/private-provider-user').digest('hex'), encryptText(JSON.stringify({ id: row().sourceId }))!)
  const projection = f.accounting.projection(user.id, [native()])
  assert.equal(projection.entries.length, 0); assert.equal(projection.accounting!.days[0].workedMinutes, 450)
  assert.equal(projection.accounting!.warnings.some(value => value.code === 'native_source_overlap'), false)
  assert.equal(periodTotalsWithAccounting(user, [native()], [], [], '2026-09-01', '2026-09-01', projection.accounting).workedMinutes, 450)
})

test('unlinked native overlap is visible as review and is never double counted', t => {
  const f = fixture(t); f.importReport()
  const projection = f.accounting.projection(user.id, [native()])
  assert.equal(projection.entries.length, 0)
  assert.equal(projection.accounting!.days[0].workedMinutes, 450)
  assert.equal(projection.accounting!.warnings.some(value => value.code === 'native_source_overlap'), true)
})

test('native approved correction supersedes source work while retaining absence and adjustment credits and remains after undo', t => {
  const f = fixture(t), value = report([{ ...day('2026-09-01', 210), absenceMinutes: 240, correctionMinutes: 15, creditedMinutes: 465, exactDeltaMinutes: -15 }])
  const imported = f.importReport(value)
  const correction = native('2026-09-01', { source: 'approved_correction', stoppedAt: '2026-09-01T13:00:00+02:00', manualBreakMinutes: 0 })
  const before = structuredClone(correction), projection = f.accounting.projection(user.id, [correction])
  assert.equal(projection.entries.length, 0); assert.equal(projection.accounting!.days[0].workedMinutes, 240)
  assert.equal(projection.accounting!.days[0].absenceMinutes, 240); assert.equal(projection.accounting!.days[0].creditedMinutes, 495); assert.equal(projection.accounting!.days[0].exactDeltaMinutes, 15)
  assert.equal(projection.accounting!.warnings.some(value => value.code === 'native_correction_overrides_source'), true)
  f.history.undoBatch(user.id, imported.batch.id, imported.batch.fingerprint)
  assert.deepEqual(correction, before); assert.deepEqual(f.accounting.projection(user.id, [correction]), { entries: [] })
})

test('non-overlapping later native work is added once to a source day', t => {
  const f = fixture(t); f.importReport()
  const extra = native('2026-09-01', { startedAt: '2026-09-01T18:00:00+02:00', stoppedAt: '2026-09-01T19:00:00+02:00', manualBreakMinutes: 0 })
  const projection = f.accounting.projection(user.id, [extra])
  assert.equal(projection.entries.length, 1); assert.equal(projection.accounting!.days[0].workedMinutes, 510); assert.equal(projection.accounting!.days[0].exactDeltaMinutes, 30)
})

test('historical missing days and source problems are checked beyond 90 days with read-only source review actions', t => {
  const f = fixture(t), value = report([day('2024-06-03'), day('2024-06-04', 0)])
  f.importReport(value, [row('2024-06-03')])
  const projection = f.accounting.projection(user.id), issues = dayIssuesForUsers([user], projection.entries, [], [], new Date('2026-09-07T12:00:00'), { [user.id]: projection.accounting })
  const missing = issues.find(issue => issue.date === '2024-06-04' && issue.rule === 'missing_day')!
  assert.ok(missing); assert.equal(missing.expectedMinutes, 480); assert.equal(missing.source, 'zeitguru')
  assert.equal(missing.suggestions[0].action, 'time_correction'); assert.equal(missing.suggestions[0].draft?.reviewProposal,true)
  assert.equal(missing.suggestions.some(value=>value.action==='zeitguru_history'),true)
  assert.equal(issues.some(issue => issue.date < '2024-06-03'), false)
})

test('unknown opening excludes previous years; verified opening carries exactly once, including fractional daily quotas', () => {
  const days = [day('2025-12-31', 500, 480.125), day('2026-01-01', 470, 480.125)]
  const makeContext = (openingKnown: boolean): ZeitguruAccountingContext => {
    const value = report(days, { openingKnown, balanceBasis: openingKnown ? 'source_opening' : 'period_delta', openingBalanceMinutes: openingKnown ? 60 : 0 })
    return { ...value, batchId: 'batch', days: value.days.map(({ details: _details, ...rest }) => rest), warnings: [] }
  }
  const unknown = makeContext(false), known = makeContext(true)
  assert.equal(accountingCarryBefore(unknown, '2026-01-01'), 0)
  assert.equal(accountingCarryBefore(known, '2026-01-01'), 79.875)
  assert.equal(summaryForUser(user, [], [], [], new Date('2026-01-01T12:00:00'), [], unknown).year.plusMinusMinutes, -10)
  assert.equal(summaryForUser(user, [], [], [], new Date('2026-01-01T12:00:00'), [], known).year.plusMinusMinutes, 70)
})

test('source forecast supplies current daily targets without overwriting the native employment profile', t => {
  const f = fixture(t), value = report([day('2026-09-01')], { forecast: [{ date: '2026-09-07', expectedMinutes: 480 }] })
  f.importReport(value)
  const context = f.accounting.projection(user.id).accounting
  assert.equal(periodTotalsWithAccounting(user, [], [], [], '2026-09-07', '2026-09-07', context).expectedMinutes, 480)
  assert.equal(periodTotalsWithAccounting(user, [], [], [], '2026-09-07', '2026-09-07', context, { skipTodayUntilClosed: true, now: new Date('2026-09-07T12:00:00') }).expectedMinutes, 0)
  assert.equal(user.expectedWeeklyMinutes, 0)
  const changedUser = { ...user, employmentTerms: [{ id: 'later-explicit-term', effectiveFrom: '2026-09-07', expectedWeeklyMinutes: 1200, yearlyVacationDays: 0, createdAt: '2026-09-07T11:00:00Z' }] }
  assert.equal(periodTotalsWithAccounting(changedUser, [], [], [], '2026-09-07', '2026-09-07', context).expectedMinutes, 240)
  const explicitZero = { ...changedUser, employmentTerms: [{ ...changedUser.employmentTerms[0], expectedWeeklyMinutes: 0 }] }
  assert.equal(periodTotalsWithAccounting(explicitZero, [], [], [], '2026-09-07', '2026-09-07', context).expectedMinutes, 0)
})

test('overlapping source records retain the complete source ledger and expose the precise conflict date', t => {
  const f = fixture(t), value = report([day('2026-09-01', 480)])
  const imported = f.importReport(value, [row(), row('2026-09-01', { sourceId: 'other-overlapping-source', workedMinutes: 30, creditedMinutes: 30 })])
  assert.equal(imported.batch.conflicts, 1)
  const projection = f.accounting.projection(user.id)
  assert.equal(projection.entries.length, 1); assert.equal(projection.accounting!.days[0].workedMinutes, 480)
  assert.deepEqual(projection.accounting!.warnings.find(value => value.code === 'source_clock_conflict'), { date: '2026-09-01', code: 'source_clock_conflict' })
})

test('rounding is applied after period delta and verified prior carry are combined', () => {
  const value = report([day('2025-12-31', 0.49, 0), day('2026-01-01', 0, 0.51)], { openingKnown: true, balanceBasis: 'source_opening' })
  const context: ZeitguruAccountingContext = { ...value, batchId: 'batch', days: value.days.map(({ details: _details, ...rest }) => rest), warnings: [] }
  assert.equal(summaryForUser(user, [], [], [], new Date('2026-01-01T12:00:00'), [], context).year.plusMinusMinutes, 0)
})

test('source wall-clock worked minutes and real paid break remain distinct across DST', t => {
  const f = fixture(t), value = report([day('2026-03-29', 180, 0)])
  f.importReport(value, [row('2026-03-29', { startedAt: '2026-03-29T01:00:00+01:00', stoppedAt: '2026-03-29T04:00:00+02:00', breakMinutes: 30, workedMinutes: 180, creditedMinutes: 180 })])
  const projection = f.accounting.projection(user.id)
  assert.equal(entryWorkedMinutes(projection.entries[0]), 180); assert.equal(projection.entries[0].manualBreakMinutes, 30)
})

test('period worked time is physical attendance while unapproved source time contributes no credited balance', t => {
  const f = fixture(t), value = report([day('2026-09-01', 0)])
  f.importReport(value, [row('2026-09-01', { approved: false, creditedMinutes: 0 })])
  const projection = f.accounting.projection(user.id)
  const totals = periodTotalsWithAccounting(user, projection.entries, [], [], '2026-09-01', '2026-09-01', projection.accounting)
  assert.equal(totals.workedMinutes, 450); assert.equal(totals.expectedMinutes, 480); assert.equal(totals.plusMinusMinutes, -480)
  assert.equal(projection.accounting!.warnings.some(warning => warning.code === 'source_clock_unapproved'), true)
})

for (const approval of [true, false, null] as const) test(`automatic clock-out approval ${approval} controls review without changing imported evidence`, t => {
  const f = fixture(t), date = '2026-09-03'
  const value = report([day(date, 507)], { openingKnown: true, balanceBasis: 'source_opening', details: { historyReviewDays: [{ date, reason: 'automatic_clock_out' }] } })
  f.importReport(value, [row(date, { startedAt: `${date}T08:14:00+02:00`, stoppedAt: `${date}T18:30:00+02:00`, workedMinutes: 507, creditedMinutes: 507, breakMinutes: 109, approved: approval, details: { rawRow: { isAutoClockOut: true } } })])
  const raw = f.sql.prepare('SELECT * FROM zeitguru_history_rows').all()
  const projection = f.accounting.projection(user.id), context = projection.accounting!
  assert.equal(Boolean(context.days[0].approvedAutomaticClockOut), approval === true)
  assert.equal(context.warnings.filter(warning => warning.code.includes('automatic_clock_out')).length, approval === true ? 0 : 1)
  assert.equal(dayIssuesForUsers([user], projection.entries, [], [], new Date('2026-09-07T12:00:00Z'), { [user.id]: context }).some(issue => issue.date === date && issue.rule === 'zeitguru_history_review'), approval !== true)
  assert.equal(context.days[0].creditedMinutes, 507); assert.equal(context.days[0].exactDeltaMinutes, 27)
  assert.deepEqual(f.sql.prepare('SELECT * FROM zeitguru_history_rows').all(), raw)
})

test('approved automatic ends do not suppress independent source discrepancies or another unapproved automatic end', t => {
  const f = fixture(t), date = '2026-09-03'
  f.importReport(report([day(date, 450)], { openingKnown: true, balanceBasis: 'source_opening', details: { historyReviewDays: [{ date, reason: 'automatic_clock_out' }, { date, reason: 'credit_duration_mismatch' }] } }), [row(date, { details: { rawRow: { isAutoClockOut: true } } })])
  const context = f.accounting.projection(user.id).accounting!
  assert.deepEqual(context.warnings, [{ date, code: 'credit_duration_mismatch' }])
  const other = fixture(t)
  other.importReport(report([day(date, 450)], { openingKnown: true, balanceBasis: 'source_opening', details: { historyReviewDays: [{ date, reason: 'automatic_clock_out' }] } }), [
    row(date, { sourceId: 'morning', stoppedAt: `${date}T12:00:00+02:00`, workedMinutes: 180, breakMinutes: 0, creditedMinutes: 180, details: { rawRow: { isAutoClockOut: true } } }),
    row(date, { sourceId: 'afternoon', startedAt: `${date}T12:30:00+02:00`, workedMinutes: 270, breakMinutes: 0, creditedMinutes: 270, approved: false, details: { rawRow: { isAutoClockOut: true } } }),
  ])
  const mixed = other.accounting.projection(user.id).accounting!
  assert.equal(mixed.days[0].approvedAutomaticClockOut, undefined)
  assert.equal(mixed.warnings.filter(warning => warning.code === 'source_automatic_clock_out').length, 1)
  assert(mixed.warnings.some(warning => warning.code === 'source_clock_unapproved'))
})

test('initial-import reconstruction is read-only and its historical exception does not expand with later imports',t=>{
 const f=fixture(t),firstDate='2026-09-01',laterDate='2026-09-02'
 const long=(date:string)=>row(date,{startedAt:`${date}T08:00:00+02:00`,stoppedAt:`${date}T20:00:00+02:00`,workedMinutes:660,creditedMinutes:660,breakMinutes:60})
 f.importReport(report([day(firstDate,660)],{openingKnown:true,balanceBasis:'source_opening'}),[long(firstDate)])
 const second=f.importReport(report([day(firstDate,660),day(laterDate,660)],{openingKnown:true,balanceBasis:'source_opening'}),[long(firstDate),long(laterDate)],'request-later')
 f.sql.prepare('UPDATE zeitguru_history_batches SET createdAt=createdAt+1 WHERE id=?').run(second.batch.id)
 const overlay=new ZeitguruAccountingStore(f.path,{legacyVacationRule:true})
 try{
  const before=JSON.stringify(f.sql.prepare('SELECT * FROM zeitguru_history_rows ORDER BY id').all()),projection=overlay.projection(user.id),context=projection.accounting!
  assert.equal(context.initialImportReconstruction!.throughDate,firstDate)
  assert.equal(context.initialImportReconstruction!.days.length,1)
  assert.equal(context.initialImportReconstruction!.days[0].proposedMinutes,600)
  assert.equal(context.days[0].workedMinutes,660);assert.equal(context.days[1].workedMinutes,660)
  const issues=dayIssuesForUsers([user],projection.entries,[],[],new Date('2026-09-07T12:00:00Z'),{[user.id]:context})
  assert.equal(issues.find(i=>i.date===firstDate&&i.rule==='daily_ten_hour_limit')!.initialImportReview,true)
  assert.equal(issues.find(i=>i.date===laterDate&&i.rule==='daily_ten_hour_limit')!.initialImportReview,undefined)
  const proposal=issues.find(i=>i.rule==='zeitguru_import_reconstruction')!
  assert.equal(proposal.suggestions[0].draft!.reviewProposal,true)
  assert.equal(proposal.suggestions[0].draft!.proposedEndTime,'19:00')
  assert.equal(JSON.stringify(f.sql.prepare('SELECT * FROM zeitguru_history_rows ORDER BY id').all()),before)
 }finally{overlay.close()}
})
