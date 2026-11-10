import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZeitguruClientError, type ZeitguruTokens } from '../server/zeitguruClient.ts'
import { mapZeitguruHistoryRows, readZeitguruHistory, type ZeitguruHistoryProgress } from '../server/zeitguruHistoryProvider.ts'
import type { ZeitguruBinding, ZeitguruClockRow, ZeitguruObject, ZeitguruSnapshot } from '../server/zeitguruProtocol.ts'

const binding: ZeitguruBinding = { tenantId: 'test-company', userId: 'own-user', accountId: 'test-account', role: 'employee' }
const tokens: ZeitguruTokens = { idToken: 'synthetic-private-token', refreshToken: 'synthetic-private-refresh', expiresAt: Date.parse('2026-09-07T16:00:00Z') }
const throughDate = '2026-09-06'
const row = (change: Partial<ZeitguruClockRow> = {}): ZeitguruClockRow => {
  const result = { id: 'abc-clock', userId: binding.userId, branchId: 'office', date: '2026-09-01', startTime: '09:00', endTime: '17:00', breakMinutes: 30, isAccepted: true, ...change }
  return { ...result, userId_date: `${result.userId}_${result.date}` }
}
const snapshot = (): ZeitguruSnapshot => ({
  binding, tenant: { id: binding.tenantId, isV2: true }, profile: { id: binding.userId, accountId: binding.accountId, role: 'employee', branchIds: ['office'] },
  rosterSettings: { timezone: 'Europe/Berlin' }, clockSettings: {}, branches: [{ id: 'office', name: 'Current office' }], clockings: [], credits: {},
  observedAt: '2026-09-07T14:00:00Z', fromDate: throughDate, toDate: '2026-09-07', etags: {},
})
const errorCode = (code: string) => (error: unknown) => error instanceof ZeitguruClientError && error.code === code

test('archive mapping preserves exact raw punches, recorded breaks and source credit independently', () => {
  const source = row({ comment: 'Historical comment', breakActivities: [{ time: '12:00', type: 'start' }, { time: '12:30', type: 'end' }] })
  const mapped = mapZeitguruHistoryRows([source], { '2026-09-01': { abc: { C: 440 } } }, binding, throughDate, new Map([['office', 'Current office']]))
  assert.equal(mapped.rows.length, 1)
  const result = mapped.rows[0]
  assert.equal(result.startedAt, '2026-09-01T07:00:00.000Z'); assert.equal(result.stoppedAt, '2026-09-01T15:00:00.000Z')
  assert.equal(result.workedMinutes, 450); assert.equal(result.creditedMinutes, 440)
  assert.equal(result.branchName, 'Current office')
  assert.deepEqual(result.details.rawRow, source); assert.deepEqual(result.details.rawCredit, { C: 440 })
  assert.deepEqual(mapped.warnings, ['credit_duration_mismatch'])
  result.details.rawRow.comment = 'Changed archive copy'
  assert.equal(source.comment, 'Historical comment')
})

test('paid breaks, closed auto-outs and unapproved records remain faithful and visible', () => {
  const sources = [row({ id: 'pay-clock', isPaidBreak: true }), row({ id: 'out-clock', isAutoClockOut: true, isAccepted: false }), row({ id: 'unk-clock', isAccepted: undefined })]
  const mapped = mapZeitguruHistoryRows(sources, { '2026-09-01': { pay: { C: 480 } } }, binding, throughDate)
  const paid = mapped.rows.find((item) => item.sourceId === 'pay-clock')!, auto = mapped.rows.find((item) => item.sourceId === 'out-clock')!, unknown = mapped.rows.find((item) => item.sourceId === 'unk-clock')!
  assert.equal(paid.workedMinutes, 480); assert.equal(paid.breakMinutes, 30); assert.equal(paid.paidBreak, true)
  assert.equal(auto.creditedMinutes, 0); assert.equal(auto.autoClockOut, true); assert.equal(auto.approved, false)
  assert.equal(unknown.approved, null); assert.equal(unknown.creditedMinutes, null)
  assert.equal(mapped.skipped.count, 0); assert.ok(mapped.warnings.includes('automatic_clock_out')); assert.ok(mapped.warnings.includes('not_approved'))
})

test('credit prefix collisions include the 001 to 00z alias and never assign one shared credit twice', () => {
  const mapped = mapZeitguruHistoryRows([row({ id: '001-first' }), row({ id: '00z-second' })], { '2026-09-01': { '00z': { C: 450 } } }, binding, throughDate)
  assert.deepEqual(mapped.rows.map((item) => item.creditedMinutes), [null, null])
  assert.deepEqual(mapped.warnings, ['credit_prefix_collision'])
})

