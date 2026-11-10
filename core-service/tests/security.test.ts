import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { approveQrLoginChallenge, authenticate, changePassword, closeConnection, completePasswordReset, connection, createPasswordReset, createQrLoginChallenge, createSession, importTimeUsers, listUsers, moduleAccess, moduleIdentity, saveUser, userForSession } from '../server/core.ts'
import { app } from '../server/index.ts'
import { coreTokenForRequest, loginWithCore, requireCoreIdentity } from '../../packages/core-client/index.ts'

test('Core owns credential recovery, module access, and account lifecycle', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-core-security-'))
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`), 'Safe test cleanup path')
  process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
  process.env.DCO_INITIAL_ADMIN_EMAIL = 'security-admin@example.com'
  process.env.DCO_INITIAL_ADMIN_PASSWORD = 'Temporary-admin-password-2026!'
  process.env.DCO_INTERNAL_AUTH_SECRET = 'isolated-test-internal-secret-2026' // gitleaks:allow -- isolated synthetic fixture
  process.env.DCO_ENABLED_MODULES = 'time,inventory,agile'
  closeConnection()
  const admin = authenticate(process.env.DCO_INITIAL_ADMIN_EMAIL, process.env.DCO_INITIAL_ADMIN_PASSWORD)!
  changePassword(admin.id, process.env.DCO_INITIAL_ADMIN_PASSWORD, 'Permanent-admin-password-2026!')
  const server = createServer(app)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const base = `http://127.0.0.1:${address.port}`
  process.env.DCO_CORE_URL = base
  process.env.DCO_CORE_LOGIN_URL = base
  const request = (path: string, body?: unknown, token?: string, headers?: Record<string, string>, method?: string) => fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const fakeRequest = (headers: Record<string, string>, method = 'GET') => ({ method, header: (name: string) => headers[name.toLowerCase()] })
  try {
    await t.test('background inventory integrations require the internal secret and current active writable membership', async () => {
      const path = '/api/core/internal/inventory-integration-users', body = { userIds: [admin.id, 'missing'] }
      const headers = { 'X-DCO-Internal-Secret': process.env.DCO_INTERNAL_AUTH_SECRET! }, sql = connection()
      assert.equal((await request(path, body)).status, 403)
      assert.deepEqual(await (await request(path, body, undefined, headers)).json(), { userIds: [admin.id] })
      assert.equal((await request(path, { userIds: Array(101).fill(admin.id) }, undefined, headers)).status, 400)
      try {
        for (const column of ['active', 'mustChangePassword']) {
          sql.prepare(`UPDATE core_users SET ${column}=? WHERE id=?`).run(column === 'active' ? 0 : 1, admin.id)
          assert.deepEqual(await (await request(path, body, undefined, headers)).json(), { userIds: [] })
          sql.prepare(`UPDATE core_users SET ${column}=? WHERE id=?`).run(column === 'active' ? 1 : 0, admin.id)
        }
        sql.prepare("UPDATE module_memberships SET role='viewer' WHERE userId=? AND moduleId='inventory'").run(admin.id)
        assert.deepEqual(await (await request(path, body, undefined, headers)).json(), { userIds: [] })
        sql.prepare("UPDATE module_memberships SET role='admin',active=0 WHERE userId=? AND moduleId='inventory'").run(admin.id)
        assert.deepEqual(await (await request(path, body, undefined, headers)).json(), { userIds: [] })
      } finally {
        sql.prepare('UPDATE core_users SET active=1,mustChangePassword=0 WHERE id=?').run(admin.id)
        sql.prepare("UPDATE module_memberships SET role='admin',active=1 WHERE userId=? AND moduleId='inventory'").run(admin.id)
      }
    })
    await t.test('background alert recipients require the internal secret and current active Time administrator authority',async()=>{
      const path='/api/core/internal/time-alert-recipients',body={userIds:[admin.id,'nonexistent-user']}
      assert.equal((await request(path,body)).status,403)
      const headers={'X-DCO-Internal-Secret':process.env.DCO_INTERNAL_AUTH_SECRET!}
      let response=await request(path,body,undefined,headers)
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{recipients:[{id:admin.id,email:admin.email}]})
      assert.equal((await request(path,{userIds:Array(101).fill(admin.id)},undefined,headers)).status,400)
      const sql=connection()
      try{
        sql.prepare("UPDATE module_memberships SET role='employee' WHERE userId=? AND moduleId='time'").run(admin.id)
        assert.deepEqual(await(await request(path,body,undefined,headers)).json(),{recipients:[]})
        sql.prepare("UPDATE module_memberships SET role='admin' WHERE userId=? AND moduleId='time'").run(admin.id)
        sql.prepare('UPDATE core_users SET mustChangePassword=1 WHERE id=?').run(admin.id)
        assert.deepEqual(await(await request(path,body,undefined,headers)).json(),{recipients:[]})
      }finally{sql.prepare('UPDATE core_users SET mustChangePassword=0 WHERE id=?').run(admin.id);sql.prepare("UPDATE module_memberships SET role='admin' WHERE userId=? AND moduleId='time'").run(admin.id)}
    })
    await t.test('new users must replace their temporary secret before accessing modules, without losing their session on a rejected change', async () => {
      const created = saveUser(admin.id, { name: 'Employee', email: 'employee@example.com', password: 'Temporary-employee-password!', memberships: [
        { moduleId: 'time', role: 'employee', active: true }, { moduleId: 'inventory', role: 'receiver', active: true }, { moduleId: 'agile', role: 'viewer', active: true },
      ] })
      assert.equal(created.mustChangePassword, true)
      assert.equal(moduleIdentity(created, 'inventory')?.moduleRole, 'receiver')
      assert.equal(moduleIdentity(created, 'agile')?.readOnly, true)
      const token = createSession(created.id).token
      const before = connection().prepare('SELECT passwordHash,passwordSalt,mustChangePassword FROM core_users WHERE id=?').get(created.id)
      const rejected = await request('/api/core/auth/change-password', { currentPassword:'Temporary-employee-password!', password:'Temporary-employee-password!' }, token)
      assert.equal(rejected.status,400)
      assert.match((await rejected.json()).message,/different/)
      assert.deepEqual(connection().prepare('SELECT passwordHash,passwordSalt,mustChangePassword FROM core_users WHERE id=?').get(created.id),before)
      assert.equal(userForSession(token)?.mustChangePassword,true)
      const reset = createPasswordReset(created.email)!
      assert.throws(()=>completePasswordReset(reset.token,'Temporary-employee-password!'),/different/)
      assert.deepEqual(connection().prepare('SELECT passwordHash,passwordSalt,mustChangePassword FROM core_users WHERE id=?').get(created.id),before)
      assert.equal(userForSession(token)?.mustChangePassword,true)
      assert.equal((connection().prepare('SELECT COUNT(*) count FROM password_reset_tokens WHERE userId=?').get(created.id) as {count:number}).count,1)
      await assert.rejects(requireCoreIdentity(fakeRequest({authorization:`Bearer ${token}`}), 'time'), (error: {status?:number})=>error.status===403)
      const changed = await request('/api/core/auth/change-password', { currentPassword:'Temporary-employee-password!', password:'Permanent-employee-password!' }, token)
      assert.equal(changed.status,204)
      assert.equal(userForSession(token),undefined)
      assert.equal(authenticate(created.email,'Temporary-employee-password!'),undefined)
      assert.equal(authenticate(created.email,'Permanent-employee-password!')?.mustChangePassword,false)
      assert.throws(()=>completePasswordReset(reset.token,'Another-new-password!'),/invalid or expired/)
    })
    await t.test('current browser identity wins over an old administrator bearer token; logout revokes it', async () => {
      const employee = authenticate('employee@example.com', 'Permanent-employee-password!')!
      const employeeToken = createSession(employee.id).token
      const adminToken = createSession(admin.id).token
      const incoming = fakeRequest({ cookie: `dco_core_session=${employeeToken}`, authorization: `Bearer ${adminToken}` })
      assert.equal(coreTokenForRequest(incoming), employeeToken)
      assert.equal((await requireCoreIdentity(incoming, 'inventory')).id, employee.id)
      const denied = await request('/api/core/users', undefined, adminToken, { Cookie: `dco_core_session=${employeeToken}` })
      assert.equal(denied.status, 403)
      assert.equal((await request('/api/core/auth/logout', {}, employeeToken)).status, 204)
      await assert.rejects(requireCoreIdentity(incoming, 'inventory'), (error: { status?: number }) => error.status === 401)
    })
    await t.test('resetting a password invalidates all sessions and every older reset link', () => {
      const employee = authenticate('employee@example.com', 'Permanent-employee-password!')!
      const session = createSession(employee.id).token
      const older = createPasswordReset(employee.email)!
      const newer = createPasswordReset(employee.email)!
      completePasswordReset(newer.token, 'Recovered-employee-password!')
      assert.equal(userForSession(session), undefined)
      assert.equal(authenticate(employee.email, 'Permanent-employee-password!'), undefined)
      assert.throws(() => completePasswordReset(older.token, 'Attacker-reused-link-password!'), /invalid or expired/)
      const next = createPasswordReset(employee.email)!
      changePassword(employee.id, 'Recovered-employee-password!', 'Changed-employee-password!')
      assert.throws(() => completePasswordReset(next.token, 'Old-link-password-again!'), /invalid or expired/)
    })
    await t.test('successful account replacement revokes the previous browser session, including module login', async () => {
      const employee = authenticate('employee@example.com', 'Changed-employee-password!')!
      const previous = createSession(admin.id).token
      const headers = { Cookie: `dco_core_session=${previous}` }
      assert.equal((await request('/api/core/auth/login', { email: employee.email, password: 'wrong' }, undefined, headers)).status, 401)
      assert.equal(userForSession(previous)?.id, admin.id)
      const switched = await request('/api/core/auth/login', { email: employee.email, password: 'Changed-employee-password!' }, undefined, headers)
      assert.equal(switched.status, 200)
      assert.equal(userForSession(previous), undefined)
      assert.ok(switched.headers.get('set-cookie')?.includes('HttpOnly'))
      const priorModule = createSession(admin.id).token
      const moduleSession = await loginWithCore(fakeRequest({ cookie: `dco_core_session=${priorModule}`, origin: base }, 'POST'), employee.email, 'Changed-employee-password!')
      assert.equal(moduleSession.user.id, employee.id)
      assert.equal(userForSession(priorModule), undefined)
      const unrelatedNative = createSession(admin.id).token
      await loginWithCore(fakeRequest({ authorization: `Bearer ${unrelatedNative}`, origin: 'https://localhost' }, 'POST'), employee.email, 'Changed-employee-password!')
      assert.equal(userForSession(unrelatedNative)?.id, admin.id)
      const challenge = createQrLoginChallenge()
      approveQrLoginChallenge(challenge.token, employee.email)
      assert.equal((await request('/api/core/auth/qr-login/challenges/claim', {token:challenge.token}, undefined, {Cookie:`dco_core_session=${unrelatedNative}`})).status,200)
      assert.equal(userForSession(unrelatedNative),undefined)
    })
    await t.test('cross-site login and cookie writes stay blocked despite forged bearer or mobile flags', async () => {
      const token = createSession(admin.id).token
      const cookie = `dco_core_session=${token}`
      const forged = { cookie, authorization: 'Bearer forged', origin: 'https://attacker.invalid', 'x-inventory-mobile-app': '1' }
      await assert.rejects(requireCoreIdentity(fakeRequest(forged, 'POST'), 'agile'), (error: { status?: number }) => error.status === 403)
      await assert.rejects(loginWithCore(fakeRequest({ origin: 'https://attacker.invalid', authorization: 'Bearer forged' }, 'POST'), admin.email, 'Permanent-admin-password-2026!'), (error: { status?: number }) => error.status === 403)
      await assert.rejects(loginWithCore(fakeRequest({ cookie, origin: 'https://localhost' }, 'POST'), admin.email, 'Permanent-admin-password-2026!'), (error: { status?: number }) => error.status === 403)
      await assert.rejects(requireCoreIdentity(fakeRequest({ cookie, 'sec-fetch-site': 'cross-site' }, 'POST'), 'agile'), (error: { status?: number }) => error.status === 403)
      assert.equal((await requireCoreIdentity(fakeRequest({ cookie, origin: base }, 'POST'), 'agile')).id, admin.id)
      assert.equal((await requireCoreIdentity(fakeRequest({ authorization: `Bearer ${token}`, origin: 'https://localhost' }, 'POST'), 'agile')).id, admin.id)
      assert.equal((await request('/api/core/auth/logout', {}, undefined, { Cookie: cookie, Origin: 'https://attacker.invalid' })).status, 403)
      assert.equal(userForSession(token)?.id, admin.id)
    })
    await t.test('offboarding revokes sessions and a stale import cannot reactivate or replace Core credentials', () => {
      const employee = authenticate('employee@example.com', 'Changed-employee-password!')!
      const before = connection().prepare('SELECT passwordHash, passwordSalt FROM core_users WHERE id = ?').get(employee.id) as { passwordHash: string; passwordSalt: string }
      const token = createSession(employee.id).token
      saveUser(admin.id, { active: false }, employee.id)
      const source = join(directory, 'stale-userbase.json')
      writeFileSync(source, JSON.stringify({ version: 1, source: 'time-tracking-system', users: [{ ...employee, active: true, role: 'admin', mustChangePassword: false, ...before }] }))
      importTimeUsers(source)
      assert.equal(userForSession(token), undefined)
      assert.equal(authenticate(employee.email, 'Changed-employee-password!'), undefined)
      assert.equal(listUsers().find((user) => user.id === employee.id)?.role, 'employee')
      assert.throws(() => saveUser(admin.id, { active: false }, admin.id), /at least one/)
    })
    await t.test('canonical login throttling cannot be bypassed using whitespace', async () => {
      for (let index = 0; index < 8; index++) assert.equal((await request('/api/core/auth/login', { email: 'throttle@example.com', password: 'wrong' })).status, 401)
      assert.equal((await request('/api/core/auth/login', { email: '  THROTTLE@example.com ', password: 'wrong' })).status, 429)
    })
    await t.test('email alone or a legacy SSO cookie cannot authorize QR approval or module access', async () => {
      const headers = { 'X-DCO-Internal-Secret': process.env.DCO_INTERNAL_AUTH_SECRET! }
      assert.equal((await request('/api/core/internal/qr-login/challenges/approve', { token: 'challenge', email: admin.email }, undefined, headers)).status, 401)
      await assert.rejects(requireCoreIdentity(fakeRequest({ cookie: 'digital_office_sso=v1.legacy.signature' }), 'inventory'), (error: { status?: number }) => error.status === 401)
    })
    await t.test('license trouble preserves read/export access while blocking data mutations', async () => {
      connection().prepare('INSERT INTO suite_license (id, licenseKey, updatedAt, updatedBy) VALUES (1, ?, ?, ?)').run('invalid-license', new Date().toISOString(), admin.id)
      assert.equal(moduleAccess('time', 'read').allowed, true)
      assert.equal(moduleAccess('time', 'write').allowed, false)
      const token = createSession(admin.id).token
      assert.equal((await requireCoreIdentity(fakeRequest({ authorization: `Bearer ${token}` }), 'time')).readOnly, true)
      await assert.rejects(requireCoreIdentity(fakeRequest({ authorization: `Bearer ${token}` }, 'POST'), 'time'), (error: { status?: number }) => error.status === 403)
      assert.equal(moduleAccess('unknown', 'read').allowed, false)
    })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    closeConnection()
    for (const key of ['DCO_CORE_DATA', 'DCO_INITIAL_ADMIN_EMAIL', 'DCO_INITIAL_ADMIN_PASSWORD', 'DCO_INTERNAL_AUTH_SECRET', 'DCO_ENABLED_MODULES', 'DCO_CORE_URL', 'DCO_CORE_LOGIN_URL']) delete process.env[key]
    rmSync(directory, { recursive: true, force: true })
  }
})
