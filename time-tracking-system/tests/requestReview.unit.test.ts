import assert from 'node:assert/strict'
import { test } from 'node:test'
import { correctionReview, filterApprovalRequests, type ApprovalFilters } from '../shared/requestReview.ts'
import type { RequestItem, StatePayload, TimeEntry } from '../shared/domain.ts'
const request:RequestItem={id:'request',userId:'own',type:'time_correction',status:'pending',correctionDate:'2026-09-03',proposedStartTime:'08:14',proposedEndTime:'17:30',proposedBreakMinutes:109,reason:'Incorrect finish time',createdAt:'2026-09-08T07:00:00Z'}
const entry:TimeEntry={id:'entry',userId:'own',date:'2026-09-03',startedAt:'2026-09-03T06:14:00Z',stoppedAt:'2026-09-03T16:30:00Z',manualBreakMinutes:109,breaks:[],source:'zeitguru',zeitguru:{workedMinutes:507,creditedMinutes:507,approved:true,readOnly:true,batchId:'batch'},createdAt:request.createdAt,updatedAt:request.createdAt}
test('correction review uses imported worked minutes, keeps employee scope and computes the requested change',()=>{
 const state={timeEntries:[],adminTimeEntries:[entry,{...entry,id:'other',userId:'other'}]}
 const result=correctionReview(request,state)
 assert.equal(result.currentMinutes,507);assert.equal(result.currentBreakMinutes,109);assert.equal(result.proposedMinutes,447);assert.equal(result.deltaMinutes,-60);assert.equal(result.entries.length,1)
 assert.equal(state.adminTimeEntries.length,2)
})
test('overnight corrections and incomplete dates are calculated explicitly without invented values',()=>{
 const state={timeEntries:[]}
 const result=correctionReview({...request,proposedStartTime:'22:00',proposedEndTime:'06:00',proposedBreakMinutes:30},state)
 assert.equal(result.overnight,true);assert.equal(result.proposedMinutes,450)
 assert.equal(correctionReview({...request,proposedEndTime:undefined},state).proposedMinutes,undefined)
 assert.equal(correctionReview({...request,proposedStartTime:'no'},state).proposedMinutes,undefined)
})
test('current source-ledger work takes precedence over physical overlap for the approval impact',()=>{
 const state={timeEntries:[entry],zeitguruAccounting:{own:{days:[{date:entry.date,workedMinutes:600,creditedMinutes:600}],initialImportReconstruction:{days:[],transfers:[],unallocated:[]}}}} as unknown as StatePayload
 assert.equal(correctionReview(request,state).deltaMinutes,-153)
})
test('queue combines status, employee, type, search and date filters without pending bypasses',()=>{
 const state={requests:Array.from({length:500},(_,index)=>({...request,id:String(index),status:index%2?'approved':'pending',userId:index%3?'own':'other'})),users:[{id:'own',name:'Alex Example',email:'alex@example.invalid'},{id:'other',name:'Other Employee'}]} as StatePayload
 const filters:ApprovalFilters={search:'alex',employee:'own',type:'time_correction',status:'approved',from:'2026-09-01',to:'2026-09-04',sort:'oldest'}
 const result=filterApprovalRequests(state,filters)
 assert(result.length>0);assert(result.every(request=>request.status==='approved'&&request.userId==='own'))
 assert.equal(filterApprovalRequests(state,{...filters,from:'2026-09-04'}).length,0)
 assert.equal(filterApprovalRequests(state,{...filters,type:'vacation'}).length,0)
 assert.equal(filterApprovalRequests(state,{...filters,search:'missing'}).length,0)
 assert.equal(state.requests.length,500)
})
test('related import transfers are shown only when the submitted proposal still matches',()=>{
 const state={timeEntries:[],zeitguruAccounting:{own:{days:[],initialImportReconstruction:{days:[{date:request.correctionDate,proposedStart:request.proposedStartTime,proposedEnd:request.proposedEndTime,proposedBreakMinutes:109}],transfers:[{fromDate:request.correctionDate,toDate:'2026-09-04',minutes:60}],unallocated:[]}}}} as unknown as StatePayload
 assert.equal(correctionReview(request,state).transfers.length,1)
 assert.equal(correctionReview({...request,proposedEndTime:'17:00'},state).transfers.length,0)
})