test('legacy or surcharge components retain raw evidence without presenting C as complete credit', () => {
  const credit = { C: 450, AA: 1.5, AP: 10, R: 30 }
  const mapped = mapZeitguruHistoryRows([row()], { '2026-09-01': { abc: credit } }, binding, throughDate)
  assert.equal(mapped.rows[0].creditedMinutes, null)
  assert.deepEqual(mapped.rows[0].details.rawCredit, credit)
  assert.deepEqual(mapped.warnings, ['additional_credit_components'])
})

test('zero-hour automatic closures retain the source timestamps and zero credit', () => {
  const mapped = mapZeitguruHistoryRows([row({ endTime: '09:00', breakMinutes: 0, isAutoClockOut: true })], { '2026-09-01': { abc: { C: 0 } } }, binding, throughDate)
  assert.equal(mapped.rows.length, 1); assert.equal(mapped.rows[0].startedAt, mapped.rows[0].stoppedAt)
  assert.equal(mapped.rows[0].workedMinutes, 0); assert.equal(mapped.rows[0].creditedMinutes, 0)
})

test('overnight rows and 24:00 retain source work duration while excluding a stop after yesterday', () => {
  const sources = [row({ id: 'one-clock', date: '2026-09-04', startTime: '22:00', endTime: '06:00' }), row({ id: 'mid-clock', date: '2026-09-04', startTime: '16:00', endTime: '24:00' }), row({ id: 'new-clock', date: throughDate, startTime: '22:00', endTime: '06:00' })]
  const mapped = mapZeitguruHistoryRows(sources, {}, binding, throughDate)
  assert.equal(mapped.rows.length, 2); assert.equal(mapped.skipped.count, 1)
  assert.deepEqual(mapped.skipped.reasons, ['outside_history_range'])
  assert.equal(mapped.rows.find((item) => item.sourceId === 'one-clock')?.stoppedAt, '2026-09-05T04:00:00.000Z')
  assert.ok(mapped.rows.every((item) => item.workedMinutes === 450))
})

test('ambiguous and nonexistent DST punches are skipped; unambiguous crossings keep vendor wall minutes', () => {
  const sources = [row({ id: 'gap-clock', date: '2026-03-29', startTime: '02:30', endTime: '04:00', breakMinutes: 0 }), row({ id: 'fold-clock', date: '2025-10-26', startTime: '02:30', endTime: '04:00', breakMinutes: 0 }), row({ id: 'ok-clock', date: '2026-03-29', startTime: '01:00', endTime: '04:00', breakMinutes: 0 })]
  const mapped = mapZeitguruHistoryRows(sources, {}, binding, throughDate)
  assert.equal(mapped.rows.length, 1); assert.equal(mapped.rows[0].workedMinutes, 180)
  assert.equal((Date.parse(mapped.rows[0].stoppedAt) - Date.parse(mapped.rows[0].startedAt)) / 60_000, 120)
  assert.equal(mapped.skipped.count, 2); assert.deepEqual(mapped.skipped.reasons, ['ambiguous_daylight_saving_time'])
  assert.ok(mapped.warnings.includes('wall_clock_duration_differs_from_elapsed'))
})

test('invalid and unfinished rows are skipped without inventing a 09:00 clock-in', () => {
  const sources = [row({ id: 'bad-clock', startTime: '' }), row({ id: 'act-clock', endTime: undefined }), row({ id: 'neg-clock', breakMinutes: -1 }), row({ id: 'flg-clock', isAccepted: 'yes' as unknown as boolean })]
  const mapped = mapZeitguruHistoryRows(sources, {}, binding, throughDate)
  assert.equal(mapped.rows.length, 0); assert.equal(mapped.skipped.count, 4)
  assert.deepEqual(mapped.skipped.reasons, ['invalid_history_row', 'unfinished_clock_row'])
  assert.throws(() => mapZeitguruHistoryRows([row({ userId: 'someone-else' })], {}, binding, throughDate), errorCode('identity_mismatch'))
  assert.throws(() => mapZeitguruHistoryRows([row(), row()], {}, binding, throughDate), errorCode('duplicate_history_identity'))
})

