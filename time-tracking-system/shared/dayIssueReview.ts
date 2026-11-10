import type { DayIssue } from './domain.ts'
import { addDays } from './dates.ts'

/** Normal schedule differences and eight-hour advisories do not require a day correction. */
export function dayIssueNeedsReview(issue: DayIssue): boolean {
  return !issue.initialImportReview && issue.rule !== 'daily_eight_hour_warning'
    && issue.rule !== 'zeitguru_local_correction'
    && !(issue.rule === 'schedule_variance' && issue.severity === 'info')
}

/** Group only adjacent missing calendar dates for the same employee. Never span a recorded day. */
export function groupMissingDayIssues(issues: DayIssue[]): DayIssue[] {
  const groups: DayIssue[][]=[]
  const missing=issues.filter(issue=>issue.rule==='missing_day').sort((a,b)=>a.userId.localeCompare(b.userId)||a.date.localeCompare(b.date))
  for(const issue of missing){
    const group=groups.at(-1),previous=group?.at(-1)
    if(previous?.userId===issue.userId&&addDays(previous.date,1)===issue.date)group!.push(issue)
    else groups.push([issue])
  }
  const replacement=new Map<string,DayIssue>(),hidden=new Set<string>()
  for(const group of groups.filter(group=>group.length>1)){
    const first=group[0],last=group.at(-1)!,dates=group.map(issue=>issue.date)
    replacement.set(first.id,{...first,id:`missing-range-${first.id}`,relatedDates:dates,
      titleEn:'Consecutive workdays without entries',titleDe:'Mehrere Arbeitstage ohne Einträge',
      messageEn:`${dates.length} consecutive days have no recorded work or approved absence. Request vacation for this range if it was leave.`,
      messageDe:`Für ${dates.length} aufeinanderfolgende Tage fehlen Arbeitszeit oder genehmigte Abwesenheit. Bei Urlaub einen Antrag für diesen Zeitraum stellen.`,
      expectedMinutes:group.reduce((sum,issue)=>sum+(issue.expectedMinutes??0),0),
      suggestions:[{action:'absence_request',labelEn:'Request vacation for this period',labelDe:'Urlaub für diesen Zeitraum beantragen',draft:{type:'vacation',startDate:first.date,endDate:last.date,reason:`Vacation for untracked period ${first.date} – ${last.date} / Urlaub für nicht erfassten Zeitraum ${first.date} – ${last.date}`}}]})
    for(const issue of group.slice(1))hidden.add(issue.id)
  }
  return issues.filter(issue=>!hidden.has(issue.id)).map(issue=>replacement.get(issue.id)??issue).sort((a,b)=>b.date.localeCompare(a.date))
}
