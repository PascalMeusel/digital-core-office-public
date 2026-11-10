import type { Holiday, TimeEntry } from '../shared/domain.ts'
import type { ZeitguruAccountingDay } from '../shared/zeitguruAccounting.ts'
import type { ZeitguruAccountingPublicDay } from '../shared/timeAccounting.ts'
import type { ZeitguruHistoryInputRow } from './zeitguruHistoryStore.ts'

/** ExampleCompany's explicitly requested historical import convention, never a native clock rule. */
export function classifyLegacyAbsence(day: ZeitguruAccountingDay, rows: ZeitguruHistoryInputRow[], native: TimeEntry[], holidays: Holiday[]): ZeitguruAccountingPublicDay['importClassification'] {
  if(!rows.length||native.some(entry=>entry.date===day.date)
    ||rows.some(row=>row.approved!==true||row.breakMinutes!==0||row.creditedMinutes===null||(row.details.rawRow as {isAutoClockOut?:unknown}|undefined)?.isAutoClockOut===true)
    ||rows.reduce((sum,row)=>sum+row.workedMinutes,0)!==480)return
  const ordered=[...rows].sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt))
  if(ordered.some((row,index)=>!Number.isFinite(Date.parse(row.startedAt))||!Number.isFinite(Date.parse(row.stoppedAt))||(index>0&&Date.parse(row.startedAt)<Date.parse(ordered[index-1].stoppedAt))))return
  if(day.absence){
    if(day.absence.startsHalfDay||day.absence.endsHalfDay||!['vacation','illness'].includes(day.absence.typeCode))return
    if(holidays.some(holiday=>holiday.date===day.date&&holiday.freePercent===100))return{type:'holiday',basis:'company_calendar',originalWorkedMinutes:480,version:1}
    return{type:day.absence.typeCode as 'vacation'|'illness',basis:'source_absence',originalWorkedMinutes:480,version:1}
  }
  if(day.workedMinutes!==480)return
  const comments=rows.map(row=>String((row.details.rawRow as {comment?:unknown}|undefined)?.comment??'')).join(' ')
  const commentType=/\bfeiertag\b|\bpublic holiday\b/i.test(comments)?'holiday':/\burlaub\b|\bvacation\b/i.test(comments)?'vacation':/\bkrank\b|\bsick\b|\billness\b/i.test(comments)?'illness':undefined
  const holiday=holidays.some(holiday=>holiday.date===day.date&&holiday.freePercent===100)
  return{type:holiday?'holiday':commentType??'vacation',basis:holiday?'company_calendar':commentType?'source_comment':'company_8h_zero_break',originalWorkedMinutes:480,version:1}
}
