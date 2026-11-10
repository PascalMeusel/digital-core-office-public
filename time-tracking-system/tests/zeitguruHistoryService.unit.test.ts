import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test,type TestContext} from 'node:test'
import {ZeitguruHistoryStore} from '../server/zeitguruHistoryStore.ts'
import {ZeitguruHistoryService} from '../server/zeitguruHistoryService.ts'
import {ZeitguruBridgeError,type ZeitguruService,type ZeitguruReadyConnection} from '../server/zeitguruService.ts'
import type {readZeitguruHistory,ZeitguruHistoryResult} from '../server/zeitguruHistoryProvider.ts'
import type { readZeitguruAccounting } from '../server/zeitguruAccountingProvider.ts'

const requestId='request_synthetic_000001',secondRequestId='request_synthetic_000002'
const matches=(value:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code===value)
function fixture(t:TestContext){
  const oldKey=process.env.DATA_ENCRYPTION_KEY,oldRequired=process.env.REQUIRE_DATA_ENCRYPTION
  process.env.DATA_ENCRYPTION_KEY='synthetic-history-service-encryption-key'
  process.env.REQUIRE_DATA_ENCRYPTION='true'
  const directory=mkdtempSync(join(tmpdir(),'dco-history-service-'))
  const now=()=>Date.parse('2026-09-07T10:00:00Z'),store=new ZeitguruHistoryStore(join(directory,'time.sqlite'),{now})
  const connection:ZeitguruReadyConnection={auth:{idToken:'private-synthetic-token'},config:{binding:{userId:'provider-user',tenantId:'provider-company',accountId:'provider-account',role:'employee'}},providerKey:'provider-company:provider-user',identity:{name:'Synthetic',email:'employee@example.test'},branches:[],remoteStatus:'off_work'}
  const data:ZeitguruHistoryResult={fromDate:'2026-09-01',toDate:'2026-09-06',observedAt:'2026-09-07T10:00:00Z',skipped:{count:0,reasons:[]},warnings:[],rows:[{
    sourceId:'source-private-row',date:'2026-09-01',startedAt:'2026-09-01T07:00:00Z',stoppedAt:'2026-09-01T15:00:00Z',breakMinutes:30,workedMinutes:450,creditedMinutes:450,approved:true,autoClockOut:false,paidBreak:false,
    details:{rawRow:{id:'source-private-row',userId:'provider-user',date:'2026-09-01',startTime:'09:00',endTime:'17:00',branchId:'branch',breakMinutes:30},rawCredit:{C:450},warnings:[]},
  }]}
  const state={generation:0,active:true,authCalls:0,assertions:0,reads:0,accountingReads:0,accountingHook:undefined as (()=>Promise<void>|void)|undefined,hook:undefined as (()=>Promise<void>|void)|undefined}
  const bridge={journal:{status:()=>({generation:state.generation,enabled:false})},
    async withHistoryAccount(userId:string,generation:number,_challengeId:string|undefined,work:(connection:ZeitguruReadyConnection,assertCurrent:()=>void)=>Promise<unknown>){
      state.authCalls++
      if(userId!=='employee-1'||!state.active)throw new ZeitguruBridgeError('account_unavailable','Own active account required.',403)
      if(generation!==state.generation)throw new ZeitguruBridgeError('connection_changed','The account changed.')
      const assertCurrent=()=>{state.assertions++;if(!state.active||generation!==state.generation)throw new ZeitguruBridgeError('connection_changed','The account changed.')}
      return work(connection,assertCurrent)
    },
  } as unknown as ZeitguruService
  const reader:typeof readZeitguruHistory=async(_client,tokens,binding,throughDate)=>{
    state.reads++;assert.equal(tokens.idToken,'private-synthetic-token');assert.equal(binding.userId,'provider-user');assert.equal(throughDate,'2026-09-06')
    await state.hook?.();return structuredClone(data)
  }
  const accountingReader: typeof readZeitguruAccounting = async () => {
    state.accountingReads++; await state.accountingHook?.()
    return { fromDate: data.fromDate!, toDate: data.toDate, observedAt: data.observedAt, opening: { date: data.fromDate!, minutes: 0 }, openingKnown: false, balanceBasis: 'period_delta', openingBalanceMinutes: 0, closingBalanceMinutes: -30,
      days: Array.from({length:6}, (_,index) => ({date:`2026-09-0${index+1}`,expectedMinutes:index===0?480:0,workedMinutes:index===0?450:0,absenceMinutes:0,holidayMinutes:0,correctionMinutes:0,creditedMinutes:index===0?450:0,balanceMinutes:-30,exactDeltaMinutes:index===0?-30:0,details:{}})),
      contracts: [], forecast: [], warnings: [], details: {}, }
  }
  const service=new ZeitguruHistoryService(store,bridge,{reader,accountingReader,now})
  const importOwn=(overrides:Record<string,unknown>={})=>service.importHistory('employee-1',{clientRequestId:requestId,expectedGeneration:0,...overrides})
  t.after(()=>{
    store.close();rmSync(directory,{recursive:true,force:true})
    if(oldKey===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=oldKey
    if(oldRequired===undefined)delete process.env.REQUIRE_DATA_ENCRYPTION;else process.env.REQUIRE_DATA_ENCRYPTION=oldRequired
  })
  return{state,store,service,data,importOwn}
}

test('history service authenticates own account before reading and checks it again before an atomic commit',async t=>{
  const f=fixture(t)
  const result=await f.importOwn()
  assert.equal(f.state.authCalls,1);assert.equal(f.state.reads,1);assert.equal(f.state.assertions,1)
  assert.equal(result.batch.added,1);assert.equal(result.status.totalWorkedMinutes,450)
  assert.equal(result.status.connected,false,'A one-shot import must not enable clock forwarding')
  assert.equal(JSON.stringify(result).includes('private-synthetic-token'),false)
  assert.equal(JSON.stringify(result).includes('source-private-row'),false)
})

test('unauthorized identity and stale generation fail before any provider read',async t=>{
  const f=fixture(t)
  await assert.rejects(f.service.importHistory('employee-2',{clientRequestId:requestId,expectedGeneration:0}),matches('account_unavailable'))
  await assert.rejects(f.importOwn({expectedGeneration:1}),matches('connection_changed'))
  assert.equal(f.state.reads,0);assert.equal(f.store.status('employee-1').totalRecords,0)
})

test('account generation or activity changing during history download prevents every local import write',async t=>{
  const f=fixture(t)
  f.state.hook=()=>{f.state.generation=1}
  await assert.rejects(f.importOwn(),matches('connection_changed'))
  assert.equal(f.store.status('employee-1').totalRecords,0)
  assert.equal(f.store.batchForRequest('employee-1',requestId),undefined)
  f.state.generation=0;f.state.hook=()=>{f.state.active=false}
  await assert.rejects(f.importOwn({clientRequestId:secondRequestId}),matches('connection_changed'))
  assert.equal(f.store.listBatches('employee-1').length,0)
})

test('a later provider read failure leaves no partial archive and permits a subsequent retry',async t=>{
  const f=fixture(t)
  f.state.hook=async()=>{await Promise.resolve();throw new Error('Synthetic later-month read failure')}
  await assert.rejects(f.importOwn(),/Synthetic later-month read failure/)
  assert.equal(f.store.status('employee-1').totalRecords,0)
  assert.equal(f.store.listBatches('employee-1').length,0)
  f.state.hook=undefined
  assert.equal((await f.importOwn()).batch.added,1)
})

test('repeated request returns its original or undone receipt without authenticating or downloading again',async t=>{
  const f=fixture(t),first=await f.importOwn()
  f.state.active=false;f.state.generation=9
  const repeat=await f.importOwn()
  assert.deepEqual(repeat.batch,first.batch)
  assert.equal(f.state.authCalls,1);assert.equal(f.state.reads,1)
  const undone=f.service.undo('employee-1',{batchId:first.batch.id,expectedFingerprint:first.batch.fingerprint})
  assert.equal(undone.batch.undone,true)
  const repeatedUndo=await f.importOwn()
  assert.equal(repeatedUndo.batch.undone,true)
  assert.equal(f.state.authCalls,1);assert.equal(f.state.reads,1)
})

test('accounting read failure or changed identity cannot leave a partially imported archive', async t => {
  const f = fixture(t)
  f.state.accountingHook = () => { throw new Error('Incomplete accounting') }
  await assert.rejects(f.importOwn(), /Incomplete accounting/)
  assert.equal(f.store.status('employee-1').totalRecords, 0)
  assert.equal(f.store.listBatches('employee-1').length, 0)
  f.state.accountingHook = () => { f.state.generation++ }
  await assert.rejects(f.importOwn(), matches('connection_changed'))
  assert.equal(f.store.listBatches('employee-1').length, 0)
  f.state.generation = 0; f.state.accountingHook = undefined
  assert.equal((await f.importOwn()).batch.added, 1)
})

test('page and undo remain scoped to the authenticated local user, ignoring extra body target fields',async t=>{
  const f=fixture(t),own=await f.importOwn({userId:'employee-2'})
  assert.equal(f.service.page('employee-1').rows.length,1)
  assert.equal(f.service.page('employee-2').rows.length,0)
  assert.equal(f.service.page('employee-2').status.lastImport,undefined)
  assert.throws(()=>f.service.undo('employee-2',{batchId:own.batch.id,expectedFingerprint:own.batch.fingerprint}),matches('history_batch_missing'))
  assert.equal(f.service.page('employee-1').rows.length,1)
})

test('concurrent history imports and undo are rejected while a provider pull is unfinished',async t=>{
  const f=fixture(t)
  let release!:()=>void
  const blocked=new Promise<void>(resolve=>{release=resolve})
  f.state.hook=()=>blocked
  const pending=f.importOwn()
  await assert.rejects(f.importOwn({clientRequestId:secondRequestId}),matches('history_busy'))
  assert.throws(()=>f.service.undo('employee-1',{batchId:'synthetic_batch_1234',expectedFingerprint:'synthetic_fingerprint'}),matches('history_busy'))
  release();await pending
  assert.equal(f.store.status('employee-1').totalRecords,1)
})
