import assert from 'node:assert/strict'
import test from 'node:test'
import type { TimeEntry, User } from '../shared/domain.ts'
import { dayIssuesForUsers } from '../server/dayIssues.ts'
import { dayIssueNeedsReview, groupMissingDayIssues } from '../shared/dayIssueReview.ts'
import { periodTotalsWithAccounting, type ZeitguruAccountingContext } from '../shared/timeAccounting.ts'
import { validateTimeCorrection } from '../server/requestEffects.ts'
import type { RequestItem } from '../shared/domain.ts'

const user: User = {
  id: 'user-1',
  name: 'Test User',
  email: 'test@example.com',
  role: 'employee',
  expectedWeeklyMinutes: 2_400,
  yearlyVacationDays: 30,
  balanceAdjustmentMinutes: 0,
  vacationAdjustmentDays: 0,
  trackingStartDate: '2026-01-01',
  employmentTerms: [],
  calendarAccessUserIds: [],
  active: true,
  mustChangePassword: false,
}

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 'entry-1',
    userId: user.id,
    date: '2026-08-31',
    startedAt: '2026-08-31T08:00:00.000Z',
    stoppedAt: '2026-08-31T19:15:00.000Z',
    breaks: [{ id: 'break-1', startedAt: '2026-08-31T12:00:00.000Z', stoppedAt: '2026-08-31T12:30:00.000Z' }],
    source: 'clock',
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T19:15:00.000Z',
    ...overrides,
  }
}

test('flags missing workdays and offers correction and absence requests', () => {
  const issues = dayIssuesForUsers([user], [], [], [], new Date('2026-09-02T12:00:00.000Z'))
  const missing = issues.find((issue) => issue.rule === 'missing_day' && issue.date === '2026-09-01')
  assert.ok(missing)
  assert.deepEqual(new Set(missing.suggestions.map((item) => item.action)), new Set(['time_correction', 'absence_request']))
  const correction = missing.suggestions.find((item) => item.action === 'time_correction')
  assert.deepEqual(correction?.draft, {
    type: 'time_correction',
    correctionDate: '2026-09-01',
    proposedStartTime: '09:00',
    proposedEndTime: '17:30',
    proposedBreakMinutes: '30',
    reason: 'Add missing work time / Fehlende Arbeitszeit ergänzen',
    reviewProposal: true,
  })
  const absence = missing.suggestions.find((item) => item.action === 'absence_request')
  assert.equal(absence?.draft?.startDate, '2026-09-01')
  assert.equal(absence?.draft?.endDate, '2026-09-01')
})

test('five consecutive missing weekdays become one range vacation request with all individual dates retained',()=>{
  const onlyWeek=dayIssuesForUsers([user],[],[],[],new Date('2026-09-07T12:00:00Z')).filter(issue=>issue.rule==='missing_day'&&issue.date>='2026-08-31'&&issue.date<='2026-09-04')
  const before=JSON.stringify(onlyWeek),grouped=groupMissingDayIssues(onlyWeek)
  assert.equal(grouped.length,1);assert.equal(grouped[0].relatedDates?.length,5)
  assert.equal(grouped[0].suggestions[0].draft?.type,'vacation');assert.equal(grouped[0].suggestions[0].draft?.startDate,'2026-08-31');assert.equal(grouped[0].suggestions[0].draft?.endDate,'2026-09-04')
  assert.equal(grouped[0].expectedMinutes,2400);assert.equal(JSON.stringify(onlyWeek),before)
})

test('missing-day grouping never spans recorded dates, employees, or the selected date filter',()=>{
  const missing=dayIssuesForUsers([user],[],[],[],new Date('2026-09-07T12:00:00Z')).filter(issue=>issue.rule==='missing_day'&&issue.date>='2026-08-31'&&issue.date<='2026-09-04')
  const separated=groupMissingDayIssues(missing.filter(issue=>issue.date!=='2026-09-02'))
  assert.equal(separated.length,2);assert(separated.every(issue=>issue.relatedDates?.length===2))
  const users=groupMissingDayIssues([...missing,...missing.map(issue=>({...issue,id:'other-'+issue.id,userId:'other'}))])
  assert.equal(users.length,2);assert.equal(new Set(users.map(issue=>issue.userId)).size,2)
  const filtered=groupMissingDayIssues(missing.filter(issue=>issue.date>='2026-09-02'))
  assert.equal(filtered[0].relatedDates?.length,3);assert.equal(filtered[0].suggestions[0].draft?.startDate,'2026-09-02')
})

