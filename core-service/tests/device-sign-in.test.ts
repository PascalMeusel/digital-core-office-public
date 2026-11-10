import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { app } from '../server/index.ts'
import { authenticate, changePassword, closeConnection, connection, createQrLoginChallenge, createSession, saveUser } from '../server/core.ts'

test('device QR approval uses current Core identity without requiring Inventory access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-device-sign-in-'))
  assert(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
  process.env.DCO_INITIAL_ADMIN_EMAIL = 'device-admin@example.invalid'
  process.env.DCO_INITIAL_ADMIN_PASSWORD = 'Temporary-device-admin-2026!'
  closeConnection()
  const server = createServer(app)
  try {
    const admin = authenticate(process.env.DCO_INITIAL_ADMIN_EMAIL, process.env.DCO_INITIAL_ADMIN_PASSWORD)!
    const employee = saveUser(admin.id, { name: 'Time Employee', email: 'device-employee@example.invalid', password: 'Temporary-device-employee-2026!', memberships: [{ moduleId: 'time', role: 'employee', active: true }] })
    const temporary = createSession(employee.id).token
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const post = (path: string, body: unknown, cookie?: string, extra?: Record<string, string>) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `dco_core_session=${cookie}` } : {}), ...extra }, body: JSON.stringify(body),
    })
    const path = '/api/core/auth/qr-login/challenges/approve'
    const challenge = createQrLoginChallenge()
    const body = { token: challenge.token, expectedUserId: employee.id }
    assert.equal((await post(path, body)).status, 401)
    assert.equal((await post(path, body, temporary)).status, 403)
    changePassword(employee.id, 'Temporary-device-employee-2026!', 'Permanent-device-employee-2026!')
    const session = createSession(employee.id).token
    assert.equal((await post(path, body, temporary)).status, 401, 'revoked session rejected')
    assert.equal((await post(path, body, session, { Origin: 'https://attacker.invalid' })).status, 403)
    assert.equal((await post(path, body, session, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await post(path, { ...body, expectedUserId: admin.id }, session)).status, 409)
    assert.equal((await post(path, { ...body, token: 'not-a-challenge' }, session)).status, 400)
    assert.equal((await post(path, body, session)).status, 200)
    const claimed = await post('/api/core/auth/qr-login/challenges/claim', { token: challenge.token })
    assert.equal(claimed.status, 200)
    const payload = await claimed.json()
    assert.equal(payload.user.id, employee.id)
    assert.deepEqual(payload.modules.map((module: { id: string }) => module.id), ['time'])
    const desktopCookie = claimed.headers.getSetCookie().find(cookie => cookie.startsWith('dco_core_session='))!.split(';')[0]!
    const desktop = await fetch(base + '/api/core/session', { headers: { Cookie: desktopCookie } })
    assert.equal((await desktop.json()).user.id, employee.id)
    assert.equal((await post(path, body, session)).status, 400, 'used challenge rejected')
    assert.equal((await post('/api/core/auth/qr-login/challenges/claim', { token: challenge.token })).status, 401)
    const expired = createQrLoginChallenge()
    connection().prepare("UPDATE core_qr_login_challenges SET expiresAt='2000-01-01T00:00:00.000Z'").run()
    assert.equal((await post(path, { token: expired.token, expectedUserId: employee.id }, session)).status, 400)
    saveUser(admin.id, { active: false }, employee.id)
    assert.equal((await post(path, body, session)).status, 401, 'disabled account rejected')
  } finally {
    await new Promise<void>(done => server.close(() => done()))
    closeConnection()
    for (const key of ['DCO_CORE_DATA', 'DCO_INITIAL_ADMIN_EMAIL', 'DCO_INITIAL_ADMIN_PASSWORD']) delete process.env[key]
    rmSync(directory, { recursive: true, force: true })
  }
})
