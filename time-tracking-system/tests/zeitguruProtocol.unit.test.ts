import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allocateZeitguruClockId, planZeitguruTransition, zeitguruCreditPrefix, zeitguruRuleBreakMinutes,
  ZeitguruProtocolError, type ZeitguruClockRow, type ZeitguruSnapshot,
} from '../server/zeitguruProtocol.ts'

function snapshot(occurredAt = '2026-09-07T14:00:00.000Z'): ZeitguruSnapshot {
  return {
    binding: { tenantId: 'company', userId: 'employee', accountId: 'account', role: 'employee' },
    tenant: { id: 'company', isV2: true }, profile: { id: 'employee', accountId: 'account', role: 'employee', branchIds: ['office'], jobPositionIds: ['engineer'] },
    clockSettings: { allowUserTimClockInBrowser: true, breaksNeedToBeClocked: true, applyAtLeastPlannedBreakTime: false, clockingsAreAutoApprovedV2: true, capEarlyClockinsV2: false },
    rosterSettings: { timezone: 'Europe/Berlin', breakRules: [{ workingHours: 6, workingMinutes: 0, breakMinutes: 30, isActive: true }], specifications: { canMakeAnnouncements: { roleTypes: ['admin'] } } },
    branches: [{ id: 'office', isClockingEnabled: true }], clockings: [], credits: { '2026-09-06': {}, '2026-09-07': {} },
    observedAt: occurredAt, fromDate: '2026-09-06', toDate: '2026-09-07', etags: {},
  }
}
function row(overrides: Partial<ZeitguruClockRow> = {}): ZeitguruClockRow {
  return { id: 'abc-clock', userId: 'employee', branchId: 'office', jobPositionId: 'engineer', date: '2026-09-07', startTime: '08:00', breakMinutes: 0, logS: 'B_employee_123', branchId_date: 'office_2026-09-07', userId_date: 'employee_2026-09-07', extraPreserved: { reference: 'synthetic' }, ...overrides }
}
const code = (expected: string) => (error: unknown) => error instanceof ZeitguruProtocolError && error.code === expected

test('start plans original minute and browser actor, retains row identity and does not create premature credit', () => {
  const state = snapshot(), before = structuredClone(state)
  const result = planZeitguruTransition(state, { action: 'start_work', occurredAt: '2026-09-07T13:59:30.000Z', expectedRow: null, branchId: 'office', remoteClockId: 'New-stable-row' })
  assert.equal(result.desiredRow.startTime, '15:59')
  assert.equal(result.desiredRow.date, '2026-09-07')
  assert.equal(result.desiredRow.logS, `B_employee_${Date.parse('2026-09-07T13:59:30.000Z') / 1000}`)
  assert.deepEqual(Object.keys(result.patch), ['timeClockings/New-stable-row'])
  assert.equal(result.expectedRow, null)
  assert.deepEqual(state, before)
})

test('recorded break precedence preserves actual 15 minutes despite the six-hour 30-minute rule', () => {
  const state = snapshot(), current = row({ breakActivities: [{ time: '09:00', type: 'start' }, { time: '09:15', type: 'end' }], breakMinutes: 15 })
  state.clockings = [current]
  const result = planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: structuredClone(current) })
  assert.equal(result.desiredRow.breakMinutes, 15)
  assert.equal(result.patch['credits/employee_2026-09-07/abc/C'], 465)
  assert.equal(result.desiredRow.isAccepted, true)
  assert.deepEqual(result.desiredRow.extraPreserved, { reference: 'synthetic' })
  assert.equal(current.endTime, undefined)
  state.clockSettings.applyAtLeastPlannedBreakTime = true
  assert.equal(planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: current }).desiredRow.breakMinutes, 30)
  state.clockSettings.breaksNeedToBeClocked = false
  state.clockSettings.applyAtLeastPlannedBreakTime = false
  assert.equal(planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: current }).desiredRow.breakMinutes, 30)
})

test('break transitions alternate; stop during break counts it without adding a synthetic stored end event', () => {
  const state = snapshot('2026-09-07T10:00:00.000Z'), current = row()
  state.clockings = [current]
  const paused = planZeitguruTransition(state, { action: 'start_break', occurredAt: state.observedAt, expectedRow: current })
  assert.deepEqual(paused.desiredRow.breakActivities, [{ time: '12:00', type: 'start' }])
  assert.equal(paused.patch['credits/employee_2026-09-07/abc/C'], null)
  state.clockings = [paused.desiredRow]; state.observedAt = '2026-09-07T10:25:00.000Z'
  assert.throws(() => planZeitguruTransition(state, { action: 'start_break', occurredAt: state.observedAt, expectedRow: paused.desiredRow }), code('invalid_clock_transition'))
  const resumed = planZeitguruTransition(state, { action: 'stop_break', occurredAt: state.observedAt, expectedRow: paused.desiredRow })
  assert.equal(resumed.desiredRow.breakMinutes, 25)
  assert.deepEqual(resumed.desiredRow.breakActivities?.at(-1), { time: '12:25', type: 'end' })
  const stopped = planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: paused.desiredRow })
  assert.equal(stopped.desiredRow.breakMinutes, 25)
  assert.equal(stopped.desiredRow.breakActivities?.length, 1)
})