test('flags ten-hour and short-break findings without fabricating an automatic fix', () => {
  const issues = dayIssuesForUsers([user], [entry()], [], [], new Date('2026-09-02T12:00:00.000Z'))
  assert.ok(issues.some((issue) => issue.rule === 'daily_ten_hour_limit'))
  const breakIssue = issues.find((issue) => issue.rule === 'insufficient_break')
  assert.ok(breakIssue)
  assert.ok(breakIssue.suggestions.some((suggestion) => suggestion.action === 'admin_review'))
})

test('imported over-ten-hour and short-break findings retain editable, confirmed correction proposals',()=>{
  const recorded=entry({source:'zeitguru',zeitguru:{workedMinutes:645,creditedMinutes:645,approved:true,readOnly:true,batchId:'synthetic-history'}})
  const before=JSON.stringify(recorded),context=importedContext({days:[{...importedContext().days[0],workedMinutes:645,creditedMinutes:645,exactDeltaMinutes:165}]})
  const issues=dayIssuesForUsers([user],[recorded],[],[],new Date('2026-09-02T12:00:00Z'),{[user.id]:context})
  const cap=issues.find(issue=>issue.rule==='daily_ten_hour_limit')!.suggestions.find(suggestion=>suggestion.draft)!.draft!
  assert.equal(cap.reviewProposal,true);assert.equal(cap.proposedStartTime,'10:00');assert.equal(cap.proposedEndTime,'20:45');assert.equal(cap.proposedBreakMinutes,'45')
  const validated=validateTimeCorrection({...cap,proposedBreakMinutes:Number(cap.proposedBreakMinutes)} as RequestItem)
  assert.equal((Date.parse(validated.stoppedAt)-Date.parse(validated.startedAt))/60000-validated.breakMinutes,600)
  assert.match(cap.reason!,/Only|only/)
  assert(issues.find(issue=>issue.rule==='daily_ten_hour_limit')!.suggestions.some(s=>s.action==='zeitguru_history'))
  const pause=issues.find(issue=>issue.rule==='insufficient_break')!.suggestions.find(s=>s.draft)!.draft!
  assert.equal(pause.proposedBreakMinutes,'45');assert.equal(pause.reviewProposal,true)
  assert.equal(JSON.stringify(recorded),before)
})

test('unclosed and automatic zero-hour proposals preserve the known start and use the daily schedule',()=>{
  for(const record of [entry({stoppedAt:undefined,breaks:[]}),entry({stoppedAt:'2026-09-01T08:00:00Z',manualBreakMinutes:1440,breaks:[],note:'counts as 0 hours until corrected'})]){
    const issues=dayIssuesForUsers([user],[record],[],[],new Date('2026-09-02T12:00:00Z'))
    const suggestion=issues.find(issue=>issue.rule===(record.stoppedAt?'automatic_zero_hour_close':'unclosed_entry'))!.suggestions[0].draft!
    assert.equal(suggestion.proposedStartTime,'10:00');assert.equal(suggestion.proposedEndTime,'18:30');assert.equal(suggestion.proposedBreakMinutes,'30')
  }
})

