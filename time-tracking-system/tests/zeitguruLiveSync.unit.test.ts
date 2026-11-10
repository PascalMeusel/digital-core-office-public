import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { observedZeitguruClock, containsZeitguruTransition, observeZeitguruRows } from '../server/zeitguruLiveClock.ts'
import { ZeitguruWebProvider } from '../server/zeitguruWebProvider.ts'
import type { ZeitguruClient } from '../server/zeitguruClient.ts'
const row = { id:'remote-1',userId:'remote-user',branchId:'office',date:'2026-09-07',startTime:'09:00',breakMinutes:0,userId_date:'remote-user_2026-09-07' }
const now='2026-09-08T10:00:00Z'

test('provider-only Friday shifts are caught on Monday using a bounded own-account range', async () => {
 const binding={tenantId:'company',userId:'remote-user',accountId:'account',role:'employee'}
 const friday={...row,date:'2026-09-04',userId_date:'remote-user_2026-09-04',endTime:'17:00'}
 const snapshot={binding,tenant:{id:'company',isV2:true},profile:{id:'remote-user',accountId:'account',role:'employee',name:'Synthetic',email:'synthetic@example.test',branchIds:['office']},clockSettings:{allowUserTimClockInBrowser:true},rosterSettings:{timezone:'Europe/Berlin'},branches:[{id:'office',name:'Office',isClockingEnabled:true}],clockings:[],credits:{},observedAt:'2026-09-07T10:00:00Z',fromDate:'2026-09-06',toDate:'2026-09-07',etags:{}}
 const ranges:string[][]=[]
 const client={readSnapshot:async()=>snapshot,readOwnHistoryRange:async(_t:unknown,_b:unknown,from:string,to:string)=>{ranges.push([from,to]);return friday.date>=from && friday.date<=to ? [friday] : []}} as unknown as ZeitguruClient
 const provider=new ZeitguruWebProvider({client})
 const auth={idToken:'synthetic',refreshToken:'synthetic',expiresAt:Date.now()+3600000}
 const config={binding,consentedAt:Date.parse('2026-09-01T00:00:00Z'),liveSyncThroughDate:'2026-09-03'}
 const connection=await provider.refresh(auth,config)
 assert.equal(provider.observationThroughDate(connection),undefined,'reads alone never advance progress')
 const observed=await provider.observe(connection,[])
 assert.deepEqual(ranges,[['2026-09-02','2026-09-05']]);assert.equal(observed[0].row.id,friday.id)
 assert.equal(provider.observationThroughDate(connection),'2026-09-07')
 // A months-long gap is chunked rather than silently dropping older dates.
 const older=await provider.refresh(auth,{...config,liveSyncThroughDate:'2026-07-01',consentedAt:Date.parse('2026-06-01T00:00:00Z')})
 await provider.observe(older,[])
 assert.deepEqual(ranges.at(-1),['2026-06-30','2026-07-30'])
 assert.equal(provider.observationThroughDate(older),'2026-07-30')
})

test('provider adapter retains historical evidence while planning a separate current clock-in',async()=>{
 const binding={tenantId:'company',userId:'remote-user',accountId:'account',role:'employee'}
 const old={...row,isAutoClockOut:true}
 const snapshot={binding,tenant:{id:'company',isV2:true},profile:{id:'remote-user',accountId:'account',role:'employee',name:'Synthetic',email:'synthetic@example.test',branchIds:['office'],jobPositionIds:['position']},
  clockSettings:{allowUserTimClockInBrowser:true,breaksNeedToBeClocked:true,clockingsAreAutoApprovedV2:true},rosterSettings:{timezone:'Europe/Berlin',breakRules:[]},branches:[{id:'office',name:'Office',isClockingEnabled:true}],clockings:[old],credits:{'2026-09-07':{},'2026-09-08':{}},observedAt:now,fromDate:'2026-09-07',toDate:'2026-09-08',etags:{}}
 const client={readSnapshot:async()=>snapshot,readServerTime:async()=>Date.parse(now)} as unknown as ZeitguruClient
 const provider=new ZeitguruWebProvider({client}),connection=await provider.refresh({idToken:'synthetic',refreshToken:'synthetic',expiresAt:Date.now()+3600000},{binding})
 assert.equal(connection.remoteStatus,'off_work')
 assert.deepEqual(await provider.observe(connection,[]),[])
 assert.deepEqual(provider.observationReviewDates(connection),['2026-09-07'])
 const plan=await provider.plan(connection,{branchId:'office'},{action:'start_work',occurredAt:now,localEntryId:'new-local'})
 assert.equal(plan.desiredRow.date,'2026-09-08');assert.notEqual(plan.desiredRow.id,old.id)
 assert.equal(plan.expectedRow,null);assert.deepEqual(snapshot.clockings,[old]);assert.equal(Object.keys(plan.patch).length,1)
})