test('dated review metadata includes skipped and automatic source records without IDs or private notes', () => {
  const mapped = mapZeitguruHistoryRows([row({ id: 'unfinished-private-id', endTime: undefined, comment: 'private note' }), row({ id: 'automatic-private-id', date: '2026-09-02', isAutoClockOut: true })], {}, binding, throughDate)
  assert.ok(mapped.reviewDays.some((item) => item.date === '2026-09-01' && item.reason === 'unfinished_clock_row'))
  assert.ok(mapped.reviewDays.some((item) => item.date === '2026-09-02' && item.reason === 'automatic_clock_out'))
  assert.equal(JSON.stringify(mapped.reviewDays).includes('private'), false)
})

function fixture(first: string | null, sources: ZeitguruClockRow[] = []) {
  const calls: { type: string; from: string; to: string }[] = []
  const client = {
    async readSnapshot() { return snapshot() },
    async readOwnHistoryStart() { return first },
    async readOwnHistoryRange(_tokens: ZeitguruTokens, _binding: ZeitguruBinding, from: string, to: string) {
      calls.push({ type: 'rows', from, to }); return sources.filter((item) => item.date >= from && item.date <= to)
    },
    async readOwnCreditRange(_tokens: ZeitguruTokens, _binding: ZeitguruBinding, from: string, to: string): Promise<Record<string, ZeitguruObject>> {
      calls.push({ type: 'credits', from, to }); return {}
    },
  }
  return { client, calls }
}

test('complete history discovers the first date and sequentially reads full months including leap day', async () => {
  const f = fixture('2024-01-29', [row({ date: '2024-02-29' })]), progress: ZeitguruHistoryProgress[] = []
  const result = await readZeitguruHistory(f.client, tokens, binding, '2024-03-02', (value) => { progress.push(value) })
  assert.equal(result.fromDate, '2024-01-29'); assert.equal(result.toDate, '2024-03-02'); assert.equal(result.rows.length, 1)
  assert.deepEqual(f.calls, [
    { type: 'rows', from: '2024-01-29', to: '2024-01-31' }, { type: 'credits', from: '2024-01-29', to: '2024-01-31' },
    { type: 'rows', from: '2024-02-01', to: '2024-02-29' }, { type: 'credits', from: '2024-02-01', to: '2024-02-29' },
    { type: 'rows', from: '2024-03-01', to: '2024-03-02' }, { type: 'credits', from: '2024-03-01', to: '2024-03-02' },
  ])
  assert.deepEqual(progress.at(-1), { completedMonths: 3, totalMonths: 3, rowsRead: 1 })
  assert.equal(JSON.stringify(progress).includes(tokens.idToken), false)
})

test('empty history is explicit and never probes guessed dates', async () => {
  const f = fixture(null), result = await readZeitguruHistory(f.client, tokens, binding, throughDate)
  assert.equal(result.fromDate, null); assert.deepEqual(result.rows, []); assert.equal(f.calls.length, 0)
})

test('limits and failed later reads throw instead of returning a seemingly complete partial archive', async () => {
  const old = fixture('2000-01-01')
  await assert.rejects(readZeitguruHistory(old.client, tokens, binding, throughDate), errorCode('history_limit_exceeded'))
  assert.equal(old.calls.length, 0)
  const excessive = fixture('2026-09-01', Array.from({ length: 10_001 }, (_, index) => row({ id: `id-${index}` })))
  await assert.rejects(readZeitguruHistory(excessive.client, tokens, binding, throughDate), errorCode('history_limit_exceeded'))
  assert.equal(excessive.calls.filter((call) => call.type === 'credits').length, 0)
  const failure = fixture('2026-08-01', [row({ date: '2026-08-01' })])
  failure.client.readOwnCreditRange = async (_tokens, _binding, from) => { if (from >= '2026-09-01') throw new ZeitguruClientError('rate_limited', 429); return {} }
  await assert.rejects(readZeitguruHistory(failure.client, tokens, binding, throughDate), errorCode('rate_limited'))
})

test('current-day, unsupported timezone and changed own-account bindings fail before history reads', async () => {
  const f = fixture('2026-09-01')
  await assert.rejects(readZeitguruHistory(f.client, tokens, binding, '2026-09-07'), errorCode('outside_history_range'))
  f.client.readSnapshot = async () => ({ ...snapshot(), rosterSettings: { timezone: 'America/New_York' } })
  await assert.rejects(readZeitguruHistory(f.client, tokens, binding, throughDate), errorCode('unsupported_timezone'))
  f.client.readSnapshot = async () => ({ ...snapshot(), binding: { ...binding, userId: 'other-person' } })
  await assert.rejects(readZeitguruHistory(f.client, tokens, binding, throughDate), errorCode('identity_mismatch'))
  assert.equal(f.calls.length, 0)
})