test('a split shift proposal preserves gaps instead of adding them to worked time',()=>{
  const morning=entry({startedAt:'2026-08-31T07:00:00Z',stoppedAt:'2026-08-31T10:00:00Z',breaks:[]})
  const afternoon=entry({id:'afternoon',startedAt:'2026-08-31T12:00:00Z',stoppedAt:'2026-08-31T16:00:00Z',breaks:[]})
  const issues=dayIssuesForUsers([user],[morning,afternoon],[],[],new Date('2026-09-02T12:00:00Z'))
  const proposal=issues.find(issue=>issue.rule==='insufficient_break')!.suggestions[0].draft!
  assert.equal(proposal.proposedBreakMinutes,'150')
  // Two existing non-work hours remain excluded; 30 additional minutes are explicitly only a proposal.
  const validated=validateTimeCorrection({...proposal,proposedBreakMinutes:Number(proposal.proposedBreakMinutes)} as RequestItem)
  assert.equal((Date.parse(validated.stoppedAt)-Date.parse(validated.startedAt))/60000-validated.breakMinutes,390)
})

test('an approved local import correction is information while independent source problems still need review',()=>{
  const context=importedContext({warnings:[{date:'2026-08-31',code:'native_correction_overrides_source'}]})
  const issues=dayIssuesForUsers([user],[],[],[],new Date('2026-09-02T12:00:00Z'),{[user.id]:context})
  assert(!issues.some(issue=>issue.rule==='zeitguru_history_review'))
  const applied=issues.find(issue=>issue.rule==='zeitguru_local_correction')!;assert(applied);assert.equal(dayIssueNeedsReview(applied),false)
  context.warnings.push({date:'2026-08-31',code:'source_opening_missing'})
  assert(dayIssuesForUsers([user],[],[],[],new Date('2026-09-02T12:00:00Z'),{[user.id]:context}).some(issue=>issue.rule==='zeitguru_history_review'))
})

test('flags overlapping and unclosed entries as data errors', () => {
  const entries = [
    entry({ id: 'one', stoppedAt: '2026-08-31T12:00:00.000Z', breaks: [] }),
    entry({ id: 'two', startedAt: '2026-08-31T11:00:00.000Z', stoppedAt: '2026-08-31T15:00:00.000Z', breaks: [] }),
    entry({ id: 'three', startedAt: '2026-08-31T16:00:00.000Z', stoppedAt: undefined, breaks: [] }),
  ]
  const rules = new Set(dayIssuesForUsers([user], entries, [], [], new Date('2026-09-02T12:00:00.000Z')).map((issue) => issue.rule))
  assert.ok(rules.has('overlapping_entries'))
  assert.ok(rules.has('unclosed_entry'))
})

test('ordinary overtime with an adequate break is informational and does not ask for a correction', () => {
  const ordinary = entry({ stoppedAt: '2026-08-31T17:00:00.000Z' })
  const issues = dayIssuesForUsers([user], [ordinary], [], [], new Date('2026-09-02T12:00:00.000Z'))
    .filter(issue => issue.date === ordinary.date)
  assert.deepEqual(new Set(issues.map(issue => issue.rule)), new Set(['schedule_variance', 'daily_eight_hour_warning']))
  assert.equal(issues.some(dayIssueNeedsReview), false)
  assert.deepEqual(issues.flatMap(issue => issue.suggestions), [])
})

test('a current active work or break timer is normal, while an old timer or unfinished break on a closed entry needs review', () => {
  const current = entry({ date: '2026-09-02', startedAt: '2026-09-02T08:00:00.000Z', stoppedAt: undefined, breaks: [] })
  const currentBreak = { ...current, breaks: [{ id: 'active-break', startedAt: '2026-09-02T11:30:00.000Z' }] }
  const reference = new Date('2026-09-02T12:00:00.000Z')
  for (const normal of [current, currentBreak]) {
    assert.equal(dayIssuesForUsers([user], [normal], [], [], reference).some(issue => issue.rule === 'unclosed_entry'), false)
  }
  const old = entry({ stoppedAt: undefined, breaks: [] })
  const closedWithOpenBreak = { ...currentBreak, stoppedAt: '2026-09-02T12:00:00.000Z' }
  for (const broken of [old, closedWithOpenBreak]) {
    const issue = dayIssuesForUsers([user], [broken], [], [], reference).find(issue => issue.rule === 'unclosed_entry')
    assert.ok(issue)
    assert.equal(dayIssueNeedsReview(issue), true)
  }
})

