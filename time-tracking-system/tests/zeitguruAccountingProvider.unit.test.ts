import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZeitguruClientError, type ZeitguruClient, type ZeitguruTokens } from '../server/zeitguruClient.ts'
import { calculateZeitguruAccounting, readZeitguruAccounting, zeitguruDailySourceCredits, zeitguruExpectedMinutes, type ZeitguruAccountingSource } from '../server/zeitguruAccountingProvider.ts'
import type { ZeitguruObject, ZeitguruSnapshot } from '../server/zeitguruProtocol.ts'

const binding = { tenantId: 'synthetic-company', userId: 'own-employee', accountId: 'own-firebase-account', role: 'employee' }
const weekly = (values: ZeitguruObject = {}): ZeitguruObject => ({ id: 'contract-1', userId: binding.userId, validFrom: '2000-01-01', validTo: '2200-12-31', interval: 'weekly', totalHours: 40,
  dailyQuota: { mo: 480, tu: 480, we: 480, th: 480, fr: 480, sa: null, su: null }, applyQuotaOnHolidays: true, ...values })
function fixture(): ZeitguruAccountingSource {
  const snapshot: ZeitguruSnapshot = { binding, tenant: { id: binding.tenantId, isV2: true }, profile: { id: binding.userId, accountId: binding.accountId, role: binding.role },
    rosterSettings: { timezone: 'Europe/Berlin' }, clockSettings: {}, branches: [], clockings: [], credits: {}, observedAt: '2026-09-07T10:00:00Z', fromDate: '2026-09-06', toDate: '2026-09-07', etags: {} }
  return { snapshot, contracts: [weekly()], creditCorrections: [], absences: [], absenceTypes: [], holidays: [], credits: {} }
}
const range = (fromDate: string, toDate = fromDate) => ({ fromDate, toDate, forecastThroughDate: toDate })
const errorCode = (code: string) => (error: unknown) => error instanceof ZeitguruClientError && error.code === code
function absence(source: ZeitguruAccountingSource, values: ZeitguruObject = {}, type: ZeitguruObject = {}) {
  const row = { id: 'absence-1', userId: binding.userId, typeId: 'vacation-type', typeCode: 'vacation', startDate: '2024-06-03', endDate: '2024-06-03', status: 'active', earning: 'dailyQuota', ...values }
  source.absences.push(row)
  source.absenceTypes.push({ id: row.typeId, code: row.typeCode, name: 'Source absence', ...type })
}

test('dated source contracts apply 30 then 40 hours without inferring employment from the year-2000 default', () => {
  const source = fixture()
  source.contracts = [weekly({ validTo: '2024-07-31', totalHours: 30, dailyQuota: { mo: 360, tu: 360, we: 360, th: 360, fr: 360 }, applyQuotaOnHolidays: false }), weekly({ id: 'contract-2', validFrom: '2024-08-01' })]
  source.credits = { '2024-07-31': { abc: { C: 360 } }, '2024-08-01': { def: { C: 480 } } }
  const report = calculateZeitguruAccounting(source, range('2024-07-31', '2024-08-01'))
  assert.equal(report.fromDate, '2024-07-31'); assert.deepEqual(report.days.map((day) => day.expectedMinutes), [360, 480])
  assert.equal(report.closingBalanceMinutes, 0); assert.equal(report.openingKnown, false); assert.equal(report.balanceBasis, 'period_delta')
  assert.ok(report.warnings.includes('source_opening_balance_not_configured'))
})

test('source initial credit anchors before the first punch and manual corrections alter the exact running balance', () => {
  const source = fixture()
  source.creditCorrections = [
    { id: 'initial', userId: binding.userId, type: 'initial', date: '2024-06-01', minutes: 120 },
    { id: 'manual', userId: binding.userId, type: 'manual', date: '2024-06-03', minutes: -30 },
  ]
  source.credits = { '2024-06-03': { abc: { C: 450 } } }
  const report = calculateZeitguruAccounting(source, range('2024-06-03'))
  assert.equal(report.fromDate, '2024-06-01'); assert.equal(report.days.length, 3)
  assert.equal(report.openingKnown, true); assert.equal(report.openingBalanceMinutes, 120)
  assert.equal(report.days[2].creditedMinutes, 420); assert.equal(report.days[2].exactDeltaMinutes, -60)
  assert.equal(report.closingBalanceMinutes, 60)
})