test('overnight work and breaks retain the original date and credit bucket', () => {
  const state = snapshot('2026-09-07T00:00:00.000Z'), current = row({ date: '2026-09-06', startTime: '23:00', branchId_date: 'office_2026-09-06', userId_date: 'employee_2026-09-06', breakActivities: [{ time: '23:50', type: 'start' }, { time: '00:10', type: 'end' }] })
  state.clockings = [current]
  const result = planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: current })
  assert.equal(result.desiredRow.breakMinutes, 20)
  assert.equal(result.desiredRow.endTime, '02:00')
  assert.equal(result.patch['credits/employee_2026-09-06/abc/C'], 160)
})

test('rule thresholds, exceeding-only and preceding-rule precedence follow V2 semantics', () => {
  const base = { breakRules: [{ workingHours: 6, workingMinutes: 0, breakMinutes: 30 }, { workingHours: 9, breakMinutes: 15 }] }
  assert.equal(zeitguruRuleBreakMinutes(base, 359), 0)
  assert.equal(zeitguruRuleBreakMinutes(base, 360), 30)
  assert.equal(zeitguruRuleBreakMinutes({ ...base, breakRulesOnlyOnExceedingMinutes: true }, 360), 0)
  assert.equal(zeitguruRuleBreakMinutes({ ...base, breakRulesOnlyOnExceedingMinutes: true }, 370), 10)
  assert.equal(zeitguruRuleBreakMinutes({ ...base, breakRulesOnlyOnExceedingMinutes: true, breakRulesIncludePrecidingBreakMinutes: true }, 545), 35)
  assert.equal(zeitguruRuleBreakMinutes({ ...base, breakRulesIncludePrecidingBreakMinutes: true }, 545), 15)
  assert.throws(() => zeitguruRuleBreakMinutes({ breakRules: [{ workingHours: 6, breakMinutes: 30, isActive: false }] }, 400), code('unsupported_break_rules'))
})

test('checkpoint conflicts, duplicate active rows, stale events and invalid break history fail closed', () => {
  const state = snapshot(), current = row()
  state.clockings = [current]
  assert.throws(() => planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: { ...current, comment: 'external-edit' } }), code('remote_conflict'))
  assert.throws(() => planZeitguruTransition(state, { action: 'stop_work', occurredAt: '2026-09-07T13:00:00Z', expectedRow: current }), code('stale_event'))
  state.clockings.push(row({ id: 'def-other' }))
  assert.throws(() => planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: current }), code('multiple_active_rows'))
  state.clockings = [row({ breakActivities: [{ time: '10:00', type: 'end' }] })]
  assert.throws(() => planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: state.clockings[0] }), code('invalid_break_history'))
})

test('forbidden branches, disabled browser clocking, relevant personalization, caps and DST ambiguity are rejected', () => {
  for (const change of [(state: ZeitguruSnapshot) => { state.clockSettings.allowUserTimClockInBrowser = false }, (state: ZeitguruSnapshot) => { state.clockSettings.specifications = { breaksNeedToBeClocked: { userIds: ['employee'] } } }, (state: ZeitguruSnapshot) => { state.clockSettings.capEarlyClockinsV2 = true }, (state: ZeitguruSnapshot) => { state.rosterSettings.breaksArePaid = true }, (state: ZeitguruSnapshot) => { state.branches[0].isClockingEnabled = false }]) {
    const state = snapshot(); change(state)
    assert.throws(() => planZeitguruTransition(state, { action: 'start_work', occurredAt: state.observedAt, expectedRow: null, branchId: 'office', remoteClockId: 'New-row' }), ZeitguruProtocolError)
  }
  const state = snapshot('2026-10-25T03:00:00Z'), current = row({ date: '2026-10-25', startTime: '01:00', branchId_date: 'office_2026-10-25', userId_date: 'employee_2026-10-25' })
  state.fromDate = '2026-10-24'; state.toDate = '2026-10-25'; state.credits = { '2026-10-25': {} }; state.clockings = [current]
  assert.throws(() => planZeitguruTransition(state, { action: 'stop_work', occurredAt: state.observedAt, expectedRow: current }), code('ambiguous_daylight_saving_time'))
})

test('random IDs avoid occupied credit prefixes, including orphan credit and 001 alias; collisions block writes', () => {
  const state = snapshot()
  state.clockings = [row({ endTime: '09:00' })]
  state.credits['2026-09-07'] = { New: { C: 12 }, '00z': { C: 15 } }
  for (const id of ['abc-different-row', 'New-different-row', '001-special-row']) assert.throws(() => planZeitguruTransition(state, { action: 'start_work', occurredAt: state.observedAt, expectedRow: null, branchId: 'office', remoteClockId: id }), code('clock_id_collision'))
  const id = allocateZeitguruClockId(state, '2026-09-07')
  assert.equal(['abc', 'New', '00z'].includes(zeitguruCreditPrefix(id)), false)
  assert.equal(planZeitguruTransition(state, { action: 'start_work', occurredAt: state.observedAt, expectedRow: null, branchId: 'office', remoteClockId: id }).desiredRow.id, id)
})
