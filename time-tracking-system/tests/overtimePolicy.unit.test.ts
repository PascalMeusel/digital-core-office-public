import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { defaultOvertimePolicy,overtimeBreach } from '../shared/overtimePolicy.ts'
import { OvertimePolicyStore,type OvertimeObservation } from '../server/overtimePolicyStore.ts'
import { OvertimePolicyService,overtimeObservations } from '../server/overtimePolicyService.ts'
import { deliverOvertimeEmail } from '../server/mailer.ts'
import type { Database,StoredUser } from '../server/store.ts'

const admin={id:'admin',email:'admin@example.invalid',name:'Admin',role:'admin',active:true,mustChangePassword:false,trackingStartDate:'2026-09-07',expectedWeeklyMinutes:0,yearlyVacationDays:0,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,employmentTerms:[]} as StoredUser
const employee={...admin,id:'employee',name:'Private employee',email:'employee@example.invalid',role:'employee',balanceAdjustmentMinutes:121} as StoredUser
const observation:OvertimeObservation={userId:'employee',name:employee.name,scope:'balance',date:'2026-09-07',minutes:121,provisional:true}
const settings={...defaultOvertimePolicy,balanceOvertimeMinutes:120,balanceUndertimeMinutes:60,emailEnabled:true,recipientUserIds:['admin']}
function fixture(t:TestContext){
 const old=process.env.DATA_ENCRYPTION_KEY;process.env.DATA_ENCRYPTION_KEY='synthetic-overtime-policy-encryption-key'
 const directory=mkdtempSync(join(tmpdir(),'dco-overtime-')),path=join(directory,'test.sqlite'),store=new OvertimePolicyStore(path)
 const database={users:[admin,employee],timeEntries:[],absences:[],requests:[],holidayOverrides:[],holidaySettings:{country:'DE',language:'en'},mailServerSettings:{host:'127.0.0.1',port:2525,secure:false,user:'',password:'',fromAddress:'dco@example.invalid'}} as unknown as Database
 const input={database,entries:database.timeEntries,absences:[],holidays:[],accounting:{}}
 const save=(patch:Record<string,unknown>={})=>store.save({...settings,revision:store.policy().revision,...patch},admin.id,new Set(['admin']),true,new Date('2026-09-07T12:00:00Z'))
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});if(old===undefined)delete process.env.DATA_ENCRYPTION_KEY;else process.env.DATA_ENCRYPTION_KEY=old})
 return{store,path,input,save}
}
test('limits use strict over/under boundaries, empty limits, scopes and overtime prohibition',()=>{
 const policy={...settings,configured:true}
 assert.equal(overtimeBreach(policy,'balance',120),'within');assert.equal(overtimeBreach(policy,'balance',121),'over')
 assert.equal(overtimeBreach(policy,'balance',-60),'within');assert.equal(overtimeBreach(policy,'balance',-61),'under')
 assert.equal(overtimeBreach(policy,'day',500),'within')
 assert.equal(overtimeBreach({...policy,overtimeAllowed:false},'balance',1),'over')
 assert.equal(overtimeBreach({...policy,balanceOvertimeMinutes:null},'balance',500),'within')
 assert.equal(overtimeBreach(defaultOvertimePolicy,'balance',500),'within')
})
test('policy validation rejects stale writes, invalid limits, non-admin recipients and unavailable SMTP',t=>{
 const f=fixture(t)
 assert.throws(()=>f.save({balanceOvertimeMinutes:-1}),/non-negative/)
 assert.throws(()=>f.save({balanceOvertimeMinutes:'120'}),/non-negative/)
 assert.throws(()=>f.save({recipientUserIds:['employee']}),/administrators/)
 assert.throws(()=>f.store.save(settings,'admin',new Set(['admin']),false),/SMTP/)
 assert.throws(()=>f.save({balanceOvertimeMinutes:null,balanceUndertimeMinutes:null}),/at least one limit/)
 f.save();assert.throws(()=>f.save({revision:0}),/changed/)
 assert.equal(f.store.policy().revision,1)
})
test('persistent breach episodes notify once, rearm within bounds, and notify direction changes',t=>{
 const f=fixture(t),policy=f.save()
 f.store.observe(policy,[observation]);f.store.observe(policy,[{...observation,minutes:180}])
 assert.equal(f.store.status().alerts.pending,1)
 const job=f.store.claim(new Set(['admin']))!;assert(job);f.store.complete(job.id,'sent')
 f.store.observe(policy,[{...observation,minutes:300}]);assert.equal(f.store.claim(new Set(['admin'])),undefined)
 f.store.observe(policy,[{...observation,minutes:0}]);f.store.observe(policy,[observation]);assert.equal(f.store.status().alerts.pending,1)
 f.store.observe(policy,[{...observation,minutes:-61}]);assert.equal(f.store.status().alerts.pending,2)
 const raw=new DatabaseSync(f.path,{readOnly:true});try{const rows=JSON.stringify(raw.prepare('SELECT * FROM overtime_alerts').all());assert(!rows.includes(employee.name));assert(rows.includes('enc:v1:'))}finally{raw.close()}
})
test('disabled email, changed policies, and revoked recipient roles cannot send queued alerts',t=>{
 const f=fixture(t),policy=f.save();f.store.observe(policy,[observation])
 assert.equal(f.store.claim(new Set()),undefined)
 const next=f.save();f.store.observe(next,[observation]);f.save({emailEnabled:false})
 assert.equal(f.store.claim(new Set(['admin'])),undefined)
})
test('restarts preserve sent dedupe and surface interrupted sends without automatic duplicates',t=>{
 const f=fixture(t),policy=f.save();f.store.observe(policy,[observation]);const job=f.store.claim(new Set(['admin']))!;assert(job)
 f.store.recover();assert.equal(f.store.status().alerts.unknown,1);assert.equal(f.store.claim(new Set(['admin'])),undefined)
 f.store.retryFailed();assert.equal(f.store.claim(new Set(['admin'])),undefined)
 const reopened=new OvertimePolicyStore(f.path);try{reopened.observe(policy,[observation]);assert.equal(reopened.claim(new Set(['admin'])),undefined)}finally{reopened.close()}
})
test('daily monitoring starts at activation and waits for clock-out without replaying historical imports',t=>{
 const f=fixture(t);f.save({scope:'both',dailyOvertimeMinutes:60,dailyUndertimeMinutes:30})
 const today='2026-09-07',startedAt=today+'T08:00:00Z'
 f.input.database.timeEntries=[{id:'live',userId:employee.id,date:today,startedAt,breaks:[],source:'clock',createdAt:startedAt,updatedAt:startedAt}]
 f.input.entries=f.input.database.timeEntries
 assert(!overtimeObservations(f.store,f.input,new Date(today+'T12:00:00Z')).some(value=>value.scope==='day'))
 f.input.database.timeEntries[0].stoppedAt=today+'T09:00:00Z'
 const observations=overtimeObservations(f.store,f.input,new Date(today+'T12:00:00Z'))
 assert(observations.some(value=>value.scope==='day'&&value.minutes===60))
 assert(observations.every(value=>value.date===today))
})
test('service sends one separate recipient message with provisional balance notice and no native writes',async t=>{
 const f=fixture(t);f.save();f.store.observe(f.store.policy(),[observation]);const native=JSON.stringify(f.input.database),messages:unknown[][]=[]
 const service=new OvertimePolicyService(f.store,()=>f.input,async(...args)=>{messages.push(args)},async users=>users.filter(user=>user.role==='admin'&&user.active))
 await service.check();await service.check()
 assert.equal(messages.length,1);assert.equal(messages[0][1],'admin@example.invalid');assert.equal(f.store.status().alerts.sent,1)
 assert.match(String(messages[0][3]),/unresolved source or opening-balance/)
 assert.equal(JSON.stringify(f.input.database),native)
})
test('known delivery failures permit explicit retry; ambiguous failures remain unknown',async t=>{
 const f=fixture(t);f.save();let fail=true
 const service=new OvertimePolicyService(f.store,()=>f.input,async()=>{if(fail)throw Object.assign(new Error('Synthetic connection failure'),{code:'ECONNECTION'})},async users=>users.filter(user=>user.role==='admin'))
 await service.check();assert.equal(f.store.status().alerts.failed,1)
 f.store.retryFailed();fail=false;await service.check();assert.equal(f.store.status().alerts.sent,1)
 f.save();const unknown=new OvertimePolicyService(f.store,()=>f.input,async()=>{throw Object.assign(new Error('Synthetic timeout'),{code:'ETIMEDOUT'})},async users=>users.filter(user=>user.role==='admin'))
 await unknown.check();assert.equal(f.store.status().alerts.unknown,1)
})
test('SMTP delivery reaches a local test inbox with a stable message ID and no outside delivery',async t=>{
 const f=fixture(t),messages:string[]=[]
 const server=createServer(socket=>{let buffer='',inData=false,body='';socket.write('220 localhost test SMTP\r\n');socket.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+2);if(inData){if(line==='.'){messages.push(body);body='';inData=false;socket.write('250 queued\r\n')}else body+=line+'\r\n'}else if(/^(EHLO|HELO)/.test(line))socket.write('250 localhost\r\n');else if(line==='DATA'){inData=true;socket.write('354 send data\r\n')}else if(line==='QUIT'){socket.end('221 bye\r\n')}else socket.write('250 ok\r\n')}})})
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const address=server.address();assert(address&&typeof address!=='string');f.input.database.mailServerSettings!.port=address.port
 await deliverOvertimeEmail(f.input.database,'admin@example.invalid','Overtime test','Synthetic bounded test','stable-synthetic')
 assert.equal(messages.length,1);assert.match(messages[0],/Message-ID: <overtime-stable-synthetic@digitalcoreoffice>/i);assert.match(messages[0],/To: admin@example.invalid/i)
})