test('absent source opening is period-relative, never a fabricated annual or lifetime carry', () => {
  const source = fixture(); source.credits = { '2024-06-03': { abc: { C: 480 } } }
  const oneDay = calculateZeitguruAccounting(source, range('2024-06-03')), twoDays = calculateZeitguruAccounting(source, range('2024-06-03', '2024-06-04'))
  assert.equal(oneDay.closingBalanceMinutes, 0); assert.equal(twoDays.closingBalanceMinutes, -480)
  assert.equal(twoDays.opening.date, '2024-06-03'); assert.equal(twoDays.openingKnown, false)
})

test('full-day paid absence replaces worked credit; half-day retains it; overtime reduction earns nothing', () => {
  const full = fixture(); absence(full); full.credits = { '2024-06-03': { abc: { C: 100 } } }
  const fullDay = calculateZeitguruAccounting(full, range('2024-06-03')).days[0]
  assert.equal(fullDay.workedMinutes, 0); assert.equal(fullDay.absenceMinutes, 480); assert.equal(fullDay.creditedMinutes, 480)
  const half = fixture(); absence(half, { startsHalfDay: true }); half.credits = { '2024-06-03': { abc: { C: 240 } } }
  const halfDay = calculateZeitguruAccounting(half, range('2024-06-03')).days[0]
  assert.equal(halfDay.workedMinutes, 240); assert.equal(halfDay.absenceMinutes, 240); assert.equal(halfDay.creditedMinutes, 480)
  const reduction = fixture(); absence(reduction, { typeCode: 'overtimeReduction', earning: 'none' })
  assert.equal(calculateZeitguruAccounting(reduction, range('2024-06-03')).days[0].exactDeltaMinutes, -480)
})

test('requested and rejected absences do not suppress worked credit or earn paid absence hours', () => {
  for (const status of ['requested', 'rejected']) {
    const source = fixture(); absence(source, { status }); source.credits = { '2024-06-03': { abc: { C: 400 } } }
    const day = calculateZeitguruAccounting(source, range('2024-06-03')).days[0]
    assert.equal(day.workedMinutes, 400); assert.equal(day.absenceMinutes, 0); assert.equal(day.absence, undefined)
  }
})

test('global holidays precede branch holidays, honor source contract switches, and are not invented for missing years', () => {
  const source = fixture(); source.contracts = [weekly({ mainBranchId: 'office' })]
  source.holidays = [{ id: 'global', date: '2024-06-03', name: 'Configured holiday' }, { id: 'branch', date: '2024-06-03', branchId: 'office', isHalfHoliday: true }]
  const report = calculateZeitguruAccounting(source, range('2024-06-03'))
  assert.equal(report.days[0].holidayMinutes, 480)
  const missing = calculateZeitguruAccounting(source, range('2026-05-01'))
  assert.equal(missing.days[0].holidayMinutes, 0); assert.equal(missing.days[0].expectedMinutes, 480)
  assert.deepEqual(missing.details.missingHolidayYears, ['2026'])
  source.contracts = [weekly({ applyQuotaOnHolidays: false })]
  assert.equal(calculateZeitguruAccounting(source, range('2024-06-03')).days[0].holidayMinutes, 0)
})

test('holiday and absence precedence follows both full and half holiday rules', () => {
  const source = fixture(); absence(source); source.holidays = [{ id: 'holiday', date: '2024-06-03' }]
  let day = calculateZeitguruAccounting(source, range('2024-06-03')).days[0]
  assert.equal(day.absenceMinutes, 480); assert.equal(day.holidayMinutes, 0)
  source.snapshot.rosterSettings.holidaysInAbsenceCountAsHolidays = true
  day = calculateZeitguruAccounting(source, range('2024-06-03')).days[0]
  assert.equal(day.absenceMinutes, 0); assert.equal(day.holidayMinutes, 480)
  source.holidays[0].isHalfHoliday = true
  day = calculateZeitguruAccounting(source, range('2024-06-03')).days[0]
  assert.equal(day.absenceMinutes, 240); assert.equal(day.holidayMinutes, 240)
})

