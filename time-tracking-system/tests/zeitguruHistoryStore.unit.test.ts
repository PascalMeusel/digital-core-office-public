import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {test,type TestContext} from 'node:test'
import {ZeitguruHistoryStore,ZeitguruHistoryError,type ZeitguruHistoryInputRow,type ZeitguruHistoryImport} from '../server/zeitguruHistoryStore.ts'
import {encryptText} from '../server/fieldCrypto.ts'

function fixture(t:TestContext){
  const oldKey=process.env.DATA_ENCRYPTION_KEY,oldRequired=process.env.REQUIRE_DATA_ENCRYPTION
  process.env.DATA_ENCRYPTION_KEY='synthetic-encrypted-history-test-key'
  process.env.REQUIRE_DATA_ENCRYPTION='false'
  const directory=mkdtempSync(join(tmpdir(),'dco-zeitguru-history-')),path=join(directory,'time.sqlite')
  const now=Date.parse('2026-09-07T10:00:00Z'),store=new ZeitguruHistoryStore(path,{now:()=>now}),sql=new DatabaseSync(path)
  sql.exec("CREATE TABLE users(id TEXT PRIMARY KEY,trackingStartDate TEXT,balance INTEGER);CREATE TABLE time_entries(id TEXT PRIMARY KEY,value TEXT);INSERT INTO users VALUES('employee-1','2026-09-07',0);INSERT INTO time_entries VALUES('preexisting-native','untouched');")
  t.after(()=>{
    sql.close();store.close();rmSync(directory,{recursive:true,force:true})
    if(oldKey===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=oldKey
    if(oldRequired===undefined)delete process.env.REQUIRE_DATA_ENCRYPTION;else process.env.REQUIRE_DATA_ENCRYPTION=oldRequired
  })
  const row=(day='2026-09-01',overrides:Partial<ZeitguruHistoryInputRow>={}):ZeitguruHistoryInputRow=>({sourceId:`source-${day}`,date:day,startedAt:`${day}T09:00:00+02:00`,stoppedAt:`${day}T17:00:00+02:00`,breakMinutes:30,workedMinutes:450,creditedMinutes:450,approved:true,branchName:'Synthetic office',details:{rawRow:{privateHistoryNote:'private-history-test-note'}},...overrides})
  const input=(overrides:Partial<ZeitguruHistoryImport>={}):ZeitguruHistoryImport=>({userId:'employee-1',providerKey:'company/employee-1',expectedGeneration:0,clientRequestId:'import-1',fromDate:'2026-01-01',toDate:'2026-09-06',rows:[row()],...overrides})
  return {store,sql,path,row,input}
}
const code=(value:string)=>(error:unknown)=>error instanceof ZeitguruHistoryError&&error.code===value

test('one-shot history import encrypts source details and leaves native entries, employment baseline and balances unchanged',t=>{
  const f=fixture(t),before=f.sql.prepare('SELECT * FROM users').all(),native=f.sql.prepare('SELECT * FROM time_entries').all()
  const result=f.store.importBatch(f.input({rows:[f.row(),f.row('2026-09-02',{creditedMinutes:null,approved:null})]}))
  assert.equal(result.batch.added,2)
  assert.equal(result.status.totalRecords,2)
  assert.equal(result.status.totalWorkedMinutes,900)
  assert.equal(result.status.totalCreditedMinutes,450)
  assert.equal(result.status.uncreditedRecords,1)
  const page=f.store.listHistory('employee-1')
  assert.equal(page.rows[0].startTime,'09:00');assert.equal(page.rows[0].endTime,'17:00')
  assert.equal(page.rows[0].branchName,'Synthetic office')
  const visible=JSON.stringify({result,page})
  for(const secret of ['source-2026','private-history-test-note','rawRow','recordCipher'])assert.equal(visible.includes(secret),false)
  assert.equal(readFileSync(f.path).includes(Buffer.from('private-history-test-note')),false)
  assert.match(String(f.sql.prepare('SELECT recordCipher FROM zeitguru_history_rows LIMIT 1').get()!.recordCipher),/^enc:v1:/)
  assert.deepEqual(f.sql.prepare('SELECT * FROM users').all(),before)
  assert.deepEqual(f.sql.prepare('SELECT * FROM time_entries').all(),native)
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_list(zeitguru_history_rows)').all(),[])
})

test('encryption is mandatory even for empty history imports and optional global encryption',t=>{
  const f=fixture(t)
  delete process.env.DATA_ENCRYPTION_KEY
  assert.throws(()=>f.store.importBatch(f.input()),code('history_encryption_required'))
  assert.throws(()=>f.store.importBatch(f.input({rows:[]})),code('history_encryption_required'))
  assert.equal(f.store.status('employee-1').totalRecords,0)
})

test('idempotent requests and stable provider identifiers distinguish duplicates from credit or break conflicts',t=>{
  const f=fixture(t),original=f.store.importBatch(f.input())
  assert.deepEqual(f.store.importBatch(f.input()).batch,original.batch)
  assert.deepEqual(f.store.batchForRequest('employee-1','import-1'),original.batch)
  assert.equal(f.store.batchForRequest('employee-2','import-1'),undefined)
  assert.throws(()=>f.store.importBatch(f.input({rows:[f.row('2026-09-01',{creditedMinutes:440})]})),code('request_conflict'))
  const again=f.store.importBatch(f.input({clientRequestId:'import-2'}))
  assert.equal(again.batch.added,0);assert.equal(again.batch.duplicates,1)
  const changed=f.store.importBatch(f.input({clientRequestId:'import-3',rows:[f.row('2026-09-01',{creditedMinutes:440})]}))
  assert.equal(changed.batch.conflicts,1);assert.equal(changed.batch.added,0)
  const changedBreak=f.store.importBatch(f.input({clientRequestId:'import-4',rows:[f.row('2026-09-01',{breakMinutes:60,workedMinutes:420})]}))
  assert.equal(changedBreak.batch.conflicts,1)
  assert.equal(f.store.listHistory('employee-1').rows[0].creditedMinutes,450)
  assert.equal(f.store.status('employee-1').lastImport?.id,changedBreak.batch.id)
})

test('changed intervals conflict with existing archive rows while own-user scope stays isolated',t=>{
  const f=fixture(t);f.store.importBatch(f.input())
  const overlap=f.store.importBatch(f.input({clientRequestId:'overlap',rows:[f.row('2026-09-01',{sourceId:'different-id',stoppedAt:'2026-09-01T18:00:00+02:00'})]}))
  assert.equal(overlap.batch.conflicts,1);assert.equal(overlap.batch.added,0)
  const other=f.store.importBatch(f.input({userId:'employee-2',providerKey:'company/employee-2'}))
  assert.equal(other.batch.added,1)
  assert.equal(f.store.status('employee-1').totalRecords,1)
  assert.equal(f.store.status('employee-2').totalRecords,1)
  assert.throws(()=>f.store.undoBatch('employee-2',overlap.batch.id,overlap.batch.fingerprint),code('history_batch_missing'))
})

test('generation is checked inside import transaction including disconnected connections',t=>{
  const f=fixture(t)
  f.sql.exec("CREATE TABLE zeitguru_connections(userId TEXT PRIMARY KEY,generation INTEGER,enabled INTEGER);INSERT INTO zeitguru_connections VALUES('employee-1',3,0)")
  assert.throws(()=>f.store.importBatch(f.input()),code('connection_changed'))
  assert.equal(f.store.status('employee-1').totalRecords,0)
  assert.equal(f.store.importBatch(f.input({expectedGeneration:3})).batch.added,1)
  f.sql.prepare('UPDATE zeitguru_connections SET generation=4').run()
  assert.throws(()=>f.store.importBatch(f.input({clientRequestId:'stale',expectedGeneration:3})),code('connection_changed'))
})

test('closed historical range excludes today, open/overnight-to-today rows and invalid source values',t=>{
  const f=fixture(t)
  assert.throws(()=>f.store.importBatch(f.input({toDate:'2026-09-07'})),code('invalid_history'))
  assert.throws(()=>f.store.importBatch(f.input({rows:[f.row('2026-09-06',{stoppedAt:'2026-09-07T00:01:00+02:00'})]})),code('invalid_history'))
  assert.throws(()=>f.store.importBatch(f.input({rows:[f.row('2026-09-01',{stoppedAt:''})]})),code('invalid_history'))
  assert.throws(()=>f.store.importBatch(f.input({rows:[f.row('2026-09-01',{breakMinutes:-1})]})),code('invalid_history'))
  assert.throws(()=>f.store.importBatch(f.input({fromDate:'2026-02-31'})),code('invalid_history'))
  assert.equal(f.store.status('employee-1').totalRecords,0)
})

test('archive preserves source wall-clock totals across DST instead of substituting UTC elapsed',t=>{
  const f=fixture(t)
  f.store.importBatch(f.input({rows:[f.row('2026-03-29',{startedAt:'2026-03-29T01:00:00+01:00',stoppedAt:'2026-03-29T04:00:00+02:00',breakMinutes:0,workedMinutes:180,creditedMinutes:180})]}))
  const row=f.store.listHistory('employee-1').rows[0]
  assert.equal((Date.parse(row.stoppedAt)-Date.parse(row.startedAt))/60_000,120)
  assert.equal(row.workedMinutes,180)
})

test('fractional source credit is preserved as evidence rather than rounded or replaced by worked time',t=>{
  const f=fixture(t)
  const result=f.store.importBatch(f.input({rows:[f.row('2026-09-01',{creditedMinutes:449.5})]}))
  assert.equal(result.status.totalCreditedMinutes,449.5)
  assert.equal(f.store.listHistory('employee-1').rows[0].creditedMinutes,449.5)
})

test('zero-hour automatic closures and sanitized source warnings remain historical evidence',t=>{
  const f=fixture(t)
  const result=f.store.importBatch(f.input({rows:[f.row('2026-09-01',{stoppedAt:'2026-09-01T09:00:00+02:00',breakMinutes:0,workedMinutes:0,creditedMinutes:0,approved:false,details:{rawRow:{isAutoClockOut:true}}})],skipped:{count:1,reasons:['automatic_clock_out','credit_duration_mismatch','unfinished_clock_row','private-provider-response']}}))
  assert.equal(result.batch.added,1)
  assert.equal(result.status.totalWorkedMinutes,0)
  assert.deepEqual(result.batch.warnings,['automatic_clock_out','credit_duration_mismatch','unfinished_clock_row','provider_omitted'])
})

test('stable pagination and date filters neither duplicate nor expose other employees records',t=>{
  const f=fixture(t)
  f.store.importBatch(f.input({rows:[f.row('2026-09-01'),f.row('2026-09-02'),f.row('2026-09-03')]}))
  const first=f.store.listHistory('employee-1',{limit:2}),second=f.store.listHistory('employee-1',{limit:2,cursor:first.nextCursor})
  assert.deepEqual([...first.rows,...second.rows].map(row=>row.date),['2026-09-03','2026-09-02','2026-09-01'])
  assert.equal(second.nextCursor,undefined)
  assert.deepEqual(f.store.listHistory('employee-1',{fromDate:'2026-09-02',toDate:'2026-09-02'}).rows.map(row=>row.date),['2026-09-02'])
  assert.equal(f.store.listHistory('employee-2',{cursor:first.nextCursor}).rows.length,0)
  assert.throws(()=>f.store.listHistory('employee-1',{cursor:'invalid'}),code('invalid_history'))
})

test('undo deletes only this batch inserts and retains preexisting, later and duplicate records plus its audit batch',t=>{
  const f=fixture(t),first=f.store.importBatch(f.input())
  const middle=f.store.importBatch(f.input({clientRequestId:'middle',rows:[f.row(),f.row('2026-09-02')]}))
  const later=f.store.importBatch(f.input({clientRequestId:'later',rows:[f.row('2026-09-03')]}))
  const undone=f.store.undoBatch('employee-1',middle.batch.id,middle.batch.fingerprint)
  assert.equal(undone.batch.undone,true);assert.equal(undone.batch.canUndo,false)
  assert.deepEqual(f.store.listHistory('employee-1').rows.map(row=>row.date),['2026-09-03','2026-09-01'])
  assert.equal(f.store.listBatches('employee-1').length,3)
  assert.deepEqual(f.store.undoBatch('employee-1',middle.batch.id,middle.batch.fingerprint).batch,undone.batch)
  assert.equal(f.store.batchForRequest('employee-1','middle')?.undone,true)
  assert.equal(f.store.importBatch(f.input({clientRequestId:'new-id',rows:[f.row('2026-09-02')]})).batch.added,1)
  assert.equal(f.store.listBatches('employee-1').some(batch=>batch.id===first.batch.id),true)
  assert.equal(f.store.listBatches('employee-1').some(batch=>batch.id===later.batch.id),true)
})

test('undo rejects later content changes atomically and import rollback leaves no orphan history rows',t=>{
  const f=fixture(t),result=f.store.importBatch(f.input({rows:[f.row(),f.row('2026-09-02')]}))
  const stored=f.sql.prepare('SELECT id,recordCipher FROM zeitguru_history_rows ORDER BY date DESC LIMIT 1').get()!
  assert.throws(()=>f.store.undoBatch('employee-1',result.batch.id,'wrong'),code('history_conflict'))
  f.sql.prepare('UPDATE zeitguru_history_rows SET recordCipher=? WHERE id=?').run(encryptText(JSON.stringify(f.row('2026-09-02',{workedMinutes:420}))),stored.id)
  assert.throws(()=>f.store.undoBatch('employee-1',result.batch.id,result.batch.fingerprint),code('history_changed_after_import'))
  assert.equal(f.store.status('employee-1').totalRecords,2)
  f.sql.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON zeitguru_history_batches BEGIN SELECT RAISE(ABORT,'Synthetic import failure'); END")
  assert.throws(()=>f.store.importBatch(f.input({clientRequestId:'failed',rows:[f.row('2026-09-03')]})),code('history_storage_unavailable'))
  assert.equal(f.store.status('employee-1').totalRecords,2)
  assert.equal(f.store.batchForRequest('employee-1','failed'),undefined)
})
