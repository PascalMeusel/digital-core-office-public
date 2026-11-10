import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { test, type TestContext } from 'node:test'
import { ZeitguruClient, ZeitguruClientError, zeitguruCompanyTenantSha256, type ZeitguruTokens } from '../server/zeitguruClient.ts'
import type { ZeitguruBinding } from '../server/zeitguruProtocol.ts'

const now = Date.parse('2026-09-07T14:00:00Z')
const binding: ZeitguruBinding = { tenantId: 'synthetic-company', userId: 'employee', accountId: 'firebase-account', role: 'employee' }
function jwt(overrides: Record<string, unknown> = {}) {
  const claims = { tenantId: binding.tenantId, userId: binding.userId, sub: binding.accountId, role: binding.role, iss: 'https://securetoken.google.com/aplano-production', aud: 'aplano-production', exp: now / 1000 + 3600, ...overrides }
  return `${Buffer.from('{"alg":"test-only"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`
}
function fixture(t: TestContext, response?: (url: URL, init: RequestInit) => Response | undefined) {
  // Do not put real tenant IDs in tests or add an alternate-tenant option to production code.
  // Only this synthetic input has its digest substituted; other tenants use real SHA256.
  const realCreateHash = crypto.createHash
  t.mock.method(crypto, 'createHash', (...args: Parameters<typeof crypto.createHash>) => {
    const hash = realCreateHash(...args), originalUpdate = hash.update.bind(hash), originalDigest = hash.digest.bind(hash)
    let synthetic = false
    hash.update = ((value: unknown, ...rest: unknown[]) => { synthetic = value === binding.tenantId; return originalUpdate(value as string, rest[0] as crypto.Encoding) }) as typeof hash.update
    hash.digest = ((encoding?: string) => synthetic && encoding === 'hex' ? zeitguruCompanyTenantSha256 : originalDigest(encoding as crypto.BinaryToTextEncoding)) as typeof hash.digest
    return hash
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const calls: { url: URL; init: RequestInit }[] = []
  const token = jwt(), tokens: ZeitguruTokens = { idToken: token, refreshToken: 'private-refresh-token', expiresAt: now + 3600_000 }
  const fetchImpl: typeof fetch = async (input, supplied) => {
    const url = new URL(String(input)), init = supplied ?? {}; calls.push({ url, init })
    const override = response?.(url, init); if (override) return override
    let data: unknown
    if (url.pathname === '/api/login') data = { isV2: true, firebaseToken: 'private-custom-token' }
    else if (url.pathname === '/v1/accounts:signInWithCustomToken') data = { idToken: token, refreshToken: tokens.refreshToken, expiresIn: '3600' }
    else if (url.pathname === '/v1/token') data = { id_token: token, refresh_token: 'rotated-private-refresh-token', expires_in: '3600', user_id: binding.accountId, project_id: '502691546834' }
    else if (url.pathname === '/api/current-server-time-v2') data = { unixTime: now / 1000, dateTime: '2026-09-07 16:00' }
    else if (url.pathname === '/tenantInfos/synthetic-company.json') data = { id: binding.tenantId, isV2: true }
    else if (url.pathname.endsWith('/users/employee.json')) data = { id: 'employee', accountId: binding.accountId, role: 'employee', branchIds: ['office'], jobPositionIds: ['job'] }
    else if (url.pathname.endsWith('/timeClockSettings.json')) data = { settings: { id: 'settings', allowUserTimClockInBrowser: true, breaksNeedToBeClocked: true } }
    else if (url.pathname.endsWith('/rosterSettings.json')) data = { settings: { id: 'settings', timezone: 'Europe/Berlin' } }
    else if (url.pathname.endsWith('/branches/office.json')) data = { id: 'office', isClockingEnabled: true }
    else if (url.pathname.endsWith('/timeClockings.json')) data = null
    else if (/\/credits\/employee_\d{4}-\d{2}-\d{2}\.json$/.test(url.pathname)) data = null
    else if (url.pathname.endsWith('/timeClockings/row-id.json')) data = null
    else throw new Error('Unexpected mocked path')
    return Response.json(data, { headers: { etag: '"test-etag"' } })
  }
  return { client: new ZeitguruClient({ fetchImpl, now: () => now }), calls, tokens, fetchImpl }
}
const errorCode = (code: string) => (error: unknown) => error instanceof ZeitguruClientError && error.code === code

test('login uses only own supplied credentials, Firebase exchange and narrowly scoped authenticated reads', async (t) => {
  const f = fixture(t), result = await f.client.login('person@example.test', 'private-password')
  assert.deepEqual(result.binding, binding)
  assert.equal(result.snapshot.clockings.length, 0)
  assert.deepEqual(result.snapshot.credits, { '2026-09-06': {}, '2026-09-07': {} })
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { data: { email: 'person@example.test', password: 'private-password', timezone: 'Europe/Berlin', language: 'de' } })
  assert.deepEqual(JSON.parse(String(f.calls[1].init.body)), { token: 'private-custom-token', returnSecureToken: true })
  const reads = f.calls.slice(2)
  assert.equal(reads.every((call) => call.init.method === 'GET'), true)
  assert.equal(reads.every((call) => call.url.searchParams.get('auth') === f.tokens.idToken), true)
  assert.equal(reads.every((call) => call.init.redirect === 'error' && call.init.signal instanceof AbortSignal), true)
  assert.equal(reads.some((call) => call.url.pathname.endsWith('/users.json') || call.url.pathname.endsWith('/tenants/synthetic-company.json')), false)
  const clockRead = reads.find((call) => call.url.pathname.endsWith('/timeClockings.json'))!
  assert.equal(clockRead.url.searchParams.get('orderBy'), '"userId_date"')
  assert.equal(clockRead.url.searchParams.get('startAt'), '"employee_2026-09-06"')
  assert.equal(clockRead.url.searchParams.get('endAt'), '"employee_2026-09-07"')
})

test('full tenant pin, token audience and immutable profile binding reject mismatches', async (t) => {
  const f = fixture(t)
  assert.equal(zeitguruCompanyTenantSha256.length, 64)
  await assert.rejects(f.client.readSnapshot({ ...f.tokens, idToken: jwt({ tenantId: 'other-company' }) }, binding), errorCode('tenant_mismatch'))
  await assert.rejects(f.client.readSnapshot({ ...f.tokens, idToken: jwt({ aud: 'other-project' }) }, binding), errorCode('authentication_required'))
  await assert.rejects(f.client.readSnapshot(f.tokens, { ...binding, userId: 'other-employee' }), errorCode('identity_mismatch'))
  const changed = new ZeitguruClient({ now: () => now, fetchImpl: async (input, init) => String(input).includes('/users/employee.json') ? Response.json({ id: 'employee', accountId: 'different-account', role: 'employee', branchIds: [] }) : f.fetchImpl(input, init) })
  await assert.rejects(changed.readSnapshot(f.tokens, binding), errorCode('identity_mismatch'))
})

test('refresh returns rotating secrets only to server caller and fences changed identities', async (t) => {
  const f = fixture(t), result = await f.client.refresh('private-refresh-token', binding)
  assert.equal(result.tokens.refreshToken, 'rotated-private-refresh-token')
  assert.equal(new URLSearchParams(String(f.calls[0].init.body)).get('grant_type'), 'refresh_token')
  const changed = new ZeitguruClient({ now: () => now, fetchImpl: async () => Response.json({ id_token: jwt({ userId: 'different-employee' }), refresh_token: 'next', expires_in: '3600', user_id: binding.accountId, project_id: 'aplano-production' }) })
  await assert.rejects(changed.refresh('private-refresh-token', binding), errorCode('identity_mismatch'))
})

test('legacy identity obfuscation is normalized without changing immutable account binding', async (t) => {
  const mask = [...'wayTooSalty'].reduce((result, character) => result ^ character.charCodeAt(0), 0)
  const encode = (value: string) => '-cryp-' + [...value].map((character) => (character.charCodeAt(0) ^ mask).toString(16).padStart(2, '0')).join('')
  const f = fixture(t, (url) => url.pathname.endsWith('/users/employee.json') ? Response.json({ id: 'employee', accountId: binding.accountId, role: 'employee', branchIds: ['office'], name: encode('Synthetic Employee'), email: encode('person@example.test') }) : undefined)
  const snapshot = await f.client.readSnapshot(f.tokens, binding)
  assert.equal(snapshot.profile.email, 'person@example.test')
  assert.equal(snapshot.profile.name, 'Synthetic Employee')
  assert.equal(snapshot.profile.accountId, binding.accountId)
})

test('server clock read validates token, provider timezone and drift without writing any clock data', async (t) => {
  const f = fixture(t)
  assert.equal(await f.client.readServerTime(f.tokens, binding), now)
  assert.equal(f.calls[0].url.pathname, '/api/current-server-time-v2')
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { data: { timezone: 'Europe/Berlin', language: 'de', isV2: true } })
  const drift = new ZeitguruClient({ now: () => now, fetchImpl: async () => Response.json({ unixTime: now / 1000 - 600, dateTime: '2026-09-07 15:50' }) })
  await assert.rejects(drift.readServerTime(f.tokens, binding), errorCode('clock_drift'))
})

