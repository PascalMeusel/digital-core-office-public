import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { planZeitguruRecovery } from '../server/zeitguruWebProvider.ts'
import type { ZeitguruSnapshot } from '../server/zeitguruProtocol.ts'
import type { ZeitguruUnsentClock } from '../server/zeitguruStore.ts'

const checkpoint = { id:'abc-clock',userId:'employee',branchId:'office',jobPositionId:'engineer',date:'2026-09-07',startTime:'07:32',breakMinutes:34,logS:'B_employee_123',branchId_date:'office_2026-09-07',userId_date:'employee_2026-09-07',breakActivities:[{type:'start' as const,time:'07:32'},{type:'end' as const,time:'08:06'}] }
const state: ZeitguruSnapshot = {
 binding:{tenantId:'company',userId:'employee',accountId:'account',role:'employee'},tenant:{id:'company',isV2:true},
 profile:{id:'employee',accountId:'account',role:'employee',branchIds:['office'],jobPositionIds:['engineer']},
 clockSettings:{allowUserTimClockInBrowser:true,breaksNeedToBeClocked:true,clockingsAreAutoApprovedV2:true},rosterSettings:{timezone:'Europe/Berlin',breakRules:[]},branches:[{id:'office',isClockingEnabled:true}],
 clockings:[{...checkpoint,breakMinutes:67,breakActivities:[...checkpoint.breakActivities,{type:'start',time:'12:16'},{type:'end',time:'12:49'}]}],credits:{'2026-09-06':{},'2026-09-07':{}},observedAt:'2026-09-07T12:00:00.000Z',fromDate:'2026-09-06',toDate:'2026-09-07',etags:{},
}
const unsent: ZeitguruUnsentClock[] = ['start_break','stop_break'].map((action,index)=>({id:`operation-${index}`,generation:1,status:index?'queued':'reconciliation_required',errorCode:index?null:'remote_conflict',payload:{localEntryId:'local-clock',action,occurredAt:`2026-09-07T11:01:${index?'29.741':'14.263'}Z`}}))

test('recovery retains outside lunch and original DCO punches, while excluding duplicates and conflicting history',()=>{
 const original=structuredClone(state),plans=planZeitguruRecovery(state,{branchId:'office'},unsent,checkpoint)
 assert.deepEqual(state,original)
 assert.equal(plans.length,2);assert.equal(plans[0].occurredAt,unsent[0].payload.occurredAt)
 assert.deepEqual(plans[0].expectedRow,state.clockings[0]);assert.deepEqual(plans[1].expectedRow,plans[0].desiredRow)
 assert.equal(plans[1].desiredRow.breakMinutes,67)
 assert.deepEqual(plans[1].desiredRow.breakActivities,[...state.clockings[0].breakActivities!,{type:'start',time:'13:01'},{type:'end',time:'13:01'}])
 assert.throws(()=>planZeitguruRecovery({...state,clockings:[plans[1].desiredRow as typeof checkpoint]},{branchId:'office'},unsent,checkpoint),'already delivered pair cannot be appended twice')
 assert.throws(()=>planZeitguruRecovery({...state,clockings:[{...state.clockings[0],startTime:'08:00'}]},{branchId:'office'},unsent,checkpoint))
 assert.throws(()=>planZeitguruRecovery({...state,clockings:[{...state.clockings[0],endTime:'13:30'}]},{branchId:'office'},unsent,checkpoint))
 assert.throws(()=>planZeitguruRecovery({...state,observedAt:'2026-09-09T12:00:00.000Z'},{branchId:'office'},unsent,checkpoint))
})