test('historical incomplete auto-closes are isolated while current punches and identity checks remain strict',()=>{
 const historical={...row,isAutoClockOut:true}
 const inconsistent={...historical,id:'bad-break',endTime:'18:00',breakActivities:[{type:'start' as const,time:'00:11'},{type:'end' as const,time:'00:11'}]}
 const current={...row,id:'current',date:'2026-09-08',userId_date:'remote-user_2026-09-08'}
 const original=JSON.stringify([historical,inconsistent,current])
 const result=observeZeitguruRows([historical,inconsistent,current],'remote-user',now)
 assert.deepEqual(result.reviewDates,['2026-09-07']);assert.equal(result.observed.length,1);assert.equal(result.observed[0].row.id,'current')
 assert.equal(JSON.stringify([historical,inconsistent,current]),original,'provider evidence stays unchanged')
 assert.throws(()=>observeZeitguruRows([{...current,isAutoClockOut:true}],'remote-user',now),'today cannot be skipped')
 assert.throws(()=>observeZeitguruRows([{...inconsistent,isAutoClockOut:false}],'remote-user',now),'unsupported ordinary shifts stay blocked')
 assert.throws(()=>observeZeitguruRows([{...historical,userId:'someone-else'}],'remote-user',now),'foreign identity cannot be skipped')
 assert.throws(()=>observeZeitguruRows([{...historical,date:'invalid'}],'remote-user',now),'invalid dates cannot be skipped')
 assert.throws(()=>observeZeitguruRows([{...current,breakActivities:[{type:'end',time:'09:30'}]}],'remote-user',now),'malformed active rows stay blocked')
 const valid={...historical,endTime:'10:00'}
 assert.equal(observeZeitguruRows([valid],'remote-user',now).observed.length,1,'complete automatic clocks are still reconciled')
})