test('mean, as-planned, fixed absence credits and shift-only earning use the actual source rules', () => {
  const mean = fixture(); mean.contracts = [weekly({ dailyQuota: { mo: 240, tu: 480, we: 480, th: 480, fr: 480 } })]; absence(mean, { earning: 'meanQuota', typeCode: 'custom' })
  assert.equal(calculateZeitguruAccounting(mean, range('2024-06-03')).days[0].absenceMinutes, 432)
  const planned = fixture(); absence(planned, { earning: 'asPlaned', startsHalfDay: true }); planned.credits = { '2024-06-03': { abc: { C: 120 } } }
  assert.equal(calculateZeitguruAccounting(planned, range('2024-06-03')).days[0].absenceMinutes, 120, 'asPlaned is not halved')
  const fixed = fixture(); absence(fixed, {}, { creditFixedValue: 300, creditOnlyOnDaysWithShift: true })
  assert.equal(calculateZeitguruAccounting(fixed, range('2024-06-03')).days[0].absenceMinutes, 0)
  fixed.credits = { '2024-06-03': { abc: { C: 10 } } }
  assert.equal(calculateZeitguruAccounting(fixed, range('2024-06-03')).days[0].absenceMinutes, 300)
})

test('monthly quotas preserve three decimals and exact deltas before displayed balance rounding', () => {
  const source = fixture(); source.contracts = [weekly({ interval: 'monthly', totalHours: 160, dailyQuota: { mo: 1, tu: 1, we: 1, th: 1, fr: 1 } })]
  absence(source, { startDate: '2024-07-01', endDate: '2024-07-01', typeCode: 'custom' })
  const report = calculateZeitguruAccounting(source, range('2024-07-01', '2024-07-02'))
  assert.equal(report.days[0].expectedMinutes, 417.391); assert.equal(report.days[0].creditedMinutes, 417.391)
  assert.equal(report.days[0].exactDeltaMinutes, 0); assert.equal(report.days[1].exactDeltaMinutes, -417.391)
  assert.equal(report.closingBalanceMinutes, -417)
  const contract = report.contracts[0]
  assert.equal(zeitguruExpectedMinutes({ ...contract, intervalStartDay: 15 }, '2024-03-14'), 457.143)
  assert.equal(zeitguruExpectedMinutes({ ...contract, intervalStartDay: 15 }, '2024-04-15'), 436.364)
})

test('source credit components preserve exact precedence and independently rounded supplements', () => {
  assert.equal(zeitguruDailySourceCredits({ abc: { C: 480, T: 0, AA: 1.25, AP: 10, R: -15 } }), 60)
  assert.equal(zeitguruDailySourceCredits({ abc: { C: 450, AA: 0.51, AP: 12.5, R: -10 }, def: { T: 60 } }), 587)
  assert.throws(() => zeitguruDailySourceCredits({ abc: { unsupported: 480 } }), errorCode('unsupported_credit_components'))
})

test('ambiguous contracts, absences, corrections and missing coverage fail instead of guessing', () => {
  const contracts = fixture(); contracts.contracts.push(weekly({ id: 'overlap' }))
  assert.throws(() => calculateZeitguruAccounting(contracts, range('2024-06-03')), errorCode('ambiguous_contract_history'))
  const absences = fixture(); absence(absences); absences.absences.push({ ...absences.absences[0], id: 'overlap' })
  assert.throws(() => calculateZeitguruAccounting(absences, range('2024-06-03')), errorCode('ambiguous_absence_history'))
  const corrections = fixture(); corrections.creditCorrections = ['one', 'two'].map((id) => ({ id, userId: binding.userId, type: 'initial', date: '2024-06-03', minutes: 0 }))
  assert.throws(() => calculateZeitguruAccounting(corrections, range('2024-06-03')), errorCode('ambiguous_opening_balance'))
  const gap = fixture(); gap.contracts = [weekly({ validTo: '2024-06-02' })]
  assert.throws(() => calculateZeitguruAccounting(gap, range('2024-06-03')), errorCode('contract_coverage_missing'))
})

