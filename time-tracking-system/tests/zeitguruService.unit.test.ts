import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { test, type TestContext } from 'node:test'
import { ZeitguruStore, type ZeitguruClockAction, type ZeitguruJsonRecord } from '../server/zeitguruStore.ts'
import { ZeitguruService, ZeitguruBridgeError, zeitguruPublicError, type ZeitguruProvider, type ZeitguruReadyConnection, type ZeitguruDeliveryPlan } from '../server/zeitguruService.ts'
import { ZeitguruProtocolError } from '../server/zeitguruProtocol.ts'
import { ZeitguruClientError } from '../server/zeitguruClient.ts'

test('provider data errors retain a review classification instead of a false connection failure',()=>{
 const result=zeitguruPublicError(new ZeitguruProtocolError('unsupported_clock_row'))
 assert.equal(result.status,409);assert.equal(result.body.code,'unsupported_clock_row')
})

test('isolated historical records surface a review message without blocking current synchronization',async t=>{
 const f=fixture(t);await f.activate()
 f.provider.observe=async()=>[]
 f.provider.observationReviewDates=()=>['2026-09-21','2026-09-22']
 Object.assign(f.local,{synchronize:()=>false})
 const status=await f.service.synchronize(f.state.user.id)
 assert.equal(status.requiresAttention,false);assert.match(status.synchronization!.error!,/2026-09-22/)
 assert.equal(f.state.writes.length,0)
 f.provider.observationReviewDates=()=>[]
 assert.equal((await f.service.synchronize(f.state.user.id)).synchronization!.error,undefined)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no })
  return {promise,resolve,reject}
}
async function settled() { for (let i=0;i<12;i++) await nextTurn() }
async function signalled<T>(promise:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try { return await Promise.race([promise,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic provider stage was not reached')),5000)})]) }
  finally { clearTimeout(timer) }
}
function code(value: string) { return (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === value) }
function fixture(t: TestContext) {
  const priorKey = process.env.DATA_ENCRYPTION_KEY, priorRequired = process.env.REQUIRE_DATA_ENCRYPTION
  process.env.DATA_ENCRYPTION_KEY = 'synthetic-zeitguru-service-encryption-key'
  process.env.REQUIRE_DATA_ENCRYPTION = 'true'
  const directory = mkdtempSync(join(tmpdir(),'dco-zeitguru-service-')), path = join(directory,'time.sqlite')
  let now = 1_800_000_000_000
  const journal = new ZeitguruStore(path,{now:()=>now}), sql = new DatabaseSync(path)
  const state = {
    user:{id:'employee-1',email:'employee@example.test',active:true,mustChangePassword:false}, localStopped:true,
    connection:{auth:{token:'private-access-token'},config:{tenant:'private-tenant'},providerKey:'tenant/employee',identity:{name:'Synthetic Employee',email:'employee@example.test'},branches:[{id:'office',name:'Office'},{id:'other',name:'Other'}],remoteStatus:'off_work'} as ZeitguruReadyConnection,
    remoteRow:null as ZeitguruJsonRecord|null, remoteCredit:null as number|null,
    logins:0,refreshes:0,plans:[] as ZeitguruDeliveryPlan[],writes:[] as ZeitguruDeliveryPlan[],evidenceReads:0,
    loginHook:undefined as (()=>Promise<ZeitguruReadyConnection>)|undefined,
    refreshHook:undefined as (()=>Promise<ZeitguruReadyConnection>)|undefined,
    writeHook:undefined as ((plan:ZeitguruDeliveryPlan)=>Promise<void>)|undefined,
    evidenceHook:undefined as ((plan:ZeitguruDeliveryPlan)=>Promise<{desired:boolean;expected:boolean}>)|undefined,
  }
  const same = isDeepStrictEqual
  const provider:ZeitguruProvider = {
    async login() { state.logins++; return state.loginHook ? state.loginHook() : structuredClone(state.connection) },
    async refresh() { state.refreshes++; return state.refreshHook ? state.refreshHook() : structuredClone(state.connection) },
    async plan(_connection,_config,intent,checkpoint) {
      const desiredRow = {id:'remote-clock',action:intent.action,step:intent.step}
      const plan:ZeitguruDeliveryPlan = {localEntryId:String(intent.localEntryId),expectedRow:checkpoint??null,desiredRow,expectedCredit:checkpoint?.step??null,desiredCredit:intent.step,patch:{row:desiredRow,credit:intent.step}}
      state.plans.push(structuredClone(plan)); return plan
    },
    async evidence(_connection,plan) {
      state.evidenceReads++
      if (state.evidenceHook) return state.evidenceHook(plan)
      return {desired:same(state.remoteRow,plan.desiredRow)&&state.remoteCredit===plan.desiredCredit,expected:same(state.remoteRow,plan.expectedRow)&&state.remoteCredit===plan.expectedCredit}
    },
    async write(_connection,plan) {
      // A write must never start until the journal has durably encrypted its complete plan.
      assert.ok(sql.prepare("SELECT 1 FROM zeitguru_operations WHERE status='sending' AND planCipher LIKE 'enc:v1:%'").get())
      state.writes.push(structuredClone(plan))
      if (state.writeHook) return state.writeHook(plan)
      state.remoteRow=structuredClone(plan.desiredRow);state.remoteCredit=Number(plan.desiredCredit)
    },
  }
  const local = {user:(id:string)=>id===state.user.id?state.user:undefined,isClockedOut:()=>state.localStopped,changed:()=>{}}
  const service = new ZeitguruService(journal,provider,local,()=>now)
  function enqueue(action:ZeitguruClockAction='start_work', step=1, occurredAt=now) {
    const input = {userId:state.user.id,clientOperationId:`request-${step}`,expectedGeneration:journal.status(state.user.id).generation,expectedRevision:journal.getClockRevision(state.user.id),action,request:{action,step}}
    sql.exec('BEGIN IMMEDIATE')
    try {
      const result = journal.withClockOperation(sql,input,()=>({action,step,localEntryId:'local-entry',occurredAt:new Date(occurredAt).toISOString()}))
      sql.exec('COMMIT');return result.operation
    } catch(error) {sql.exec('ROLLBACK');throw error}
  }
  async function challenge() { return service.login(state.user.id,{email:state.user.email,password:'private-password'}) }
  async function activate() {
    const pending = await challenge()
    return service.connect(state.user.id,{challengeId:pending.challengeId,branchId:'office',consent:true,expectedGeneration:journal.status(state.user.id).generation})
  }
  t.after(async()=>{
    await settled();sql.close();journal.close();rmSync(directory,{recursive:true,force:true})
    if(priorKey===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=priorKey
    if(priorRequired===undefined)delete process.env.REQUIRE_DATA_ENCRYPTION;else process.env.REQUIRE_DATA_ENCRYPTION=priorRequired
  })
  return {journal,sql,state,service,provider,local,enqueue,activate,challenge,advance:(ms:number)=>{now+=ms},time:()=>now}
}

test('overlapping background and clock checks share one synchronization without starting a provider write',async t=>{
  const f=fixture(t);await f.activate()
  const started=deferred<void>(),release=deferred<ZeitguruReadyConnection>()
  let observations=0,merges=0
  f.provider.observe=async()=>{observations++;return []}
  Object.assign(f.local,{synchronize:()=>{merges++;return false}})
  const refreshes=f.state.refreshes,before=f.journal.status(f.state.user.id)
  f.state.refreshHook=()=>{started.resolve();return release.promise}
  const background=f.service.synchronize(f.state.user.id)
  await signalled(started.promise)
  const clockCheck=f.service.synchronize(f.state.user.id)
  const results=Promise.allSettled([background,clockCheck])
  assert.equal(f.state.refreshes,refreshes+1)
  assert.equal(merges,0)
  release.resolve(structuredClone(f.state.connection))
  const completed=await results
  assert.deepEqual(completed.map(result=>result.status),['fulfilled','fulfilled'])
  assert.deepEqual(completed[0],completed[1])
  assert.equal(observations,1);assert.equal(merges,1)
  assert.deepEqual(f.journal.status(f.state.user.id),before)
  assert.equal(f.state.writes.length,0)
  f.state.refreshHook=undefined
  await f.service.synchronize(f.state.user.id)
  assert.equal(f.state.refreshes,refreshes+2,'a completed check is not cached for the next clock action')
  assert.equal(observations,2);assert.equal(merges,2)
})

test('overlapping checks share a provider failure without retrying and a later explicit check can recover',async t=>{
  const f=fixture(t);await f.activate()
  const started=deferred<void>(),release=deferred<ZeitguruReadyConnection>()
  let merges=0
  f.provider.observe=async()=>[]
  Object.assign(f.local,{synchronize:()=>{merges++;return false}})
  const refreshes=f.state.refreshes
  f.state.refreshHook=()=>{started.resolve();return release.promise}
  const background=f.service.synchronize(f.state.user.id)
  await signalled(started.promise)
  const results=Promise.allSettled([background,f.service.synchronize(f.state.user.id)])
  const failure=new Error('Synthetic provider timeout')
  release.reject(failure)
  for(const result of await results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason,failure)}
  assert.equal(f.state.refreshes,refreshes+1)
  assert.equal(merges,0);assert.equal(f.state.writes.length,0)
  assert.match(f.service.status(f.state.user.id).synchronization!.error!,/could not be synchronized/)
  f.state.refreshHook=undefined
  const recovered=await f.service.synchronize(f.state.user.id)
  assert.equal(recovered.synchronization?.error,undefined)
  assert.equal(f.state.refreshes,refreshes+2);assert.equal(merges,1)
  assert.equal(f.state.writes.length,0)
})

test('shared synchronization retains exclusion against connection and history operations',async t=>{
  const f=fixture(t);await f.activate()
  const challenge=await f.challenge(),started=deferred<void>(),release=deferred<ZeitguruReadyConnection>()
  f.provider.observe=async()=>[]
  Object.assign(f.local,{synchronize:()=>false})
  f.state.refreshHook=()=>{started.resolve();return release.promise}
  const background=f.service.synchronize(f.state.user.id)
  await signalled(started.promise)
  await assert.rejects(f.service.connect(f.state.user.id,{challengeId:challenge.challengeId,branchId:'office',consent:true,expectedGeneration:1}),code('connection_busy'))
  await assert.rejects(f.service.withHistoryAccount(f.state.user.id,1,undefined,async()=>undefined),code('connection_busy'))
  await assert.rejects(f.challenge(),code('rate_limited'))
  release.resolve(structuredClone(f.state.connection));await background
  f.state.refreshHook=undefined
  const historyStarted=deferred<void>(),historyRelease=deferred<void>()
  const history=f.service.withHistoryAccount(f.state.user.id,1,undefined,async()=>{historyStarted.resolve();await historyRelease.promise})
  await signalled(historyStarted.promise)
  await assert.rejects(f.service.synchronize(f.state.user.id),code('connection_busy'),'history work must not be joined as if it were synchronization')
  historyRelease.resolve();await history
  assert.equal((await f.service.synchronize(f.state.user.id)).enabled,true)
  assert.equal(f.state.writes.length,0)
})

test('shared synchronization does not bypass account and connection changes while refresh is pending',async t=>{
  for(const change of ['inactive','email','disconnect'] as const)await t.test(change,async child=>{
    const f=fixture(child);await f.activate()
    const started=deferred<void>(),release=deferred<ZeitguruReadyConnection>()
    let merges=0
    f.provider.observe=async()=>[]
    Object.assign(f.local,{synchronize:()=>{merges++;return false}})
    f.state.refreshHook=()=>{started.resolve();return release.promise}
    const background=f.service.synchronize(f.state.user.id)
    await signalled(started.promise)
    const results=Promise.allSettled([background,f.service.synchronize(f.state.user.id)])
    if(change==='inactive')f.state.user.active=false
    else if(change==='email')f.state.user.email='changed@example.test'
    else f.service.disconnect(f.state.user.id,1)
    release.resolve(structuredClone(f.state.connection))
    const expected=change==='inactive'?'account_unavailable':'identity_mismatch'
    for(const result of await results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.ok(code(expected)(result.reason))}
    assert.equal(merges,0);assert.equal(f.state.writes.length,0)
    if(change==='disconnect')assert.equal(f.journal.status(f.state.user.id).enabled,false)
  })
})

test('sign-in permits only the active company employee own email and rejects provider identity substitution',async t=>{
  const f=fixture(t)
  await assert.rejects(f.service.login('employee-1',{email:'other@example.test',password:'secret'}),code('identity_mismatch'))
  f.state.user.email='employee@example.org'
  await assert.rejects(f.challenge(),code('account_unavailable'))
  f.state.user.email='employee@example.test';f.state.user.active=false
  await assert.rejects(f.challenge(),code('account_unavailable'))
  f.state.user.active=true;f.state.user.mustChangePassword=true
  await assert.rejects(f.challenge(),code('account_unavailable'))
  f.state.user.mustChangePassword=false
  assert.equal(f.state.logins,0)
  f.state.connection.identity.email='other@example.test'
  await assert.rejects(f.challenge(),code('identity_mismatch'))
  assert.equal(f.journal.status('employee-1').enabled,false)
})

test('a delayed login challenge cannot resurrect a disconnected generation',async t=>{
  const f=fixture(t),gate=deferred<ZeitguruReadyConnection>()
  f.state.loginHook=()=>gate.promise
  const body={email:f.state.user.email,password:'private-password'}
  const login=f.service.login('employee-1',body)
  const rejection=assert.rejects(login,code('connection_changed'))
  f.service.disconnect('employee-1',0)
  gate.resolve(structuredClone(f.state.connection));await rejection
  assert.equal('password' in body,false)
  assert.equal(f.journal.status('employee-1').generation,1)
  assert.equal(f.journal.status('employee-1').enabled,false)
})

test('activation requires consent, available branch and both clocks stopped, then consumes its challenge',async t=>{
  const f=fixture(t),pending=await f.challenge()
  const body={challengeId:pending.challengeId,branchId:'office',consent:true,expectedGeneration:0}
  await assert.rejects(f.service.connect('employee-1',{...body,consent:false}),code('invalid_input'))
  await assert.rejects(f.service.connect('employee-1',{...body,branchId:'missing'}),code('branch_unavailable'))
  f.state.localStopped=false
  await assert.rejects(f.service.connect('employee-1',body),code('shift_running'))
  f.state.localStopped=true;f.state.connection.remoteStatus='working'
  await assert.rejects(f.service.connect('employee-1',body),code('shift_running'))
  f.state.connection.remoteStatus='off_work'
  assert.equal((await f.service.connect('employee-1',body)).enabled,true)
  await assert.rejects(f.service.connect('employee-1',body),code('challenge_expired'))
  const visible=JSON.stringify(f.service.status('employee-1'))
  for(const secret of ['private-access-token','private-password','private-tenant','authCipher','planCipher'])assert.equal(visible.includes(secret),false)
})

test('all four ordinary actions deliver in order with a saved plan before each write and confirmed checkpoints',async t=>{
  const f=fixture(t);await f.activate()
  const actions:ZeitguruClockAction[]=['start_work','start_break','stop_break','stop_work']
  actions.forEach((action,index)=>f.enqueue(action,index+1))
  f.service.kick();await settled()
  assert.deepEqual(f.state.writes.map(plan=>plan.desiredRow.action),actions)
  assert.equal(f.journal.status('employee-1').counts.confirmed,4)
  assert.deepEqual(f.journal.lastConfirmedRow('employee-1','local-entry'),f.state.remoteRow)
  assert.throws(()=>f.enqueue('manual_correction' as ZeitguruClockAction,5),code('invalid_input'))
  assert.throws(()=>f.enqueue('auto_clockout' as ZeitguruClockAction,6),code('invalid_input'))
  assert.equal(f.state.writes.length,4)
})

test('a transient break-end preflight read retries the exact saved plan with rotated authentication and one write',async t=>{
  const f=fixture(t);await f.activate()
  f.enqueue();f.enqueue('start_break',2);f.service.kick();await settled()
  assert.equal(f.state.writes.length,2)
  t.mock.timers.enable({apis:['setTimeout']})
  const refreshInputs:ZeitguruJsonRecord[]=[]
  const refresh=f.provider.refresh
  f.provider.refresh=async(auth,config)=>{refreshInputs.push(structuredClone(auth));return refresh(auth,config)}
  f.state.connection.auth={token:'rotated-before-read-failure'}
  let savedPlan:ZeitguruDeliveryPlan|undefined
  f.state.evidenceHook=async plan=>{
    savedPlan=structuredClone(plan)
    f.state.evidenceHook=undefined
    throw new ZeitguruClientError('provider_timeout')
  }
  const operation=f.enqueue('stop_break',3);f.service.kick();await settled()
  assert.equal(f.journal.operation('employee-1',operation.clientOperationId)?.status,'sending')
  assert.ok(f.sql.prepare('SELECT planCipher FROM zeitguru_operations WHERE id=?').get(operation.id)?.planCipher)
  assert.equal(f.state.writes.length,2)
  f.advance(1000);t.mock.timers.tick(1000);await settled()
  assert.deepEqual(refreshInputs,[{token:'private-access-token'},{token:'rotated-before-read-failure'}])
  assert.equal(f.state.plans.length,3,'the failed preflight must not allocate a replacement plan')
  assert.equal(f.state.writes.length,3,'the break end is written exactly once')
  assert.deepEqual(f.state.writes[2],savedPlan)
  assert.equal(f.state.writes[2].desiredRow.action,'stop_break')
  assert.equal(f.journal.operation('employee-1',operation.clientOperationId)?.status,'confirmed')
  assert.equal(f.journal.operation('employee-1',operation.clientOperationId)?.createdAt,operation.createdAt)
  assert.equal(f.journal.status('employee-1').requiresAttention,false)
})

test('transient preflight reads are bounded and retain a distinct safe diagnosis without replaying later',async t=>{
  for(const failure of ['provider_timeout','provider_unavailable','provider_request_failed','rate_limited'])await t.test(failure,async child=>{
    const f=fixture(child);await f.activate();child.mock.timers.enable({apis:['setTimeout']})
    f.state.evidenceHook=async()=>{throw new ZeitguruClientError(failure)}
    const operation=f.enqueue();f.service.kick();await settled()
    assert.equal(f.state.evidenceReads,1)
    f.advance(1000);child.mock.timers.tick(1000);await settled()
    assert.equal(f.state.evidenceReads,2)
    f.advance(2000);child.mock.timers.tick(2000);await settled()
    assert.equal(f.state.evidenceReads,3);assert.equal(f.state.writes.length,0)
    const failed=f.journal.operation('employee-1',operation.clientOperationId)
    assert.equal(failed?.status,'reconciliation_required');assert.equal(failed?.errorCode,'preflight_unavailable')
    assert.equal(f.journal.unsentConflict('employee-1'),undefined)
    f.state.evidenceHook=undefined
    f.service.kick();await settled()
    await assert.rejects(f.service.reconcile('employee-1',operation.id),code('manual_check_required'))
    const restarted=new ZeitguruService(f.journal,f.provider,f.local,f.time)
    restarted.kick();await settled()
    assert.equal(f.state.writes.length,0,'exhausted/old operations remain read-back-only')
    assert.equal(f.state.plans.length,1)
  })
})

test('transient refresh and planning reads can recover before any delivery plan exists',async t=>{
  for(const stage of ['refresh','plan'])await t.test(stage,async child=>{
    const f=fixture(child);await f.activate();child.mock.timers.enable({apis:['setTimeout']})
    if(stage==='refresh')f.state.refreshHook=async()=>{
      f.state.refreshHook=undefined
      throw new ZeitguruClientError('provider_unavailable')
    }
    else {
      const plan=f.provider.plan
      f.provider.plan=async()=>{
        f.provider.plan=plan
        throw new ZeitguruClientError('provider_timeout')
      }
    }
    const operation=f.enqueue();f.service.kick();await settled()
    assert.equal(f.sql.prepare('SELECT planCipher FROM zeitguru_operations WHERE id=?').get(operation.id)?.planCipher,null)
    assert.equal(f.state.writes.length,0)
    f.advance(1000);child.mock.timers.tick(1000);await settled()
    assert.equal(f.state.plans.length,1);assert.equal(f.state.writes.length,1)
    assert.equal(f.journal.operation('employee-1',operation.clientOperationId)?.status,'confirmed')
  })
})

test('an early read retry that exceeds the freshness window cannot enter no-plan conflict recovery',async t=>{
  const f=fixture(t);await f.activate();t.mock.timers.enable({apis:['setTimeout']})
  f.state.refreshHook=async()=>{throw new ZeitguruClientError('provider_unavailable')}
  const operation=f.enqueue();f.service.kick();await settled()
  f.advance(120_001);t.mock.timers.tick(1000);await settled()
  assert.equal(f.journal.operation('employee-1',operation.clientOperationId)?.errorCode,'preflight_unavailable')
  assert.equal(f.journal.unsentConflict('employee-1'),undefined)
  assert.equal(f.state.plans.length,0);assert.equal(f.state.writes.length,0)
  f.state.refreshHook=undefined
  f.provider.observe=async()=>[];Object.assign(f.local,{synchronize:()=>false})
  await assert.rejects(f.service.synchronize('employee-1'),code('manual_check_required'))
  f.service.kick();await settled();assert.equal(f.state.writes.length,0)
})

test('real preflight conflicts and non-transient or unknown errors never retry',async t=>{
  for(const failure of ['conflict','permission','invalid-response','unknown'])await t.test(failure,async child=>{
    const f=fixture(child);await f.activate()
    f.state.evidenceHook=async()=>{
      if(failure==='conflict')return {desired:false,expected:false}
      if(failure==='permission')throw new ZeitguruClientError('permission_denied',403)
      if(failure==='invalid-response')throw new ZeitguruClientError('invalid_provider_response')
      throw Object.assign(new Error('private provider data'),{code:'provider_timeout'})
    }
    f.enqueue();f.service.kick();await settled()
    assert.equal(f.state.evidenceReads,1);assert.equal(f.state.writes.length,0)
    assert.equal(f.journal.status('employee-1').attentionOperation?.errorCode,'remote_conflict')
    assert.equal(JSON.stringify(f.service.status('employee-1')).includes('private provider data'),false)
  })
})

test('a provider-client 401 during preflight requests authentication without retrying or claiming a remote conflict',async t=>{
  const f=fixture(t);await f.activate()
  f.state.evidenceHook=async()=>{throw new ZeitguruClientError('authentication_required',401)}
  f.enqueue();f.service.kick();await settled()
  assert.equal(f.state.evidenceReads,1);assert.equal(f.state.writes.length,0)
  assert.equal(f.journal.status('employee-1').attentionOperation?.status,'authentication_required')
  assert.equal(f.journal.status('employee-1').attentionOperation?.errorCode,'authentication_required')
})

test('the same typed transport error after invoking a write never permits another write',async t=>{
  for(const stage of ['write','read-back'])await t.test(stage,async child=>{
    const f=fixture(child);await f.activate()
    if(stage==='write')f.state.writeHook=async()=>{throw new ZeitguruClientError('provider_timeout')}
    else f.state.evidenceHook=async()=>{
      if(f.state.writes.length)throw new ZeitguruClientError('provider_unavailable')
      return {desired:false,expected:true}
    }
    f.enqueue();f.service.kick();await settled()
    assert.equal(f.state.writes.length,1)
    assert.equal(f.journal.status('employee-1').attentionOperation?.errorCode,'delivery_ambiguous')
    f.service.kick();await settled();assert.equal(f.state.writes.length,1)
  })
})

test('read retries remain fenced by account, identity, generation, freshness and the original delivery lease',async t=>{
  for(const change of ['inactive','identity','disconnect','expired-event','expired-lease'])await t.test(change,async child=>{
    const f=fixture(child);await f.activate();child.mock.timers.enable({apis:['setTimeout']})
    f.state.evidenceHook=async()=>{
      f.state.evidenceHook=undefined
      throw new ZeitguruClientError('provider_unavailable')
    }
    f.enqueue();f.service.kick();await settled()
    if(change==='inactive')f.state.user.active=false
    if(change==='identity')f.state.connection.providerKey='another-provider'
    if(change==='disconnect')f.service.disconnect('employee-1',1)
    if(change==='expired-event')f.advance(120_001)
    if(change==='expired-lease')f.sql.prepare("UPDATE zeitguru_operations SET leaseExpiresAt=? WHERE status='sending'").run(f.time())
    f.advance(1000);child.mock.timers.tick(1000);await settled()
    assert.equal(f.state.evidenceReads,1);assert.equal(f.state.writes.length,0)
    assert.equal(f.journal.status('employee-1').requiresAttention,true)
  })
})

test('freshness and the exclusive lease are checked again after the final preflight read',async t=>{
  for(const change of ['event','lease'])await t.test(change,async child=>{
    const f=fixture(child);await f.activate()
    f.state.evidenceHook=async()=>{
      if(change==='event')f.advance(120_001)
      else f.sql.prepare("UPDATE zeitguru_operations SET leaseExpiresAt=? WHERE status='sending'").run(f.time())
      return {desired:false,expected:true}
    }
    f.enqueue();f.service.kick();await settled()
    assert.equal(f.state.writes.length,0)
    assert.equal(f.journal.status('employee-1').requiresAttention,true)
  })
})

test('an existing saved remote-conflict plan is never reclassified as a new transient failure or resent',async t=>{
  const f=fixture(t);await f.activate()
  f.state.evidenceHook=async()=>({desired:false,expected:false})
  const operation=f.enqueue();f.service.kick();await settled()
  const before=f.journal.operation('employee-1',operation.clientOperationId)
  assert.equal(before?.errorCode,'remote_conflict')
  f.state.evidenceHook=undefined
  f.provider.observe=async()=>[];Object.assign(f.local,{synchronize:()=>false})
  const restarted=new ZeitguruService(f.journal,f.provider,f.local,f.time)
  restarted.kick();await settled()
  await assert.rejects(restarted.synchronize('employee-1'),code('manual_check_required'))
  assert.deepEqual(f.journal.operation('employee-1',operation.clientOperationId),before)
  assert.equal(f.state.writes.length,0)
})

test('a timeout after starting delivery never retries automatically and blocks subsequent actions',async t=>{
  const f=fixture(t);await f.activate()
  f.state.writeHook=async()=>{throw new Error('Synthetic uncertain timeout with private-provider-body')}
  const first=f.enqueue();f.enqueue('start_break',2)
  f.service.kick();await settled()
  assert.equal(f.state.writes.length,1)
  assert.equal(f.journal.operation('employee-1','request-1')?.status,'reconciliation_required')
  assert.equal(f.journal.operation('employee-1','request-2')?.status,'queued')
  assert.equal(f.service.status('employee-1').attentionOperation?.id,first.id)
  f.service.kick();await settled();assert.equal(f.state.writes.length,1)
  await assert.rejects(f.service.reconcile('employee-1',first.id),code('manual_check_required'))
  assert.equal(f.state.writes.length,1)
  assert.equal(JSON.stringify(f.service.status('employee-1')).includes('private-provider-body'),false)
})

test('matching row with mismatched credited time is not confirmation; reconciliation needs both',async t=>{
  const f=fixture(t);await f.activate()
  f.state.writeHook=async plan=>{f.state.remoteRow=structuredClone(plan.desiredRow);f.state.remoteCredit=-1}
  const operation=f.enqueue();f.service.kick();await settled()
  assert.equal(f.service.status('employee-1').requiresAttention,true)
  assert.equal(f.journal.lastConfirmedRow('employee-1','local-entry'),undefined)
  await assert.rejects(f.service.reconcile('employee-1',operation.id),code('manual_check_required'))
  f.state.remoteCredit=1
  await f.service.reconcile('employee-1',operation.id);await settled()
  assert.equal(f.journal.operation('employee-1','request-1')?.status,'confirmed')
  assert.equal(f.state.writes.length,1)
})

test('disconnect during an in-flight write fences its completion and keeps unresolved history',async t=>{
  const f=fixture(t);await f.activate()
  const started=deferred<void>(),release=deferred<void>()
  f.state.writeHook=async plan=>{started.resolve();await release.promise;f.state.remoteRow=plan.desiredRow;f.state.remoteCredit=1}
  f.enqueue();f.service.kick();await signalled(started.promise)
  f.service.disconnect('employee-1',1)
  release.resolve();await settled()
  assert.equal(f.journal.operation('employee-1','request-1')?.status,'reconciliation_required')
  assert.equal(f.journal.readConnection('employee-1'),undefined)
  assert.equal(f.journal.lastConfirmedRow('employee-1','local-entry'),undefined)
  assert.equal(f.state.writes.length,1)
})

test('restart does not replay an old queue; even a later kick leaves old intent for review',async t=>{
  const f=fixture(t);await f.activate();f.enqueue()
  f.advance(1000)
  const restarted=new ZeitguruService(f.journal,f.provider,f.local,f.time)
  assert.equal(restarted.status('employee-1').requiresAttention,true,'startup exposes the restored queue before any new punch or network request')
  await settled();assert.equal(f.state.writes.length,0)
  restarted.kick();await settled()
  assert.equal(f.state.writes.length,0)
  assert.equal(f.journal.operation('employee-1','request-1')?.status,'reconciliation_required')
  assert.equal(f.state.plans.length,0)
})

test('manual review requires explicit acknowledgement and both clocks stopped; it never asserts delivery',async t=>{
  const f=fixture(t);await f.activate();f.enqueue()
  f.state.writeHook=async()=>{throw new Error('Synthetic timeout')}
  f.service.kick();await settled()
  await assert.rejects(f.service.acknowledgeReview('employee-1',1,false),code('invalid_input'))
  f.state.localStopped=false
  await assert.rejects(f.service.acknowledgeReview('employee-1',1,true),code('shift_running'))
  f.state.localStopped=true;f.state.connection.remoteStatus='working'
  await assert.rejects(f.service.acknowledgeReview('employee-1',1,true),code('shift_running'))
  f.state.connection.remoteStatus='off_work'
  const reviewed=await f.service.acknowledgeReview('employee-1',1,true)
  assert.equal(reviewed.generation,2)
  assert.equal(reviewed.requiresAttention,false)
  assert.equal(f.journal.operation('employee-1','request-1')?.status,'cancelled')
  assert.equal(f.journal.operation('employee-1','request-1')?.acknowledgement,undefined)
  assert.equal(f.state.writes.length,1)
})

test('active-shift reauthentication preserves provider reservation and branch rather than creating a new connection',async t=>{
  const f=fixture(t);await f.activate()
  f.state.localStopped=false;f.state.connection.remoteStatus='working'
  const pending=await f.challenge()
  assert.equal(pending.canActivate,true)
  const body={challengeId:pending.challengeId,branchId:'office',consent:true,expectedGeneration:1}
  await assert.rejects(f.service.connect('employee-1',{...body,branchId:'other'}),code('branch_changed'))
  assert.equal((await f.service.connect('employee-1',body)).generation,1)
  f.state.connection.providerKey='another-provider'
  const different=await f.challenge()
  assert.equal(different.canActivate,false)
  await assert.rejects(f.service.connect('employee-1',{...body,challengeId:different.challengeId,expectedGeneration:1}),code('shift_running'))
})

test('same-provider reauthentication preserves queued operations and their generation unchanged',async t=>{
  const f=fixture(t);await f.activate()
  const queued=f.enqueue(),before=f.journal.status('employee-1')
  f.state.localStopped=false;f.state.connection.remoteStatus='working'
  f.state.connection.auth={token:'fresh-reauthentication-token'}
  const pending=await f.challenge()
  const reauthenticated=await f.service.connect('employee-1',{challengeId:pending.challengeId,branchId:'office',consent:true,expectedGeneration:before.generation})
  assert.equal(reauthenticated.generation,before.generation)
  assert.equal(reauthenticated.clockRevision,before.clockRevision)
  assert.deepEqual(f.journal.operation('employee-1',queued.clientOperationId),queued)
  assert.equal(f.journal.operation('employee-1',queued.clientOperationId)?.status,'queued')
  assert.deepEqual(f.journal.readConnection('employee-1')?.auth,{token:'fresh-reauthentication-token'})
  assert.equal(f.state.writes.length,0)
})

test('deactivation while provider refresh is pending prevents delivery',async t=>{
  const f=fixture(t);await f.activate()
  const started=deferred<void>(),release=deferred<ZeitguruReadyConnection>()
  f.state.refreshHook=()=>{started.resolve();return release.promise}
  f.enqueue();f.service.kick();await signalled(started.promise)
  f.state.user.active=false;release.resolve(structuredClone(f.state.connection));await settled()
  assert.equal(f.state.writes.length,0)
  assert.equal(f.journal.status('employee-1').requiresAttention,true)
})

test('refresh cannot replace the reserved provider identity merely by retaining the same email',async t=>{
  const f=fixture(t);await f.activate()
  f.state.connection.providerKey='another-provider-with-same-email'
  f.enqueue();f.service.kick();await settled()
  assert.equal(f.state.writes.length,0)
  assert.equal(f.journal.status('employee-1').requiresAttention,true)
  assert.equal(f.journal.canReauthenticate('employee-1','tenant/employee'),true)
})

test('deactivation during the last provider preflight read prevents starting a write',async t=>{
  const f=fixture(t);await f.activate()
  const started=deferred<void>(),release=deferred<{desired:boolean;expected:boolean}>()
  f.state.evidenceHook=()=>{started.resolve();return release.promise}
  f.enqueue();f.service.kick();await signalled(started.promise)
  f.state.user.active=false;release.resolve({desired:false,expected:true});await settled()
  assert.equal(f.state.writes.length,0)
  assert.equal(f.journal.status('employee-1').requiresAttention,true)
})

test('public error mapping never exposes arbitrary provider responses or token material',()=>{
  const error=zeitguruPublicError(new Error('Authorization Bearer private-provider-token'))
  assert.equal(error.status,502)
  assert.equal(JSON.stringify(error).includes('private-provider-token'),false)
  assert.equal(zeitguruPublicError(new ZeitguruBridgeError('manual_check_required','Check the entry.')).body.code,'manual_check_required')
})

test('one-shot history account permits active clocks without activating forwarding or any provider write',async t=>{
  const f=fixture(t)
  f.state.localStopped=false;f.state.connection.remoteStatus='on_break'
  const challenge=await f.challenge(),before=f.journal.status('employee-1')
  assert.equal(challenge.canActivate,false)
  const result=await f.service.withHistoryAccount('employee-1',before.generation,challenge.challengeId,async(connection,assertCurrent)=>{
    assertCurrent();assert.equal(connection.remoteStatus,'on_break')
    assert.deepEqual(connection.auth,{token:'private-access-token'})
    return {importedRows:3}
  })
  assert.deepEqual(result,{importedRows:3})
  assert.deepEqual(f.journal.status('employee-1'),before)
  assert.equal(f.journal.readConnection('employee-1'),undefined)
  assert.equal(f.state.refreshes,1);assert.equal(f.state.writes.length,0);assert.equal(f.state.plans.length,0);assert.equal(f.state.evidenceReads,0)
  await assert.rejects(f.service.withHistoryAccount('employee-1',before.generation,challenge.challengeId,async()=>undefined),code('challenge_expired'))
  await assert.rejects(f.service.withHistoryAccount('employee-1',before.generation,undefined,async()=>undefined),code('authentication_required'))
})

test('saved history access rotates authentication but preserves the connection, clock revision and queued actions',async t=>{
  const f=fixture(t);await f.activate()
  const queued=f.enqueue(),before=f.journal.status('employee-1')
  f.state.localStopped=false;f.state.connection.remoteStatus='working';f.state.connection.auth={token:'rotated-history-token'}
  const result=await f.service.withHistoryAccount('employee-1',before.generation,undefined,async(connection,assertCurrent)=>{
    assertCurrent();assert.equal(connection.remoteStatus,'working');return 'read-only-result'
  })
  assert.equal(result,'read-only-result')
  assert.deepEqual(f.journal.status('employee-1'),before)
  assert.deepEqual(f.journal.operation('employee-1',queued.clientOperationId),queued)
  assert.deepEqual(f.journal.readConnection('employee-1')?.auth,{token:'rotated-history-token'})
  assert.equal(f.state.writes.length,0);assert.equal(f.state.plans.length,0);assert.equal(f.state.evidenceReads,0)
})

test('history challenges reject another user, stale generation and expiration before invoking the reader',async t=>{
  const f=fixture(t),challenge=await f.challenge();let callbacks=0
  const read=async()=>{callbacks++;return undefined}
  await assert.rejects(f.service.withHistoryAccount('employee-1',1,challenge.challengeId,read),code('connection_changed'))
  await assert.rejects(f.service.withHistoryAccount('employee-1',-1,challenge.challengeId,read),code('invalid_input'))
  f.state.user.id='employee-2'
  await assert.rejects(f.service.withHistoryAccount('employee-2',0,challenge.challengeId,read),code('challenge_expired'))
  f.state.user.id='employee-1'
  f.advance(3*60_000)
  await assert.rejects(f.service.withHistoryAccount('employee-1',0,challenge.challengeId,read),code('challenge_expired'))
  assert.equal(callbacks,0);assert.equal(f.state.refreshes,0);assert.equal(f.state.writes.length,0)
})

test('history callback guard rejects disconnect while a saved account read is pending',async t=>{
  const f=fixture(t);await f.activate()
  const entered=deferred<void>(),release=deferred<void>();let commitReached=false
  const reading=f.service.withHistoryAccount('employee-1',1,undefined,async(_connection,assertCurrent)=>{
    entered.resolve();await release.promise;assertCurrent();commitReached=true
  })
  await signalled(entered.promise)
  await assert.rejects(f.service.withHistoryAccount('employee-1',1,undefined,async()=>undefined),code('connection_busy'))
  f.service.disconnect('employee-1',1);release.resolve()
  await assert.rejects(reading,code('connection_changed'))
  assert.equal(commitReached,false);assert.equal(f.state.writes.length,0)
})

test('history callback guard rejects account changes and consumes the one-shot challenge on failure',async t=>{
  for(const change of ['inactive','password','email'] as const)await t.test(change,async child=>{
    const f=fixture(child),challenge=await f.challenge(),entered=deferred<void>(),release=deferred<void>()
    let commitReached=false
    const reading=f.service.withHistoryAccount('employee-1',0,challenge.challengeId,async(_connection,assertCurrent)=>{
      entered.resolve();await release.promise;assertCurrent();commitReached=true
    })
    await signalled(entered.promise)
    if(change==='inactive')f.state.user.active=false
    else if(change==='password')f.state.user.mustChangePassword=true
    else f.state.user.email='changed@example.test'
    release.resolve()
    await assert.rejects(reading,code(change==='email'?'identity_mismatch':'account_unavailable'))
    assert.equal(commitReached,false);assert.equal(f.state.writes.length,0)
    f.state.user.active=true;f.state.user.mustChangePassword=false;f.state.user.email='employee@example.test'
    await assert.rejects(f.service.withHistoryAccount('employee-1',0,challenge.challengeId,async()=>undefined),code('challenge_expired'))
  })
})

test('one-shot history refresh cannot swap the remote identity and consumes a failed challenge',async t=>{
  const f=fixture(t),challenge=await f.challenge();let callbacks=0
  f.state.connection.providerKey='another-provider-with-same-email'
  await assert.rejects(f.service.withHistoryAccount('employee-1',0,challenge.challengeId,async()=>{callbacks++}),code('identity_mismatch'))
  assert.equal(callbacks,0);assert.equal(f.journal.readConnection('employee-1'),undefined)
  f.state.connection.providerKey='tenant/employee'
  await assert.rejects(f.service.withHistoryAccount('employee-1',0,challenge.challengeId,async()=>{callbacks++}),code('challenge_expired'))
  assert.equal(f.state.writes.length,0)
})