test('automatic-close reconciliation validates overlap using preserved punch seconds',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dco-sync-seconds-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const moduleUrl=(file:string)=>JSON.stringify(new URL('../server/'+file,import.meta.url).href)
 const script=`
 import assert from 'node:assert/strict';
 const {readDatabase,writeDatabase}=await import(${moduleUrl('store.ts')});
 const {ZeitguruStore}=await import(${moduleUrl('zeitguruStore.ts')});
 const {applyZeitguruLiveSync}=await import(${moduleUrl('zeitguruLiveSync.ts')});
 const {observedZeitguruClock}=await import(${moduleUrl('zeitguruLiveClock.ts')});
 const journal=new ZeitguruStore(process.env.TIME_TRACKER_DATA),userId=readDatabase().users[0].id;
 journal.connect({userId,expectedGeneration:0,providerKey:'synthetic/employee',auth:{token:'synthetic'},config:{}}); // gitleaks:allow -- synthetic provider identifier
 let remote={id:'later-shift',userId:'remote-user',branchId:'office',date:'2026-09-15',userId_date:'remote-user_2026-09-15',startTime:'08:15',breakMinutes:0};
 const observe=()=>[observedZeitguruClock(remote,'remote-user','2026-09-23T05:00:00Z')];
 applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),observe(),0);
 const database=readDatabase(),entry=database.timeEntries[0],id=entry.id;
 entry.startedAt='2026-09-15T06:15:56.930Z';entry.stoppedAt='2026-09-15T19:16:52.975Z';entry.updatedAt=entry.stoppedAt;entry.manualBreakMinutes=781;
 database.audit.push({id:'auto',actorId:'system',action:'auto_clock_out_over_13h',targetType:'time_entry',targetId:id,details:{stoppedAt:entry.stoppedAt},createdAt:entry.stoppedAt});
 database.timeEntries.push({...entry,id:'earlier-shift',startedAt:'2026-09-15T06:13:50.583Z',stoppedAt:'2026-09-15T06:15:55.699Z',manualBreakMinutes:0});writeDatabase(database);
 remote={...remote,endTime:'17:35',breakMinutes:41,breakActivities:[{type:'start',time:'12:11'},{type:'end',time:'12:52'}]};
 applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),observe(),0);
 const fixed=readDatabase().timeEntries.find(e=>e.id===id);assert.equal(fixed.startedAt,'2026-09-15T06:15:56.930Z');assert.equal(fixed.stoppedAt,'2026-09-15T15:35:00.000Z');assert.equal(fixed.manualBreakMinutes,0);
 const overlapping=readDatabase();overlapping.timeEntries.find(e=>e.id==='earlier-shift').stoppedAt='2026-09-15T06:16:00Z';writeDatabase(overlapping);remote={...remote,endTime:'17:36'};
 assert.throws(()=>applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),observe(),0),e=>e.code==='local_conflict','genuine overlap still rejected');
 assert.equal(readDatabase().timeEntries.find(e=>e.id===id).stoppedAt,'2026-09-15T15:35:00.000Z');journal.close();
 `
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,TIME_TRACKER_DATA:join(dir,'time.sqlite'),TIME_TRACKER_BACKUP_DIR:join(dir,'backups'),INITIAL_ADMIN_NAME:'Synthetic',INITIAL_ADMIN_EMAIL:'synthetic@example.test',INITIAL_ADMIN_PASSWORD:'K9!vMq7#rT4$zLp2',INITIAL_ADMIN_MUST_CHANGE_PASSWORD:'false',DCO_CORE_URL:'',DCO_TIMEZONE:'Europe/Berlin',REQUIRE_DATA_ENCRYPTION:'true',DATA_ENCRYPTION_KEY:'synthetic-live-sync-encryption-key-for-unit-tests'}})
 assert.equal(child.status,0,child.stderr||child.stdout)
})
test('approved historical replacements stay reviewable without blocking later shifts; current and unexplained missing entries stay protected', t => {
 const dir=mkdtempSync(join(tmpdir(),'dco-historical-replacement-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const moduleUrl=(file:string)=>JSON.stringify(new URL('../server/'+file,import.meta.url).href)
 const script=`
 import assert from 'node:assert/strict';
 const {readDatabase,writeDatabase}=await import(${moduleUrl('store.ts')});
 const {ZeitguruStore}=await import(${moduleUrl('zeitguruStore.ts')});
 const {ZeitguruService}=await import(${moduleUrl('zeitguruService.ts')});
 const {applyZeitguruLiveSync}=await import(${moduleUrl('zeitguruLiveSync.ts')});
 const {observedZeitguruClock}=await import(${moduleUrl('zeitguruLiveClock.ts')});
 const {zeitguruWallTime,zeitguruAddDays}=await import(${moduleUrl('zeitguruProtocol.ts')});
 const journal=new ZeitguruStore(process.env.TIME_TRACKER_DATA),user=readDatabase().users[0],userId=user.id;
 const today=zeitguruWallTime(Date.now()).date,oldDate=zeitguruAddDays(today,-3);
 const old={id:'old-remote',userId:'remote-user',branchId:'office',date:oldDate,userId_date:'remote-user_'+oldDate,startTime:'09:00',endTime:'10:00',breakMinutes:0};
 const ready={auth:{token:'synthetic'},config:{},providerKey:'synthetic/employee',identity:{name:'Synthetic',email:user.email},branches:[{id:'office',name:'Office'}],remoteStatus:'off_work'}; // gitleaks:allow -- synthetic provider identifier
 journal.connect({userId,expectedGeneration:0,providerKey:ready.providerKey,auth:ready.auth,config:{consentedAt:0}});
 const observe=row=>observedZeitguruClock(row,'remote-user',new Date().toISOString());
 applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),[observe(old)],0);
 const db=readDatabase(),original=db.timeEntries[0];
 const approved={...original,id:'approved-replacement',source:'approved_correction'};
 db.timeEntries=[approved];writeDatabase(db);
 let rows=[old],writes=0;
 const provider={refresh:async()=>ready,observe:async()=>rows.map(observe),observationThroughDate:()=>today,observationReviewDates:()=>[zeitguruAddDays(today,-2)],write:async()=>{writes++}};
 const service=new ZeitguruService(journal,provider,{user:()=>user,isClockedOut:()=>true,changed:()=>{},synchronize:(...args)=>applyZeitguruLiveSync(journal,...args)});
 const revision=journal.getClockRevision(userId),before=JSON.stringify(readDatabase().timeEntries);
 const status=await service.synchronize(userId);
 assert.equal(JSON.stringify(readDatabase().timeEntries),before,'approved correction is untouched and original is not recreated');
 assert.equal(journal.getClockRevision(userId),revision,'review-only sync does not advance the clock revision');
 assert(status.synchronization.error.includes(oldDate));assert(status.synchronization.error.includes(zeitguruAddDays(today,-2)));
 assert(status.synchronization.error.includes('New clock actions remain available'));
 assert.equal(journal.readConnection(userId).config.liveSyncThroughDate,undefined,'reviewed dates are not skipped by the cursor');
 assert.equal(journal.observedRows(userId)[0].localEntryId,original.id,'historical evidence is retained');
 await service.synchronize(userId);assert.equal(JSON.stringify(readDatabase().timeEntries),before,'repeat is idempotent');
 rows=[old,{...old,id:'current-remote',date:today,userId_date:'remote-user_'+today,startTime:'00:00',endTime:undefined}];
 await service.synchronize(userId);
 const current=readDatabase().timeEntries.find(entry=>entry.id!==approved.id);
 assert(current&&!current.stoppedAt,'a separate current shift is synchronized despite the old replacement');
 assert.equal(readDatabase().timeEntries.length,2);assert.equal(writes,0,'no provider records are written or replayed');
 const changed=readDatabase();changed.timeEntries=changed.timeEntries.filter(entry=>entry.id!==current.id);writeDatabase(changed);
 await assert.rejects(service.synchronize(userId),error=>error.code==='local_conflict','missing current shift still blocks');
 rows=[old];const unexplained=readDatabase();unexplained.timeEntries=[];writeDatabase(unexplained);
 await assert.rejects(service.synchronize(userId),error=>error.code==='local_conflict','unexplained historical deletion still blocks');
 const currentClosed={...rows[0],id:'closed-today',date:today,userId_date:'remote-user_'+today,startTime:'00:00',endTime:'00:00'};
 applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),[observe(currentClosed)],0);
 const closed=readDatabase(),todayEntry=closed.timeEntries[0];closed.timeEntries=[{...todayEntry,id:'today-correction',source:'approved_correction'}];writeDatabase(closed);
 assert.throws(()=>applyZeitguruLiveSync(journal,userId,1,journal.getClockRevision(userId),[observe(currentClosed)],0,undefined,new Set()),error=>error.code==='local_conflict','today remains strict even for a closed replacement');
 journal.close();
 `
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,TIME_TRACKER_DATA:join(dir,'time.sqlite'),TIME_TRACKER_BACKUP_DIR:join(dir,'backups'),INITIAL_ADMIN_NAME:'Synthetic',INITIAL_ADMIN_EMAIL:'synthetic@example.test',INITIAL_ADMIN_PASSWORD:'K9!vMq7#rT4$zLp2',INITIAL_ADMIN_MUST_CHANGE_PASSWORD:'false',DCO_CORE_URL:'',DCO_TIMEZONE:'Europe/Berlin',REQUIRE_DATA_ENCRYPTION:'true',DATA_ENCRYPTION_KEY:'synthetic-live-sync-encryption-key-for-unit-tests'}})
 assert.equal(child.status,0,child.stderr||child.stdout)
})