test('400-day forecast uses dated source schedule, remains independent of punch data and honors employment end', () => {
  const source = fixture(); source.snapshot.profile.lastWorkDay = '2026-09-08'
  const report = calculateZeitguruAccounting(source, { fromDate: '2026-09-06', toDate: '2026-09-06' })
  assert.equal(report.forecast.length, 400)
  assert.equal(report.forecast[0].expectedMinutes, 480); assert.equal(report.forecast[1].expectedMinutes, 480); assert.equal(report.forecast[2].expectedMinutes, 0)
})

test('forecast subtracts only configured source holiday and approved absence credit from quota', () => {
  const source = fixture()
  source.holidays = [{ id: 'holiday', date: '2026-09-08' }]
  absence(source, { startDate: '2026-09-09', endDate: '2026-09-09', startsHalfDay: true })
  const report = calculateZeitguruAccounting(source, { fromDate: '2026-09-06', toDate: '2026-09-06', forecastThroughDate: '2026-09-10' })
  assert.deepEqual(report.forecast.map((day) => day.expectedMinutes), [480, 0, 240, 480])
  assert.equal(report.forecast[1].quotaMinutes, 480); assert.equal(report.forecast[1].holidayMinutes, 480)
  assert.equal(report.forecast[2].absenceMinutes, 240)
  source.absences[0].earning = 'asPlaned'
  assert.throws(() => calculateZeitguruAccounting(source, { fromDate: '2026-09-06', toDate: '2026-09-06', forecastThroughDate: '2026-09-10' }), errorCode('unsupported_forecast_earning'))
})

test('reader fetches credits from a real opening anchor before the first punch using bounded monthly ranges', async () => {
  const source = fixture(); source.creditCorrections = [{ id: 'initial', userId: binding.userId, type: 'initial', date: '2024-05-30', minutes: 100 }]
  const calls: [string, string][] = []
  const client = {
    readSnapshot: async () => source.snapshot, readOwnContracts: async () => source.contracts, readOwnCreditCorrections: async () => source.creditCorrections,
    readOwnAbsences: async () => source.absences, readAccountingAbsenceTypes: async () => source.absenceTypes, readAccountingHolidays: async () => source.holidays,
    readOwnCreditRange: async (_tokens: ZeitguruTokens, _binding: unknown, from: string, to: string) => { calls.push([from, to]); return {} },
  } as unknown as ZeitguruClient
  const tokens = { idToken: 'synthetic-secret', refreshToken: 'synthetic-refresh', expiresAt: 0 }
  const report = await readZeitguruAccounting(client, tokens, binding, range('2024-06-03'))
  assert.deepEqual(calls, [['2024-05-30', '2024-05-31'], ['2024-06-01', '2024-06-03']])
  assert.equal(report.fromDate, '2024-05-30'); assert.equal(JSON.stringify(report).includes(tokens.idToken), false)
})

test('identity changes, current-day accounting and unsupported settings are rejected', () => {
  const source = fixture(); source.snapshot.profile.accountId = 'other-person'
  assert.throws(() => calculateZeitguruAccounting(source, range('2024-06-03')), errorCode('identity_mismatch'))
  source.snapshot.profile.accountId = binding.accountId
  assert.throws(() => calculateZeitguruAccounting(source, range('2026-09-07')), errorCode('outside_accounting_range'))
  source.snapshot.rosterSettings.holidaysInAbsenceCountAsHolidays = 'yes'
  assert.throws(() => calculateZeitguruAccounting(source, range('2024-06-03')), errorCode('unsupported_accounting_setting'))
})
