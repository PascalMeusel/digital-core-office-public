import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planImportReconstruction } from '../server/zeitguruImportReconstruction.ts'
import { isoFromDateAndTime } from '../shared/dates.ts'
import type { TimeEntry } from '../shared/domain.ts'
import type { ZeitguruAccountingPublicDay } from '../shared/timeAccounting.ts'
const entry=(date:string,start:string,end:string,work:number,pause:number):TimeEntry=>({id:date,userId:'u',date,startedAt:isoFromDateAndTime(date,start),stoppedAt:isoFromDateAndTime(date,end),manualBreakMinutes:pause,breaks:[],source:'zeitguru',zeitguru:{workedMinutes:work,creditedMinutes:work,approved:true,readOnly:true,batchId:'b'},createdAt:'2026-09-07T00:00:00Z',updatedAt:'2026-09-07T00:00:00Z'})
const day=(date:string,workedMinutes:number):ZeitguruAccountingPublicDay=>({date,workedMinutes,expectedMinutes:480,absenceMinutes:0,holidayMinutes:0,correctionMinutes:0,creditedMinutes:workedMinutes,exactDeltaMinutes:workedMinutes-480,balanceMinutes:0})
function input(entries:TimeEntry[],extra:ZeitguruAccountingPublicDay[]=[]){return {throughDate:'2026-09-06',entries,days:[...entries.map(e=>day(e.date,e.zeitguru!.workedMinutes)),...extra],native:[],holidays:[],absences:[],uncertainDates:[]} }

test('ten-hour estimate preserves the hour pool, prefers weekdays and never mutates evidence',()=>{
 const data=input([entry('2026-09-01','08:00','20:00',660,60),entry('2026-09-02','08:00','17:00',480,60)],[day('2026-09-05',0)]),before=structuredClone(data)
 const plan=planImportReconstruction(data)
 assert.deepEqual(plan.transfers,[{fromDate:'2026-09-01',toDate:'2026-09-02',minutes:60}]);assert.deepEqual(plan.unallocated,[])
 assert.equal(plan.days[0].proposedEnd,'19:00');assert.equal(plan.days.reduce((n,d)=>n+d.proposedMinutes-d.originalMinutes,0),0);assert.deepEqual(data,before)
})
test('short rest shifts the start later and Saturday receives hours when a weekday cannot',()=>{
 const plan=planImportReconstruction(input([entry('2026-09-03','12:00','22:00',540,60),entry('2026-09-04','07:00','16:00',480,60)],[day('2026-09-05',0)]))
 const shifted=plan.days.find(d=>d.date==='2026-09-04')!
 assert.equal(shifted.proposedStart,'09:00');assert.equal(shifted.proposedEnd,'16:00');assert.equal(shifted.proposedMinutes,360)
 assert(plan.transfers.some(t=>t.toDate==='2026-09-05'));assert(plan.days.every(d=>d.proposedMinutes<=600))
 assert.equal(plan.days.reduce((n,d)=>n+d.originalMinutes-d.proposedMinutes,0),plan.unallocated.reduce((n,d)=>n+d.minutes,0))
})
test('holidays, absence, uncertainty, native days, untracked weekdays and later imports are excluded',()=>{
 const data=input([entry('2026-09-01','08:00','20:00',660,60)],[day('2026-09-02',0),{...day('2026-09-03',0),absenceMinutes:480},day('2026-09-05',0),day('2026-09-12',0)])
 const plan=planImportReconstruction({...data,holidays:[{id:'h',date:'2026-09-05',name:'Holiday',source:'custom',freePercent:100}]})
 assert.deepEqual(plan.transfers,[]);assert.deepEqual(plan.unallocated,[{date:'2026-09-01',minutes:60}])
 for(const blocked of [{uncertainDates:['2026-09-01']},{native:[{...data.entries[0],source:'clock' as const}]},{entries:[{...data.entries[0],zeitguru:{...data.entries[0].zeitguru!,approved:null}}]}])assert.deepEqual(planImportReconstruction({...data,...blocked}).days,[])
})
test('partial approvals retain linked proposals and distinguish approved matches from changed days',()=>{
 const data=input([entry('2026-09-01','08:00','20:00',660,60),entry('2026-09-02','08:00','17:00',480,60)])
 const first=planImportReconstruction(data),source=first.days[0]
 const correction={...entry(source.date,source.proposedStart,source.proposedEnd,source.proposedMinutes,source.proposedBreakMinutes),source:'approved_correction' as const}
 const after=planImportReconstruction({...data,native:[correction]})
 assert.deepEqual(after.transfers,first.transfers);assert.equal(after.days[0].status,'applied');assert.equal(after.days[1].status,'proposal')
 assert.equal(planImportReconstruction({...data,native:[{...correction,manualBreakMinutes:5}]}).days[0].status,'changed')
})
test('unplaceable hours stay explicit and a rest adjustment cannot erase a whole shift',()=>{
 const data=input([entry('2026-08-31','08:00','20:00',660,60),entry('2026-09-01','08:00','17:00',480,60)])
 assert.deepEqual(planImportReconstruction(data).unallocated,[{date:'2026-08-31',minutes:60}])
 assert.deepEqual(planImportReconstruction(input([entry('2026-09-03','16:00','23:00',390,30),entry('2026-09-04','07:00','09:00',120,0)])).days,[])
})