function importedContext(overrides: Partial<ZeitguruAccountingContext> = {}): ZeitguruAccountingContext {
  return {
    batchId: 'synthetic-history', fromDate: '2026-08-31', toDate: '2026-08-31', observedAt: '2026-09-02T12:00:00.000Z',
    openingKnown: true, balanceBasis: 'source_opening', openingBalanceMinutes: 0, closingBalanceMinutes: 30,
    days: [{ date: '2026-08-31', expectedMinutes: 480, workedMinutes: 510, absenceMinutes: 0, holidayMinutes: 0,
      correctionMinutes: 0, creditedMinutes: 510, balanceMinutes: 30, exactDeltaMinutes: 30 }],
    forecast: [], warnings: [], ...overrides,
  }
}

test('imported ordinary overtime has a view action, while source discrepancies and missing or overlapping entries still need review', () => {
  const ordinary = entry({ source: 'zeitguru', stoppedAt: '2026-08-31T17:00:00.000Z',
    zeitguru: { workedMinutes: 510, creditedMinutes: 510, approved: true, readOnly: true, batchId: 'synthetic-history' } })
  const context = importedContext()
  const reference = new Date('2026-09-02T12:00:00.000Z')
  const imported = dayIssuesForUsers([user], [ordinary], [], [], reference, { [user.id]: context }).filter(issue => issue.date === ordinary.date)
  assert.equal(imported.length, 2)
  for (const issue of imported) {
    assert.equal(dayIssueNeedsReview(issue), false)
    assert.deepEqual(issue.suggestions, [{ action: 'zeitguru_history', labelEn: 'View imported day', labelDe: 'Importierten Tag ansehen' }])
  }
  const unapproved = importedContext({ warnings: [{ date: ordinary.date, code: 'source_clock_unapproved' }] })
  const warning = dayIssuesForUsers([user], [ordinary], [], [], reference, { [user.id]: unapproved })
    .find(issue => issue.rule === 'zeitguru_history_review')
  assert.ok(warning)
  assert.equal(dayIssueNeedsReview(warning), true)
  assert.equal(warning.suggestions[0].labelEn, 'Review imported day')
  const missing = dayIssuesForUsers([user], [], [], [], reference).find(issue => issue.rule === 'missing_day')
  assert.ok(missing)
  assert.equal(dayIssueNeedsReview(missing), true)
  const overlap = dayIssuesForUsers([user], [ordinary, { ...ordinary, id: 'second-overlapping-entry' }], [], [], reference)
    .find(issue => issue.rule === 'overlapping_entries')
  assert.ok(overlap)
  assert.equal(dayIssueNeedsReview(overlap), true)
})

test('approved full-day overtime reduction is not missing attendance and retains its balance debit', () => {
  const context = importedContext({ closingBalanceMinutes: -480, days: [{ date: '2026-08-31', expectedMinutes: 480, workedMinutes: 0,
    absenceMinutes: 0, holidayMinutes: 0, correctionMinutes: 0, creditedMinutes: 0, balanceMinutes: -480, exactDeltaMinutes: -480,
    absence: { typeCode: 'overtimeReduction', typeName: 'Time off in lieu', startsHalfDay: false, endsHalfDay: false } }] })
  const reference = new Date('2026-09-02T12:00:00.000Z')
  const issues = dayIssuesForUsers([user], [], [], [], reference, { [user.id]: context }).filter(issue => issue.date === context.fromDate)
  assert.deepEqual(issues, [])
  assert.equal(periodTotalsWithAccounting(user, [], [], [], context.fromDate, context.toDate, context).plusMinusMinutes, -480)
  const partial = { ...context, days: [{ ...context.days[0], absence: { ...context.days[0].absence!, startsHalfDay: true } }] }
  assert.ok(dayIssuesForUsers([user], [], [], [], reference, { [user.id]: partial })
    .some(issue => issue.rule === 'missing_day' && issue.date === context.fromDate))
})