test('own row readback rejects another identity; read paths reject injection', async (t) => {
  const f = fixture(t, (url) => url.pathname.endsWith('/timeClockings/row-id.json') ? Response.json({ id: 'row-id', userId: 'another-person' }) : undefined)
  await assert.rejects(f.client.readOwnRow(f.tokens, binding, 'row-id'), errorCode('identity_mismatch'))
  await assert.rejects(f.client.readOwnRow(f.tokens, binding, '../../secrets'), errorCode('invalid_provider_identity'))
  await assert.rejects(f.client.readOwnCredits(f.tokens, binding, '2026-99-07'), errorCode('invalid_read_input'))
})

test('HTTP, parse and fetch errors never echo vendor credentials, URL or response body', async (t) => {
  const f = fixture(t)
  for (const response of [async () => new Response('private-password and private-refresh-token', { status: 401 }), async () => new Response('private-password', { status: 200 }), async () => { throw new Error(`Request URL contained ${f.tokens.idToken}`) }]) {
    const client = new ZeitguruClient({ now: () => now, fetchImpl: response })
    await assert.rejects(client.login('person@example.test', 'private-password'), (error: unknown) => {
      assert.ok(error instanceof ZeitguruClientError)
      for (const secret of ['private-password', 'private-refresh-token', f.tokens.idToken]) assert.equal(String(error).includes(secret), false)
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('request timeout aborts instead of leaving a hanging provider request', async () => {
  const client = new ZeitguruClient({ timeoutMs: 5, fetchImpl: async (_input, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('private-response')), { once: true }) }) })
  await assert.rejects(client.login('person@example.test', 'private-password'), errorCode('provider_timeout'))
})

test('history queries are own-user indexed, bounded, and validate keyed identity', async (t) => {
  const row = { id: 'abc-row', userId: binding.userId, userId_date: `${binding.userId}_2024-02-01`, date: '2024-02-01', startTime: '09:00', endTime: '17:00', breakMinutes: 30, branchId: 'office' }
  const f = fixture(t, (url) => url.pathname.endsWith('/timeClockings.json') ? Response.json({ [row.id]: row }) : undefined)
  assert.equal(await f.client.readOwnHistoryStart(f.tokens, binding, '2026-09-06'), '2024-02-01')
  assert.deepEqual(Object.fromEntries(f.calls[0].url.searchParams), { auth: f.tokens.idToken, orderBy: '"userId_date"', startAt: '"employee_"', endAt: '"employee_2026-09-06"', limitToFirst: '1' })
  assert.equal(f.calls[0].init.method, 'GET'); assert.deepEqual(f.calls[0].init.headers, {})
  assert.deepEqual(await f.client.readOwnHistoryRange(f.tokens, binding, '2024-02-01', '2024-02-29'), [row])
  assert.equal(f.calls[1].url.searchParams.get('limitToFirst'), '10001')
  await assert.rejects(f.client.readOwnHistoryRange(f.tokens, binding, '2024-02-01', '2024-03-03'), errorCode('invalid_read_input'))
  await assert.rejects(f.client.readOwnHistoryRange(f.tokens, binding, '2024-03-01', '2024-03-31'), errorCode('identity_mismatch'))
  const wrong = new ZeitguruClient({ now: () => now, fetchImpl: async () => Response.json({ 'different-map-key': row }) })
  await assert.rejects(wrong.readOwnHistoryStart(f.tokens, binding, '2026-09-06'), errorCode('identity_mismatch'))
})

test('history credits use own key ranges, preserve raw credit flags, and reject another user', async (t) => {
  let data: unknown = { employee_2024_ignored: {} }
  const f = fixture(t, (url) => url.pathname.endsWith('/credits.json') ? Response.json(data) : undefined)
  await assert.rejects(f.client.readOwnCreditRange(f.tokens, binding, '2024-02-01', '2024-02-29'), errorCode('identity_mismatch'))
  data = { 'employee_2024-02-01': { abc: { C: 450, R: 20 } } }
  assert.deepEqual(await f.client.readOwnCreditRange(f.tokens, binding, '2024-02-01', '2024-02-29'), { '2024-02-01': { abc: { C: 450, R: 20 } } })
  assert.equal(f.calls[1].url.searchParams.get('orderBy'), '"$key"')
  assert.equal(f.calls[1].url.searchParams.get('startAt'), '"employee_2024-02-01"')
  assert.equal(f.calls[1].url.searchParams.get('endAt'), '"employee_2024-02-29"')
  data = { 'different_2024-02-01': { abc: { C: 450 } } }
  await assert.rejects(f.client.readOwnCreditRange(f.tokens, binding, '2024-02-01', '2024-02-29'), errorCode('identity_mismatch'))
  data = null
  assert.deepEqual(await f.client.readOwnCreditRange(f.tokens, binding, '2024-02-01', '2024-02-29'), {})
})

test('history refuses token binding changes before any HTTP read', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.client.readOwnHistoryStart(f.tokens, { ...binding, userId: 'another-user' }, '2026-09-06'), errorCode('identity_mismatch'))
  assert.equal(f.calls.length, 0)
})

