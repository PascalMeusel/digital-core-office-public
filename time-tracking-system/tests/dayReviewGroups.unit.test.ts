import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DayIssue } from '../shared/domain.ts'
import { dayReviewBucket, dayReviewGroups } from '../shared/dayReviewGroups.ts'
const issue=(id:string,date:string,extra:Partial<DayIssue>={}):DayIssue=>({id,date,userId:'one',rule:'zeitguru_history_review',severity:'warning',category:'data',titleEn:'Review',titleDe:'Prüfen',messageEn:'Source note',messageDe:'Quellhinweis',suggestions:[],...extra})
test('multiple findings share one day row while employee boundaries and original actions remain intact',()=>{
 const input=[issue('a','2026-09-01'),issue('b','2026-09-01',{rule:'insufficient_break',severity:'error'}),issue('c','2026-09-01',{userId:'two'})],before=structuredClone(input)
 const groups=dayReviewGroups(input)
 assert.equal(groups.length,2);assert.equal(groups[0].issues.length,2);assert.equal(groups[0].severity,'error');assert.deepEqual(input,before)
})
test('consecutive missing days retain a grouped vacation action and all covered dates',()=>{
 const groups=dayReviewGroups(['2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28'].map(date=>issue(date,date,{rule:'missing_day'})))
 assert.equal(groups.length,1);assert.equal(groups[0].from,'2026-08-24');assert.equal(groups[0].to,'2026-08-28')
 assert.equal(groups[0].issues[0].relatedDates?.length,5);assert.equal(groups[0].issues[0].suggestions[0].draft?.type,'vacation')
})
test('initial import proposals stay separate from historical checks and current unresolved findings',()=>{
 assert.equal(dayReviewBucket(issue('a','2026-09-01')),'attention')
 assert.equal(dayReviewBucket(issue('b','2026-09-01',{initialImportReview:true,rule:'zeitguru_import_reconstruction'})),'proposals')
 assert.equal(dayReviewBucket(issue('c','2026-09-01',{initialImportReview:true,rule:'daily_ten_hour_limit'})),'information')
 assert.equal(dayReviewBucket(issue('d','2026-09-01',{rule:'daily_eight_hour_warning'})),'information')
})
