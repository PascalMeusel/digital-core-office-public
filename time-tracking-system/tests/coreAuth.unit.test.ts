import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'

test('Time HTTP and live sessions obey authoritative Core identity, revocation and read-only access', { timeout: 20_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-time-core-'))
  let revoked = false, readOnly = false, mustChangePassword = false, moduleRole = 'admin'
  const introspections: Array<{ token: string; write: boolean; allowPasswordChange?: boolean }> = []
  const core = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw || '{}') as { token: string; write: boolean; allowPasswordChange?: boolean }
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/core/internal/introspect') {
      introspections.push(body)
      if (revoked || body.token !== 'valid-core-token') { response.statusCode = 401; response.end('{"message":"Session revoked"}'); return }
      if (mustChangePassword && !body.allowPasswordChange) { response.statusCode = 403; response.end('{"message":"Password change required"}'); return }
      if (readOnly && body.write) { response.statusCode = 403; response.end('{"message":"Read-only license"}'); return }
      response.end(JSON.stringify({ user: { id: 'core-employee-1', name: 'Core Person', email: 'person@example.invalid', role: 'admin', moduleRole, active: true, mustChangePassword, readOnly } }))
    } else if (request.url === '/api/core/internal/login') {
      response.end(JSON.stringify({ user: { id: 'core-employee-1' }, sessionToken: 'valid-core-token', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    } else if (request.url === '/api/core/auth/change-password' || request.url === '/api/core/auth/logout') {
      revoked = true; response.statusCode = 204; response.end()
    } else { response.statusCode = 404; response.end('{}') }
  })
  core.listen(0, '127.0.0.1')
  await once(core, 'listening')
  const coreAddress = core.address()
  assert.ok(coreAddress && typeof coreAddress !== 'string')
  const portProbe = createServer()
  portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening')
  const address = portProbe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { ...process.env, DCO_CORE_URL: `http://127.0.0.1:${coreAddress.port}`, DCO_INTERNAL_AUTH_SECRET: 'test-internal-secret', DCO_TIMEZONE: 'Europe/Berlin', TIME_TRACKER_DATA: join(directory, 'time.sqlite'), TIME_TRACKER_BACKUP_DIR: join(directory, 'backups'), INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '', DATA_ENCRYPTION_KEY: '', REQUIRE_DATA_ENCRYPTION: 'false', PORT: String(port), HOST: '127.0.0.1', SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  let socket: WebSocket | undefined
  context.after(async () => {
    socket?.terminate()
    const exited = once(child, 'exit')
    child.kill()
    await exited
    await new Promise<void>((resolve) => core.close(() => resolve()))
  })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) assert.fail(output)
    if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) { ready = true; break }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ready, `Time did not become ready: ${output}`)
  const headers = { Cookie: 'dco_core_session=valid-core-token', Authorization: 'Bearer obsolete-module-token', 'Content-Type': 'application/json' }
  let response = await fetch(`${base}/api/state`, { headers })
  assert.equal(response.status, 200, output)
  const initial = await response.json() as { coreManaged: boolean; currentUser: { id: string; name: string; role: string }; users: unknown[] }
  assert.equal(initial.coreManaged, true)
  assert.equal(initial.currentUser.name, 'Core Person')
  assert.equal(initial.users.length, 1, 'an empty module database is lazily provisioned')
  const overtimeSettings={revision:0,overtimeAllowed:true,scope:'balance',balanceOvertimeMinutes:1200,balanceUndertimeMinutes:600,dailyOvertimeMinutes:null,dailyUndertimeMinutes:null,emailEnabled:false,recipientUserIds:[initial.currentUser.id]}
  assert.equal((await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers:{...headers,Origin:'https://attacker.invalid'},body:JSON.stringify(overtimeSettings)})).status,403)
  response=await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers,body:JSON.stringify(overtimeSettings)})
  assert.equal(response.status,200)
  assert.equal((await response.json() as {overtimePolicy:{policy:{revision:number}}}).overtimePolicy.policy.revision,1)
  assert.equal((await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers,body:JSON.stringify(overtimeSettings)})).status,409)
  assert.equal(introspections.at(-1)?.token, 'valid-core-token', 'Core cookie takes priority over obsolete module bearer')
  response = await fetch(`${base}/api/sso/session`, { headers })
  assert.deepEqual(await response.json(), { token: 'core-cookie-session', stayLoggedIn: false }, 'browser SSO never discloses the HttpOnly session secret')
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer core-cookie-session' } })).status, 401, 'browser marker cannot authenticate after the cookie disappears')
  response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"person@example.invalid","password":"password"}' })
  assert.deepEqual(await response.json(), { token: 'core-cookie-session' })
  assert.match(response.headers.get('set-cookie') ?? '', /dco_core_session=valid-core-token;.*HttpOnly/)
  response = await fetch(`${base}/api/login`, { method: 'POST', headers, body: '{"email":"person@example.invalid","password":"password","clientType":"native"}' })
  assert.deepEqual(await response.json(), { token: 'core-cookie-session' }, 'a native flag cannot expose an ambient browser cookie credential')
  response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"person@example.invalid","password":"password","clientType":"native"}' })
  assert.deepEqual(await response.json(), { token: 'valid-core-token' }, 'explicit native clients retain supported Core bearer authentication')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer valid-core-token' } })).status, 200)
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer obsolete-module-token' } })).status, 401)
  assert.equal((await fetch(`${base}/api/clock`, { method: 'POST', headers, body: '{"action":"start_work"}' })).status, 200)
  // An overdue open entry would be closed by stateForUser unless its onboarding guard runs first.
  const database = new DatabaseSync(join(directory, 'time.sqlite'))
  const columns=database.prepare('PRAGMA table_info(users)').all().map(column=>String(column.name))
  database.prepare(`INSERT INTO users (${columns.join(',')}) SELECT ${columns.map(column=>column==='id'?"'other-employee'":column==='email'?"'other@example.invalid'":column==='coreUserId'?'NULL':column==='name'?"'Other employee'":column==='role'?"'employee'":column).join(',')} FROM users WHERE id=?`).run(initial.currentUser.id)
  const proposal={type:'time_correction',correctionDate:'2026-09-01',proposedStartTime:'09:00',proposedEndTime:'17:30',proposedBreakMinutes:30,reason:'Synthetic reviewed correction',targetUserId:'other-employee',reviewProposal:true}
  assert.equal((await fetch(`${base}/api/requests`,{method:'POST',headers,body:JSON.stringify(proposal)})).status,400,'unconfirmed estimate cannot be submitted')
  response=await fetch(`${base}/api/requests`,{method:'POST',headers,body:JSON.stringify({...proposal,proposalConfirmed:true})})
  assert.equal(response.status,201)
  const created=await response.json() as {currentUser:{id:string};requests:Array<{id:string;userId:string;status:string}>}
  assert.equal(created.currentUser.id,initial.currentUser.id,'on-behalf creation retains the administrator session identity')
  assert.equal(created.requests[0].userId,'other-employee');assert.equal(created.requests[0].status,'pending')
  assert.equal(database.prepare('SELECT COUNT(*) n FROM time_entries WHERE userId=?').get('other-employee')!.n,0,'preparing a request does not modify work')
  moduleRole='employee'
  assert.equal((await fetch(`${base}/api/requests`,{method:'POST',headers,body:JSON.stringify({...proposal,proposalConfirmed:true})})).status,403,'an employee cannot target another employee')
  // Personal sharing directory and writes must respect the administrator's groups.
  const calendarState=async()=>await (await fetch(`${base}/api/state`,{headers})).json() as {shareableCalendarUsers:Array<{id:string;name:string;email:string;active:boolean}>,visibleCalendarUsers:Array<{id:string}>,currentUser:{calendarAccessUserIds:string[]}}
  assert.deepEqual((await calendarState()).shareableCalendarUsers,[],'no directory outside assigned groups')
  database.prepare('INSERT INTO calendar_groups (id,name,memberUserIds,createdAt) VALUES (?,?,?,?)').run('sharing-test','Sharing test',JSON.stringify([initial.currentUser.id,'other-employee']),new Date().toISOString())
  assert.deepEqual((await calendarState()).shareableCalendarUsers,[{id:'other-employee',name:'Other employee',email:'other@example.invalid',active:true}],'only identity and contact fields are returned for eligible recipients')
  const accessUrl=`${base}/api/users/${initial.currentUser.id}/calendar-access`
  response=await fetch(accessUrl,{method:'PATCH',headers,body:JSON.stringify({calendarAccessUserIds:['other-employee']})})
  assert.equal(response.status,200)
  let calendar=await calendarState()
  assert.deepEqual(calendar.currentUser.calendarAccessUserIds,['other-employee'])
  assert.deepEqual(calendar.visibleCalendarUsers.map(user=>user.id),[initial.currentUser.id],'granting access does not give reciprocal access')
  assert.equal((await fetch(`${base}/api/users/other-employee/calendar-access`,{method:'PATCH',headers,body:JSON.stringify({calendarAccessUserIds:[initial.currentUser.id]})})).status,403,'cannot edit another calendar owner')
  database.prepare('UPDATE users SET calendarAccessUserIds=? WHERE id=?').run(JSON.stringify([initial.currentUser.id]),'other-employee')
  assert((await calendarState()).visibleCalendarUsers.some(user=>user.id==='other-employee'),'reciprocal visibility requires an independent grant')
  response=await fetch(accessUrl,{method:'PATCH',headers,body:JSON.stringify({calendarAccessUserIds:[]})})
  assert.equal(response.status,200)
  assert.deepEqual((await calendarState()).currentUser.calendarAccessUserIds,[],'personal access can be revoked')
  database.prepare('UPDATE users SET active=0 WHERE id=?').run('other-employee')
  assert.deepEqual((await calendarState()).shareableCalendarUsers,[],'inactive people cannot be found')
  database.prepare('UPDATE users SET active=1 WHERE id=?').run('other-employee')
  database.prepare('DELETE FROM calendar_groups WHERE id=?').run('sharing-test')
  response=await fetch(accessUrl,{method:'PATCH',headers,body:JSON.stringify({calendarAccessUserIds:['other-employee']})})
  assert.equal(response.status,200)
  calendar=await calendarState()
  assert.deepEqual(calendar.currentUser.calendarAccessUserIds,[],'out-of-group grants are stripped on the server')
  assert.deepEqual(calendar.shareableCalendarUsers,[])
  assert.deepEqual(calendar.visibleCalendarUsers.map(user=>user.id),[initial.currentUser.id],'removing group eligibility also removes visibility')
  moduleRole='admin'
  database.prepare('DELETE FROM users WHERE id=?').run('other-employee')
  const oldStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  database.prepare("UPDATE time_entries SET startedAt=?,note='private-entry-note' WHERE userId=?").run(oldStart, initial.currentUser.id)
  database.prepare('UPDATE users SET balanceAdjustmentMinutes=1234,expectedWeeklyMinutes=3000 WHERE id=?').run(initial.currentUser.id)
  const beforeEntries = database.prepare('SELECT * FROM time_entries ORDER BY id').all()
  mustChangePassword = true
  response = await fetch(`${base}/api/state`, { headers })
  assert.equal(response.status,200,'safe identity state keeps the forced-password UI usable')
  const restricted = await response.json() as Record<string, unknown> & {currentUser:{mustChangePassword:boolean;balanceAdjustmentMinutes:number;expectedWeeklyMinutes:number};users:unknown[]}
  assert.equal(restricted.currentUser.mustChangePassword,true)
  assert.equal(restricted.currentUser.balanceAdjustmentMinutes,0)
  assert.equal(restricted.currentUser.expectedWeeklyMinutes,0)
  assert.equal(restricted.users.length,1)
  for (const key of ['visibleCalendarUsers','shareableCalendarUsers','calendarGroups','calDavAccounts','externalCalendarEvents','customCalendarEvents','timeEntries','adminTimeEntries','absences','holidays','holidayOverrides','requests','notifications','importBatches','userInvitations','summaries','dayIssues']) assert.deepEqual(restricted[key],[],key)
  assert.deepEqual(restricted.backup,{dataFile:'',backupDir:'',nextAutomaticCheck:''})
  assert.deepEqual(restricted.holidaySettings,{country:'',language:''})
  assert.equal(restricted.mailServerSettings,undefined)
  assert.equal(restricted.overtimePolicy,undefined)
  assert.equal((await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers,body:JSON.stringify({...overtimeSettings,revision:1})})).status,403)
  assert.equal(JSON.stringify(restricted).includes('private-entry-note'),false)
  assert.deepEqual(database.prepare('SELECT * FROM time_entries ORDER BY id').all(),beforeEntries,'forced state must not auto-close or edit business entries')
  assert.equal((await fetch(`${base}/api/clock`, {method:'POST',headers,body:'{"action":"stop_work"}'})).status,403)
  assert.equal((await fetch(`${base}/api/exports/time-csv?period=day&date=2026-09-01`, {headers})).status,403)
  mustChangePassword = false
  database.close()
  socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers })
  await once(socket, 'open')
  const stateMessage = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'auth', token: 'core-cookie-session' }))
  await stateMessage
  revoked = true
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 401)
  const closed = once(socket, 'close')
  socket.send(JSON.stringify({ type: 'refresh' }))
  const [code] = await closed
  assert.equal(code, 1008)
  revoked = false; readOnly = true
  assert.equal((await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers,body:JSON.stringify({...overtimeSettings,revision:1})})).status,403)
  assert.equal((await fetch(`${base}/api/clock`, { method: 'POST', headers, body: '{"action":"stop_work"}' })).status, 403)
  assert.equal((await fetch(`${base}/api/exports/time-csv?period=day&date=2026-09-01`, { headers })).status, 200)
  readOnly = false; moduleRole = 'employee'
  response = await fetch(`${base}/api/state`, { headers })
  const demoted = await response.json() as typeof initial
  assert.equal(demoted.currentUser.id, initial.currentUser.id)
  assert.equal(demoted.currentUser.role, 'employee', 'module membership controls local authority even for a Core administrator')
  assert.equal('overtimePolicy' in demoted,false)
  assert.equal((await fetch(`${base}/api/settings/overtime-policy`,{method:'PATCH',headers,body:JSON.stringify({...overtimeSettings,revision:1})})).status,403)
  assert.equal((await fetch(`${base}/api/settings/overtime-policy/retry-failed`,{method:'POST',headers,body:'{}'})).status,403)
  assert.equal((await fetch(`${base}/api/backups/weekly`, { method: 'POST', headers, body: '{}' })).status, 403)
  response = await fetch(`${base}/api/account/password`, { method: 'POST', headers, body: '{"currentPassword":"old","password":"new","passwordConfirm":"new"}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { requiresSignIn: boolean }).requiresSignIn, true)
  assert.match(response.headers.get('set-cookie') ?? '', /dco_core_session=;/)
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 401)
})