test('chunked responses exceeding two MiB are cancelled before unbounded buffering', async (t) => {
  const f = fixture(t)
  let cancelled = false, reads = 0
  const client = new ZeitguruClient({ now: () => now, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  })) })
  await assert.rejects(client.readOwnHistoryStart(f.tokens, binding, '2026-09-06'), errorCode('invalid_provider_response'))
  assert.equal(cancelled, true); assert.ok(reads <= 4)
})

test('accounting datasets are filtered to the own immutable user and reject cross-user or mismatched keys', async (t) => {
  let data: unknown = { source: { id: 'source', userId: binding.userId, type: 'manual', date: '2026-09-01', minutes: 30 } }
  const f = fixture(t, (url) => /\/(contracts|creditCorrections|absences)\.json$/.test(url.pathname) ? Response.json(data) : undefined)
  for (const method of ['readOwnContracts', 'readOwnCreditCorrections', 'readOwnAbsences'] as const) {
    assert.equal((await f.client[method](f.tokens, binding)).length, 1)
    const call = f.calls.at(-1)!
    assert.equal(call.init.method, 'GET'); assert.equal(call.url.searchParams.get('orderBy'), '"userId"'); assert.equal(call.url.searchParams.get('equalTo'), '"employee"')
  }
  data = { source: { id: 'source', userId: 'other-employee' } }
  await assert.rejects(f.client.readOwnContracts(f.tokens, binding), errorCode('identity_mismatch'))
  data = { mismatch: { id: 'source', userId: binding.userId } }
  await assert.rejects(f.client.readOwnAbsences(f.tokens, binding), errorCode('identity_mismatch'))
  data = null
  assert.deepEqual(await f.client.readOwnCreditCorrections(f.tokens, binding), [])
})

test('accounting configuration reads only referenced absence types and returns relevant shared holidays', async (t) => {
  const f = fixture(t, (url) => {
    if (url.pathname.endsWith('/absenceTypes/vacation.json')) return Response.json({ id: 'vacation', code: 'vacation', earning: 'dailyQuota' })
    if (url.pathname.endsWith('/holidays.json')) return Response.json({
      global: { id: 'global', date: '2026-09-01', name: 'Global' }, own: { id: 'own', date: '2026-09-02', branchId: 'office' },
      other: { id: 'other', date: '2026-09-02', branchId: 'other-branch' }, later: { id: 'later', date: '2026-10-01' },
    })
    return undefined
  })
  assert.equal((await f.client.readAccountingAbsenceTypes(f.tokens, binding, ['vacation', 'vacation'])).length, 1)
  assert.equal(f.calls.length, 1)
  const holidays = await f.client.readAccountingHolidays(f.tokens, binding, '2026-09-01', '2026-09-30', ['office'])
  assert.deepEqual(holidays.map((row) => row.id), ['global', 'own'])
  await assert.rejects(f.client.readAccountingAbsenceTypes(f.tokens, binding, ['../secrets']), errorCode('invalid_provider_identity'))
  assert.equal(f.calls.length, 2)
})
