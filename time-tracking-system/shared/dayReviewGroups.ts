import type { DayIssue } from './domain.ts'
import { dayIssueNeedsReview, groupMissingDayIssues } from './dayIssueReview.ts'

export type DayReviewBucket = 'attention' | 'proposals' | 'information'
export function dayReviewBucket(issue: DayIssue): DayReviewBucket {
  if (dayIssueNeedsReview(issue)) return 'attention'
  return issue.rule === 'zeitguru_import_reconstruction' ? 'proposals' : 'information'
}
export interface DayReviewGroup { id:string; userId:string; from:string; to:string; issues:DayIssue[]; severity:DayIssue['severity'] }
export function dayReviewGroups(issues:DayIssue[]):DayReviewGroup[] {
  const groups=new Map<string,DayReviewGroup>(),severity={error:0,warning:1,info:2}
  for(const issue of groupMissingDayIssues(issues)){
    const to=issue.relatedDates?.at(-1)??issue.date,id=`${issue.userId}:${issue.date}:${to}`
    const group=groups.get(id)??{id,userId:issue.userId,from:issue.date,to,issues:[],severity:issue.severity}
    group.issues.push(issue)
    if(severity[issue.severity]<severity[group.severity])group.severity=issue.severity
    groups.set(id,group)
  }
  return [...groups.values()].sort((a,b)=>b.from.localeCompare(a.from)||a.userId.localeCompare(b.userId))
}
