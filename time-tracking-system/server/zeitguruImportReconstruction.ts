import type { AbsenceDay, Holiday, TimeEntry } from '../shared/domain.ts'
import type { ImportReconstruction, ImportReconstructionDay, ZeitguruAccountingPublicDay } from '../shared/timeAccounting.ts'
import { businessDateKey, businessTimeMinutes, isoFromDateAndTime, parseDateKey } from '../shared/dates.ts'

interface Slot { date: string; start: number; end: number; work: number; pause: number; originalStart?: number; originalEnd?: number; originalWork: number; reasons: ImportReconstructionDay['reasons'] }
const minute = 60_000, rest = 660 * minute
const time = (epoch: number) => { const minutes=businessTimeMinutes(new Date(epoch));return `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}` }
const breakFor = (work: number) => work > 540 ? 45 : work > 360 ? 30 : 0

/** Migration estimates only. Never mutates attendance, credits or the source archive. */
export function planImportReconstruction(input: { throughDate: string; days: ZeitguruAccountingPublicDay[]; entries: TimeEntry[]; native: TimeEntry[]; holidays: Holiday[]; absences: AbsenceDay[]; uncertainDates: string[] }): ImportReconstruction {
  const plan: ImportReconstruction={version:1,throughDate:input.throughDate,days:[],transfers:[],unallocated:[]}
  const blocked=new Set([...input.uncertainDates,...input.holidays.map(day=>day.date),...input.absences.map(day=>day.date),...input.days.filter(day=>day.absence||day.importClassification||day.absenceMinutes||day.holidayMinutes).map(day=>day.date),...input.native.filter(entry=>entry.source!=='approved_correction').map(entry=>entry.date)])
  const rows=new Map<string,TimeEntry[]>()
  for(const entry of input.entries.filter(entry=>entry.date<=input.throughDate))rows.set(entry.date,[...(rows.get(entry.date)??[]),entry])
  const slots=new Map<string,Slot>()
  // Preserve elapsed/credit ambiguities as manual review; do not guess across DST or source conflicts.
  for(const day of input.days.filter(day=>day.date<=input.throughDate)){
    if(blocked.has(day.date))continue
    const entries=rows.get(day.date)??[],weekday=parseDateKey(day.date).getDay()
    if(weekday===0||(!entries.length&&weekday!==6))continue
    if(entries.some(entry=>entry.zeitguru?.approved!==true||entry.zeitguru.creditedMinutes!==entry.zeitguru.workedMinutes||!entry.stoppedAt))continue
    const ordered=[...entries].sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt))
    if(ordered.some((entry,index)=>index>0&&Date.parse(entry.startedAt)<Date.parse(ordered[index-1].stoppedAt!)))continue
    const start=ordered.length?Date.parse(ordered[0].startedAt):Date.parse(isoFromDateAndTime(day.date,'09:00'))
    const end=ordered.length?Date.parse(ordered.at(-1)!.stoppedAt!):start
    const work=ordered.reduce((sum,entry)=>sum+entry.zeitguru!.workedMinutes,0),pause=Math.round((end-start)/minute)-work
    if(!Number.isSafeInteger(work)||work<0||pause<0||businessDateKey(new Date(end))!==day.date||ordered.some(entry=>Math.abs((Date.parse(entry.stoppedAt!)-Date.parse(entry.startedAt))/minute-(entry.manualBreakMinutes??0)-entry.zeitguru!.workedMinutes)>1))continue
    if(ordered.length&&Math.abs(day.workedMinutes-work)>1)continue
    slots.set(day.date,{date:day.date,start,end,work,pause,originalStart:ordered.length?start:undefined,originalEnd:ordered.length?end:undefined,originalWork:work,reasons:[]})
  }
  const occupied = () => [...input.entries.filter(entry=>entry.stoppedAt).map(entry=>({date:entry.date,start:Date.parse(entry.startedAt),end:Date.parse(entry.stoppedAt!)})),...input.native.filter(entry=>entry.stoppedAt&&entry.source!=='approved_correction').map(entry=>({date:entry.date,start:Date.parse(entry.startedAt),end:Date.parse(entry.stoppedAt!)}))].filter(entry=>!slots.has(entry.date)).concat([...slots.values()].filter(slot=>slot.work>0).map(slot=>({date:slot.date,start:slot.start,end:slot.end})))
  const pending:Array<{slot:Slot;minutes:number}>=[]
  for(const slot of [...slots.values()].sort((a,b)=>a.date.localeCompare(b.date))){
    if(!slot.work)continue
    const previous=occupied().filter(other=>other.date<slot.date).sort((a,b)=>b.end-a.end)[0]
    const needsRest=previous&&slot.start-previous.end<rest,needsCap=slot.work>600
    if(!needsRest&&!needsCap)continue
    const start=needsRest?previous.end+rest:slot.start
    const pause=Math.max(slot.pause,breakFor(Math.min(600,slot.work)))
    const work=Math.min(600,slot.work,Math.floor((slot.end-start)/minute)-pause)
    if(work<=0||businessDateKey(new Date(start))!==slot.date)continue
    if(needsRest)slot.reasons.push('eleven_hours')
    if(needsCap)slot.reasons.push('ten_hours')
    slot.start=start;slot.work=work;slot.pause=pause;slot.end=start+(work+pause)*minute
    pending.push({slot,minutes:slot.originalWork-work})
  }
  for(const source of pending){
    let remaining=source.minutes
    const candidates=[...slots.values()].filter(slot=>slot.date!==source.slot.date&&slot.date.slice(0,7)===source.slot.date.slice(0,7)&&!slot.reasons.includes('ten_hours')&&!slot.reasons.includes('eleven_hours')&&slot.work<600)
      .sort((a,b)=>Number(parseDateKey(a.date).getDay()===6)-Number(parseDateKey(b.date).getDay()===6)||Math.abs(Date.parse(a.date)-Date.parse(source.slot.date))-Math.abs(Date.parse(b.date)-Date.parse(source.slot.date))||a.date.localeCompare(b.date))
    for(const target of candidates){
      if(!remaining)break
      const other=occupied().filter(slot=>slot.date!==target.date)
      const previous=other.filter(slot=>slot.date<target.date).sort((a,b)=>b.end-a.end)[0],next=other.filter(slot=>slot.date>target.date).sort((a,b)=>a.start-b.start)[0]
      const start=target.work?target.start:Math.max(target.start,previous?previous.end+rest:target.start)
      if(previous&&start-previous.end<rest)continue
      const ceiling=Math.min(Date.parse(isoFromDateAndTime(target.date,'23:59')),next?next.start-rest:Infinity)
      let added=Math.min(remaining,600-target.work)
      while(added>0&&start+(target.work+added+Math.max(target.pause,breakFor(target.work+added)))*minute>ceiling)added--
      if(!added||businessDateKey(new Date(start))!==target.date)continue
      target.start=start;target.work+=added;target.pause=Math.max(target.pause,breakFor(target.work));target.end=start+(target.work+target.pause)*minute
      if(!target.reasons.includes('receives_time'))target.reasons.push('receives_time')
      plan.transfers.push({fromDate:source.slot.date,toDate:target.date,minutes:added});remaining-=added
    }
    if(remaining)plan.unallocated.push({date:source.slot.date,minutes:remaining})
  }
  for(const slot of slots.values()){
    if(!slot.reasons.length)continue
    const native=input.native.filter(entry=>entry.date===slot.date)
    const match=native.length===1&&native[0].source==='approved_correction'&&Date.parse(native[0].startedAt)===slot.start&&Date.parse(native[0].stoppedAt??'')===slot.end&&(native[0].manualBreakMinutes??0)===slot.pause&&native[0].breaks.length===0
    plan.days.push({date:slot.date,originalStart:slot.originalStart===undefined?undefined:time(slot.originalStart),originalEnd:slot.originalEnd===undefined?undefined:time(slot.originalEnd),originalMinutes:slot.originalWork,proposedStart:time(slot.start),proposedEnd:time(slot.end),proposedBreakMinutes:slot.pause,proposedMinutes:slot.work,reasons:slot.reasons,status:match?'applied':native.length?'changed':'proposal'})
  }
  plan.days.sort((a,b)=>a.date.localeCompare(b.date))
  return plan
}