test('remote observation preserves running break, closed breaks, overnight times and extra deducted breaks',()=>{
 const running=observedZeitguruClock({...row,breakActivities:[{type:'start',time:'09:30'}]},'remote-user',now).entry
 assert.equal(running.startedAt,'2026-09-07T07:00:00.000Z');assert.equal(running.breaks[0].stoppedAt,undefined)
 const closed=observedZeitguruClock({...row,endTime:'11:00',breakMinutes:45,breakActivities:[{type:'start',time:'09:30'},{type:'end',time:'10:00'}]},'remote-user',now).entry
 assert.equal(closed.manualBreakMinutes,15);assert.equal(closed.stoppedAt,'2026-09-07T09:00:00.000Z')
 const overnight=observedZeitguruClock({...row,startTime:'23:00',endTime:'01:00',breakMinutes:10,breakActivities:[{type:'start',time:'23:55'},{type:'end',time:'00:05'}]},'remote-user',now).entry
 assert.equal(overnight.stoppedAt,'2026-09-07T23:00:00.000Z');assert.equal(overnight.breaks[0].stoppedAt,'2026-09-07T22:05:00.000Z')
})
test('malformed identities, breaks and ambiguous DST instants are never guessed',()=>{
 assert.throws(()=>observedZeitguruClock(row,'other',now))
 assert.throws(()=>observedZeitguruClock({...row,breakActivities:[{type:'end',time:'09:30'}]},'remote-user',now))
 assert.throws(()=>observedZeitguruClock({...row,date:'2026-10-25',userId_date:'remote-user_2026-10-25',startTime:'02:30'},'remote-user','2026-10-26T12:00:00Z'))
})
test('live synchronization adopts running shifts atomically, tracks outside actions, fences stale clocks and preserves conflicts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dco-live-sync-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const script=`
 import assert from 'node:assert/strict';
 const {readDatabase,writeDatabase,writeDatabaseAtomically}=await import(${JSON.stringify(new URL('../server/store.ts',import.meta.url).href)});
 const {ZeitguruStore}=await import(${JSON.stringify(new URL('../server/zeitguruStore.ts',import.meta.url).href)});
 const {applyZeitguruLiveSync}=await import(${JSON.stringify(new URL('../server/zeitguruLiveSync.ts',import.meta.url).href)});
 const {observedZeitguruClock}=await import(${JSON.stringify(new URL('../server/zeitguruLiveClock.ts',import.meta.url).href)});
 const {ZeitguruService}=await import(${JSON.stringify(new URL('../server/zeitguruService.ts',import.meta.url).href)});
 const journal=new ZeitguruStore(process.env.TIME_TRACKER_DATA),user=readDatabase().users[0],userId=user.id;
 let remote=${JSON.stringify(row)};const observed=()=>[observedZeitguruClock(remote,'remote-user',${JSON.stringify(now)})];
 const ready={auth:{token:'synthetic'},config:{},providerKey:'remote-account',identity:{name:user.name,email:user.email},branches:[{id:'office',name:'Office'}],remoteStatus:'working'};
 let writes=0;const provider={login:async()=>ready,refresh:async()=>ready,observe:async()=>observed(),write:async()=>{writes++},plan:async()=>{throw Error('No write planning during sync')},evidence:async()=>({expected:false,desired:false})};
 const service=new ZeitguruService(journal,provider,{user:()=>user,isClockedOut:()=>!readDatabase().timeEntries.some(e=>!e.stoppedAt),changed:()=>{},synchronize:(...args)=>applyZeitguruLiveSync(journal,...args)},()=>Date.parse('2026-09-07T10:00:00Z'));
 const challenge=await service.login(userId,{email:user.email,password:'synthetic'});assert.equal(challenge.canActivate,true);
 await service.connect(userId,{challengeId:challenge.challengeId,branchId:'office',consent:true,expectedGeneration:0});
 let entry=readDatabase().timeEntries[0];assert.equal(entry.startedAt,'2026-09-07T07:00:00.000Z');const id=entry.id;assert.equal(journal.status(userId).enabled,true);assert.equal(journal.getClockRevision(userId),1);
 await service.synchronize(userId);assert.equal(journal.getClockRevision(userId),1,'unchanged state is idempotent');assert.equal(readDatabase().timeEntries.length,1);
 remote={...remote,breakActivities:[{type:'start',time:'09:30'}]};await service.synchronize(userId);entry=readDatabase().timeEntries[0];assert.equal(entry.breaks.length,1);assert.equal(entry.breaks[0].stoppedAt,undefined);
 remote={...remote,breakMinutes:30,breakActivities:[...remote.breakActivities,{type:'end',time:'10:00'}]};await service.synchronize(userId);assert.equal(readDatabase().timeEntries[0].breaks[0].stoppedAt,'2026-09-07T08:00:00.000Z');
 remote={...remote,endTime:'11:00'};await service.synchronize(userId);assert.equal(readDatabase().timeEntries[0].stoppedAt,'2026-09-07T09:00:00.000Z');assert.equal(readDatabase().timeEntries[0].id,id);assert.equal(writes,0);
 const stale={userId,expectedGeneration:1,expectedRevision:1,clientOperationId:'stale-clock-operation',action:'start_work',request:{}};assert.throws(()=>writeDatabaseAtomically(readDatabase(),(tx,persist)=>journal.withClockOperation(tx,stale,()=>{persist();return{}})));
 const stopped=remote;remote={...remote,id:'remote-2',startTime:'13:00',endTime:'14:00',breakMinutes:0,breakActivities:[]};await service.synchronize(userId);assert.equal(readDatabase().timeEntries.length,2,'a shift completed entirely in Zeitguru is adopted');await service.synchronize(userId);assert.equal(readDatabase().timeEntries.length,2,'no duplicate on repeated polling');remote=stopped;
 const before=JSON.stringify(readDatabase().timeEntries);const db=readDatabase();db.timeEntries.find(e=>e.id===id).source='approved_correction';writeDatabase(db);remote={...remote,endTime:'11:15'};await assert.rejects(service.synchronize(userId));assert.equal(readDatabase().timeEntries.find(e=>e.id===id).stoppedAt,'2026-09-07T09:00:00.000Z');assert.equal(journal.lastConfirmedRow(userId,id).endTime,'11:00');
 assert(readDatabase().audit.filter(a=>a.action==='zeitguru_clock_synchronized').length>=4);assert.equal(writes,0);
 journal.disconnect(userId,1);const reset=readDatabase();reset.timeEntries=[];writeDatabase(reset);remote={...remote,id:'new-running-break',endTime:undefined,breakMinutes:0,breakActivities:[{type:'start',time:'09:30'}]};ready.remoteStatus='on_break';const next=await service.login(userId,{email:user.email,password:'synthetic'});assert.equal(next.canActivate,true);await service.connect(userId,{challengeId:next.challengeId,branchId:'office',consent:true,expectedGeneration:2});assert.equal(readDatabase().timeEntries[0].breaks[0].stoppedAt,undefined);assert.equal(journal.status(userId).generation,3);
 journal.close();
 `
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,TIME_TRACKER_DATA:join(dir,'time.sqlite'),TIME_TRACKER_BACKUP_DIR:join(dir,'backups'),INITIAL_ADMIN_NAME:'Synthetic',INITIAL_ADMIN_EMAIL:'synthetic@example.test',INITIAL_ADMIN_PASSWORD:'K9!vMq7#rT4$zLp2',INITIAL_ADMIN_MUST_CHANGE_PASSWORD:'false',DCO_CORE_URL:'',DCO_TIMEZONE:'Europe/Berlin',REQUIRE_DATA_ENCRYPTION:'true',DATA_ENCRYPTION_KEY:'synthetic-live-sync-encryption-key-for-unit-tests'}})
 assert.equal(child.status,0,child.stderr||child.stdout)
})


test('later provider actions prove prior punches only with retained history and consistent credit',()=>{
 const started={...row,logS:'browser-original'}
 const stopped={...started,endTime:'11:00',breakMinutes:30,isAccepted:true,breakActivities:[{type:'start' as const,time:'09:30'},{type:'end' as const,time:'10:00'}]}
 assert.equal(containsZeitguruTransition(started,stopped,90,now),true)
 assert.equal(containsZeitguruTransition({...started,breakActivities:[{type:'start',time:'09:30'}]},stopped,90,now),true)
 assert.equal(containsZeitguruTransition(started,stopped,120,now),false)
 assert.equal(containsZeitguruTransition({...started,startTime:'08:45'},stopped,90,now),false)
 assert.equal(containsZeitguruTransition({...started,breakActivities:[{type:'start',time:'09:45'}]},stopped,90,now),false)
 assert.equal(containsZeitguruTransition({...started,endTime:'10:45'},stopped,90,now),false)
})
