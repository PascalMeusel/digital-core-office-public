import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'

test('password recovery sends a usable email link and replaces credentials while revoking old sessions and reset links', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-reset-mail-'))
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  const messages: string[] = [], recipients: string[] = [], sockets = new Set<Socket>()
  const smtp = createTcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let buffer = '', data: string[] | undefined
    socket.setEncoding('utf8'); socket.write('220 localhost synthetic SMTP\r\n')
    socket.on('data', chunk => {
      buffer += String(chunk)
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (data) {
          if (line === '.') { messages.push(data.join('\r\n')); data = undefined; socket.write('250 queued locally\r\n') }
          else data.push(line.replace(/^\.\./, '.'))
        } else if (/^(EHLO|HELO)/i.test(line)) socket.write('250-localhost\r\n250 SIZE 1048576\r\n')
        else if (/^RCPT TO:/i.test(line)) { recipients.push(line); socket.write('250 recipient accepted\r\n') }
        else if (/^(MAIL FROM:|RSET|NOOP)/i.test(line)) socket.write('250 OK\r\n')
        else if (/^DATA$/i.test(line)) { data = []; socket.write('354 End with dot\r\n') }
        else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n')
        else socket.write('502 Unsupported test command\r\n')
      }
    })
  })
  await new Promise<void>(done => smtp.listen(0, '127.0.0.1', done))
  const smtpAddress = smtp.address(); assert(smtpAddress && typeof smtpAddress !== 'string')
  Object.assign(process.env, {
    DCO_CORE_DATA: join(directory, 'core.sqlite'), DCO_PUBLIC_BASE_URL: 'https://office.example.invalid',
    DCO_INITIAL_ADMIN_EMAIL: 'reset-user@example.invalid', DCO_INITIAL_ADMIN_PASSWORD: 'Previous synthetic password 2026!',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpAddress.port), SMTP_SECURE: 'false',
    SMTP_FROM: 'Test Office <sender@example.invalid>', NODE_ENV: 'production',
  })
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS
  const core = await import('../server/core.ts'), { app } = await import('../server/index.ts')
  const http = createHttpServer(app)
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  const httpAddress = http.address(); assert(httpAddress && typeof httpAddress !== 'string')
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${httpAddress.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.DCO_PUBLIC_BASE_URL! }, body: JSON.stringify(body),
  })
  try {
    const user = core.authenticate(process.env.DCO_INITIAL_ADMIN_EMAIL, process.env.DCO_INITIAL_ADMIN_PASSWORD)!
    assert(user); const priorSession = core.createSession(user.id), older = core.createPasswordReset(user.email)!
    const response = await post('/api/core/auth/password-reset/request', { email: ` ${user.email.toUpperCase()} ` })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { accepted: true })
    assert.equal(messages.length, 1); assert.equal(recipients.length, 1); assert.match(recipients[0]!, /reset-user@example\.invalid/)
    const decoded = messages[0]!.replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    const token = decoded.match(/https:\/\/office\.example\.invalid\/\?reset=([A-Za-z0-9_-]+)/)?.[1]
    assert(token, 'SMTP email contains a valid public reset link')
    const unknown = await post('/api/core/auth/password-reset/request', { email: 'unknown@example.invalid' })
    assert.equal(unknown.status, 200); assert.deepEqual(await unknown.json(), { accepted: true }); assert.equal(messages.length, 1)
    assert.equal((await post('/api/core/auth/password-reset/complete', { token, password: 'too short' })).status, 400)
    assert(core.userForSession(priorSession.token), 'Invalid new password does not revoke a valid session')
    const nextPassword = 'New synthetic password 2026!'
    const completed = await post('/api/core/auth/password-reset/complete', { token, password: nextPassword })
    assert.equal(completed.status, 200); assert.equal((await completed.json()).completed, true)
    assert.equal(core.authenticate(user.email, process.env.DCO_INITIAL_ADMIN_PASSWORD), undefined)
    assert.equal(core.authenticate(user.email, nextPassword)?.mustChangePassword, false)
    assert.equal(core.userForSession(priorSession.token), undefined)
    for (const usedToken of [token, older.token]) assert.equal((await post('/api/core/auth/password-reset/complete', { token: usedToken, password: 'Another synthetic password!' })).status, 400)
    const login = await post('/api/core/auth/login', { email: user.email, password: nextPassword })
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie') ?? '', /dco_core_session=/)
  } finally {
    await new Promise<void>(done => http.close(() => done()))
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(done => smtp.close(() => done()))
    core.closeConnection(); rmSync(directory, { recursive: true, force: true })
  }
})
