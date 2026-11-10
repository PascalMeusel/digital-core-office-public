import type { RequestItem, StatePayload } from './domain.ts'
import { addDays, isoFromDateAndTime } from './dates.ts'
import { accountingEntryWorkedMinutes } from './timeAccounting.ts'

export function requestRange(request: RequestItem): [string,string] {
  const from=request.startDate??request.correctionDate??request.createdAt.slice(0,10)
  return [from,request.endDate??from]
}
export interface ApprovalFilters { search:string; employee:string; type:string; status:string; from:string; to:string; sort:'oldest'|'newest'|'date'|'employee' }
export function filterApprovalRequests(state:Pick<StatePayload,'requests'|'users'>,filters:ApprovalFilters) {
  const users=new Map(state.users.map(user=>[user.id,user])),query=filters.search.trim().toLocaleLowerCase()
  return state.requests.filter(request=>{
    const [from,to]=requestRange(request),user=users.get(request.userId)
    return (filters.status==='all'||request.status===filters.status)&&(!filters.employee||request.userId===filters.employee)&&(!filters.type||request.type===filters.type)
      &&(!filters.from||to>=filters.from)&&(!filters.to||from<=filters.to)
      &&(!query||[user?.name,user?.email,request.id,request.reason,request.customTitle,from,to].some(value=>value?.toLocaleLowerCase().includes(query)))
  }).sort((a,b)=>{
    if(filters.sort==='newest')return b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)
    if(filters.sort==='date')return requestRange(a)[0].localeCompare(requestRange(b)[0])||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)
    if(filters.sort==='employee')return (users.get(a.userId)?.name??'').localeCompare(users.get(b.userId)?.name??'')||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)
    return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)
  })
}

/** Compare against the current effective ledger, never pretend it is a submission snapshot. */
export function correctionReview(request:RequestItem,state:Pick<StatePayload,'adminTimeEntries'|'timeEntries'|'zeitguruAccounting'>) {
  const entries=(state.adminTimeEntries??state.timeEntries).filter(entry=>entry.userId===request.userId&&entry.date===request.correctionDate).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))
  const accounting=state.zeitguruAccounting?.[request.userId],day=accounting?.days.find(day=>day.date===request.correctionDate)
  const currentMinutes=day?.workedMinutes??entries.reduce((sum,entry)=>sum+accountingEntryWorkedMinutes(entry),0)
  const currentBreakMinutes=entries.reduce((sum,entry)=>sum+(entry.manualBreakMinutes??0)+entry.breaks.reduce((n,pause)=>n+(pause.stoppedAt?Math.max(0,(Date.parse(pause.stoppedAt)-Date.parse(pause.startedAt))/60000):0),0),0)
  let proposedMinutes:number|undefined,overnight=false
  try{
    if(request.correctionDate&&request.proposedStartTime&&request.proposedEndTime){
      overnight=request.proposedEndTime<request.proposedStartTime
      const start=isoFromDateAndTime(request.correctionDate,request.proposedStartTime),end=isoFromDateAndTime(overnight?addDays(request.correctionDate,1):request.correctionDate,request.proposedEndTime)
      const minutes=(Date.parse(end)-Date.parse(start))/60000-(request.proposedBreakMinutes??0)
      if(Number.isFinite(minutes)&&minutes>=0&&Date.parse(end)>Date.parse(start))proposedMinutes=minutes
    }
  }catch{/* Incomplete historical request: show unavailable rather than a guessed impact. */}
  const proposal=accounting?.initialImportReconstruction?.days.find(day=>day.date===request.correctionDate&&day.proposedStart===request.proposedStartTime&&day.proposedEnd===request.proposedEndTime&&day.proposedBreakMinutes===(request.proposedBreakMinutes??0))
  const transfers=proposal?accounting!.initialImportReconstruction!.transfers.filter(transfer=>transfer.fromDate===request.correctionDate||transfer.toDate===request.correctionDate):[]
  return {entries,day,currentMinutes,currentBreakMinutes,proposedMinutes,overnight,deltaMinutes:proposedMinutes===undefined?undefined:proposedMinutes-currentMinutes,
    hasRunningEntry:entries.some(entry=>!entry.stoppedAt||entry.breaks.some(pause=>!pause.stoppedAt)),transfers,
    unallocated:proposal?accounting!.initialImportReconstruction!.unallocated.filter(item=>item.date===request.correctionDate):[]}
}