test('conflicted never-sent actions recover atomically, preserve seconds and confirm once after restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dco-zg-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const moduleUrl=(file:string)=>JSON.stringify(new URL('../server/'+file,import.meta.url).href)
 const script=`
 import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {setImmediate as tick} from 'node:timers/promises';import {isDeepStrictEqual as same} from 'node:util';
 const {readDatabase,writeDatabase,writeDatabaseAtomically}=await import(${moduleUrl('store.ts')});
 const {ZeitguruStore}=await import(${moduleUrl('zeitguruStore.ts')});
 const {ZeitguruService}=await import(${moduleUrl('zeitguruService.ts')});
 const {applyZeitguruLiveSync,applyZeitguruRebase}=await import(${moduleUrl('zeitguruLiveSync.ts')});
 const {observedZeitguruClock}=await import(${moduleUrl('zeitguruLiveClock.ts')});
 const {planZeitguruRecovery}=await import(${moduleUrl('zeitguruWebProvider.ts')});
 const checkpoint=${JSON.stringify(checkpoint)},snapshot=${JSON.stringify(state)},intents=${JSON.stringify(unsent)};
 const journal=new ZeitguruStore(process.env.TIME_TRACKER_DATA),sql=new DatabaseSync(process.env.TIME_TRACKER_DATA),user=readDatabase().users[0],userId=user.id;
 journal.connect({userId,expectedGeneration:0,providerKey:'company/employee',auth:{token:'synthetic'},config:{branchId:'office',consentedAt:Date.parse('2026-09-07T05:00:00Z')}});
 applyZeitguruLiveSync(journal,userId,1,0,[observedZeitguruClock(checkpoint,'employee',snapshot.observedAt)],0);
 const id=readDatabase().timeEntries[0].id;
 for(const [index,item] of intents.entries()){
   const db=readDatabase(),entry=db.timeEntries[0];
   if(index===0)entry.breaks.push({id:'local-break',startedAt:item.payload.occurredAt});else entry.breaks.at(-1).stoppedAt=item.payload.occurredAt;
   writeDatabaseAtomically(db,(tx,persist)=>journal.withClockOperation(tx,{userId,clientOperationId:item.id,expectedGeneration:1,expectedRevision:journal.getClockRevision(userId),action:item.payload.action,request:{}},()=>{persist();return {...item.payload,localEntryId:id}}));
 }
 const first=journal.claimNext();journal.complete(first,{status:'reconciliation_required',errorCode:'remote_conflict'});
 const immutable=sql.prepare('SELECT id,payloadCipher FROM zeitguru_operations ORDER BY sequence').all();
 const ready={auth:{token:'synthetic'},config:{},providerKey:'company/employee',identity:{name:user.name,email:user.email},branches:[{id:'office',name:'Office'}],remoteStatus:'working'};
 let remote=snapshot.clockings[0],writes=0;
 const provider={observe:async()=>[observedZeitguruClock(remote,'employee',snapshot.observedAt)],refresh:async()=>ready,login:async()=>ready,plan:async()=>{throw Error('Recovery must use saved plan')},rebase:async(_r,c,items,point)=>planZeitguruRecovery({...snapshot,clockings:[remote]},c,items,point),evidence:async(_r,plan)=>({expected:same(remote,plan.expectedRow),desired:same(remote,plan.desiredRow)}),write:async(_r,plan)=>{assert(sql.prepare("SELECT 1 FROM zeitguru_operations WHERE status='sending' AND planCipher IS NOT NULL").get());remote=plan.desiredRow;writes++}};
 const service=new ZeitguruService(journal,provider,{user:()=>user,isClockedOut:()=>false,changed:()=>{},synchronize:(...args)=>applyZeitguruLiveSync(journal,...args),rebase:(...args)=>applyZeitguruRebase(journal,...args)},()=>Date.parse(snapshot.observedAt));
 assert.equal(journal.status(userId).counts.reconciliation_required,2,'startup retains both captured actions for review');
 const pending=journal.unsentConflict(userId);assert.equal(pending.length,2);
 const plans=planZeitguruRecovery(snapshot,{branchId:'office'},pending,checkpoint);
 const localBefore=JSON.stringify(readDatabase().timeEntries),revision=journal.getClockRevision(userId);
 assert.throws(()=>applyZeitguruRebase(journal,userId,1,revision-1,pending,plans));assert.equal(JSON.stringify(readDatabase().timeEntries),localBefore);assert.equal(journal.unsentConflict(userId).length,2);
 await service.synchronize(userId);for(let i=0;i<30;i++)await tick();
 assert.equal(writes,2);assert.equal(journal.status(userId).counts.confirmed,2);assert.equal(journal.status(userId).requiresAttention,false);
 const entry=readDatabase().timeEntries[0];assert.equal(entry.breaks.length,3);assert.equal(entry.breaks[1].startedAt,'2026-09-07T10:16:00.000Z');assert.equal(entry.breaks[1].stoppedAt,'2026-09-07T10:49:00.000Z');assert.equal(entry.breaks[2].startedAt,'2026-09-07T11:01:14.263Z');assert.equal(entry.breaks[2].stoppedAt,'2026-09-07T11:01:29.741Z');
 assert.deepEqual(sql.prepare('SELECT id,payloadCipher FROM zeitguru_operations ORDER BY sequence').all(),immutable);
 await service.synchronize(userId);assert.equal(writes,2);assert.equal(readDatabase().timeEntries[0].breaks.length,3);
 assert(readDatabase().audit.some(item=>item.action==='zeitguru_clock_rebased'));sql.close();journal.close();
 `
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,TIME_TRACKER_DATA:join(dir,'time.sqlite'),TIME_TRACKER_BACKUP_DIR:join(dir,'backups'),INITIAL_ADMIN_NAME:'Synthetic',INITIAL_ADMIN_EMAIL:'synthetic@example.test',INITIAL_ADMIN_PASSWORD:'K9!vMq7#rT4$zLp2',INITIAL_ADMIN_MUST_CHANGE_PASSWORD:'false',DCO_CORE_URL:'',DCO_TIMEZONE:'Europe/Berlin',REQUIRE_DATA_ENCRYPTION:'true',DATA_ENCRYPTION_KEY:'synthetic-live-sync-encryption-key-for-unit-tests'}})
 assert.equal(child.status,0,child.stderr||child.stdout)
})
