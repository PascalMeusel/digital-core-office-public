import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ZeitguruStore } from '../server/zeitguruStore.ts'
import { ZeitguruHistoryStore } from '../server/zeitguruHistoryStore.ts'
import { addDays, businessDateKey } from '../shared/dates.ts'
import type { StatePayload } from '../shared/domain.ts'
import type { ZeitguruAccountingReport } from '../shared/zeitguruAccounting.ts'

test('Zeitguru HTTP routes enforce feature, own Core identity, forced-change, CSRF and transactional duplicate guards', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-zeitguru-http-'))
  const safeDirectory = resolve(directory), tempRoot = resolve(tmpdir())
  assert.ok(safeDirectory.startsWith(tempRoot + sep))
  const key = 'synthetic-zeitguru-http-encryption-secret'
  const oldKey = process.env.DATA_ENCRYPTION_KEY
  let journal: ZeitguruStore | undefined, sql: DatabaseSync | undefined
  let history: ZeitguruHistoryStore | undefined
  let forced = false, readOnly = false, revoked = false
  const core = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part
    const body = JSON.parse(raw || '{}') as { token?: string; write?: boolean; allowPasswordChange?: boolean }
    response.setHeader('Content-Type', 'application/json')
    if (request.url !== '/api/core/internal/introspect') { response.statusCode = 404; response.end('{}'); return }
    if (revoked || !['employee-token', 'other-token'].includes(body.token ?? '')) { response.statusCode = 401; response.end('{"message":"Authentication required"}'); return }
    if ((forced && !body.allowPasswordChange) || (readOnly && body.write)) { response.statusCode = 403; response.end('{"message":"Account restricted"}'); return }
    const id = body.token === 'other-token' ? 'other-employee' : 'employee'
    response.end(JSON.stringify({ user: { id, name: 'Synthetic Employee', email: `${id}@example.test`, role: 'employee', moduleRole: 'employee', active: true, mustChangePassword: forced, readOnly } }))
  })
  core.listen(0, '127.0.0.1'); await once(core, 'listening')
  const coreAddress = core.address(); assert.ok(coreAddress && typeof coreAddress !== 'string')
  const guard = join(directory, 'deny-vendor-network.mjs')
  writeFileSync(guard, `const localFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(String(input));if(url.hostname!=='127.0.0.1')throw new Error('External network forbidden in HTTP test');return localFetch(input,init)};`)
  const children: ReturnType<typeof spawn>[] = []
  t.after(async () => {
    await Promise.all(children.map(async (child) => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended } }))
    await new Promise<void>((done) => core.close(() => done()))
    sql?.close(); journal?.close(); history?.close()
    if (oldKey === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = oldKey
    rmSync(safeDirectory, { recursive: true, force: true })
  })
  async function start(enabled: boolean) {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
    const address = probe.address(); assert.ok(address && typeof address !== 'string')
    await new Promise<void>((done) => probe.close(() => done()))
    const path = join(directory, enabled ? 'enabled.sqlite' : 'disabled.sqlite')
    const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, '--import', 'tsx', 'server/index.ts'], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ZEITGURU_EVALUATION_ENABLED: String(enabled), DCO_CORE_URL: `http://127.0.0.1:${coreAddress.port}`, DCO_CORE_LOGIN_URL: 'https://office.example.test', DCO_INTERNAL_AUTH_SECRET: 'synthetic-internal-secret', DATA_ENCRYPTION_KEY: key, REQUIRE_DATA_ENCRYPTION: 'true', TIME_TRACKER_DATA: path, TIME_TRACKER_BACKUP_DIR: join(directory, enabled ? 'enabled-backups' : 'disabled-backups'), INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '', DCO_TIMEZONE: 'Europe/Berlin', PORT: String(address.port), HOST: '127.0.0.1', SMTP_HOST: '' },
    })
    children.push(child)
    let output = ''; child.stdout!.on('data', (chunk) => { output += String(chunk) }); child.stderr!.on('data', (chunk) => { output += String(chunk) })
    const base = `http://127.0.0.1:${address.port}`
    for (let attempt = 0; attempt < 400; attempt++) {
      if (child.exitCode !== null) assert.fail(output)
      if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) return { base, path, output: () => output }
      await new Promise((done) => setTimeout(done, 25))
    }
    assert.fail('Synthetic Time server did not become ready')
  }
  const headers = { Cookie: 'dco_core_session=employee-token', 'Content-Type': 'application/json', Origin: 'https://office.example.test' }
  const disabled = await start(false)
  assert.equal((await fetch(`${disabled.base}/api/zeitguru`, { headers })).status, 404)
  assert.equal((await fetch(`${disabled.base}/api/zeitguru/history`, { headers })).status, 404)
  const enabled = await start(true)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru`)).status, 401)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history`)).status, 401)
  let response = await fetch(`${enabled.base}/api/zeitguru`, { headers })
  assert.equal(response.status, 200, enabled.output())
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const disconnected = await response.json() as { enabled: boolean }
  assert.equal(disconnected.enabled, false)

  // Seed synthetic encrypted credentials and a queued record without invoking the delivery worker.
  process.env.DATA_ENCRYPTION_KEY = key
  journal = new ZeitguruStore(enabled.path); sql = new DatabaseSync(enabled.path)
  const localUserId = String(sql.prepare('SELECT id FROM users WHERE coreUserId=?').get('employee')!.id)
  journal.connect({ userId: localUserId, providerKey: 'synthetic-company:employee', expectedGeneration: 0, auth: { idToken: 'private-test-token', refreshToken: 'private-test-refresh' }, config: { name: 'Own synthetic name', email: 'employee@example.test', branchName: 'Own synthetic office' } })
  response = await fetch(`${enabled.base}/api/state`, { headers })
  assert.equal(response.status, 200)
  const beforeImport = await response.json() as StatePayload
  assert.ok(beforeImport.serverTime && Math.abs(Date.now() - Date.parse(beforeImport.serverTime)) < 5000, 'State includes current server time')
  const beforeSummary = beforeImport.summaries.find(value => value.userId === localUserId)!
  const historyDate = addDays(businessDateKey(), -1)
  const accounting: ZeitguruAccountingReport = {
    fromDate: historyDate, toDate: historyDate, observedAt: new Date().toISOString(), openingKnown: false, balanceBasis: 'period_delta',
    opening: {date: historyDate, minutes: 0}, openingBalanceMinutes: 0, closingBalanceMinutes: -30,
    days: [{date: historyDate, expectedMinutes: 480, workedMinutes: 450, absenceMinutes: 0, holidayMinutes: 0, correctionMinutes: 0, creditedMinutes: 450, balanceMinutes: -30, exactDeltaMinutes: -30, details: {rawPrivateAccounting: 'private-accounting-day-evidence'}}],
    forecast: [], contracts: [], warnings: [], details: {rawPrivateReport: 'private-accounting-report-evidence'},
  }
  history = new ZeitguruHistoryStore(enabled.path)
  const imported = history.importBatch({userId: localUserId, providerKey: 'synthetic-company:employee', expectedGeneration: 1, clientRequestId: 'synthetic-history-request', fromDate: historyDate, toDate: historyDate, rows: [
    {sourceId: 'private-source-reference', date: historyDate, startedAt: `${historyDate}T08:00:00Z`, stoppedAt: `${historyDate}T16:00:00Z`, breakMinutes: 30, workedMinutes: 450, creditedMinutes: 450, approved: true, details: {rawPrivateEvidence: 'private-history-evidence'}},
  ], accounting})
  response = await fetch(`${enabled.base}/api/zeitguru/history?userId=other-employee`, {headers})
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const ownHistoryText = await response.text()
  assert.equal(ownHistoryText.includes('private-source-reference'), false)
  assert.equal(ownHistoryText.includes('private-history-evidence'), false)
  assert.equal(JSON.parse(ownHistoryText).rows.length, 1)
  assert.equal(JSON.parse(ownHistoryText).status.accounting.batchId, imported.batch.id)
  response = await fetch(`${enabled.base}/api/state`, { headers })
  assert.equal(response.status, 200)
  const ownStateText = await response.text(), ownState = JSON.parse(ownStateText) as StatePayload
  const ownContext = ownState.zeitguruAccounting?.[localUserId]
  assert.ok(ownContext)
  assert.deepEqual(Object.keys(ownState.zeitguruAccounting!), [localUserId])
  assert.equal(ownContext.batchId, imported.batch.id)
  assert.equal(ownContext.openingKnown, false)
  assert.equal(ownContext.days[0].expectedMinutes, 480)
  assert.equal(ownContext.days[0].exactDeltaMinutes, -30)
  assert.equal(ownState.timeEntries.length, 1)
  assert.equal(ownState.timeEntries[0].source, 'zeitguru')
  assert.equal(ownState.timeEntries[0].zeitguru?.readOnly, true)
  assert.equal(ownState.timeEntries[0].zeitguru?.workedMinutes, 450)
  assert.equal(ownState.clockStatus, beforeImport.clockStatus)
  assert.equal(ownState.todayEntry, undefined)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM time_entries').get()!.n, 0, 'projection never inserts native entries')
  const ownSummary = ownState.summaries.find(value => value.userId === localUserId)!
  assert.equal(ownSummary.balanceReviewRequired, true)
  if (historyDate.slice(0, 4) === businessDateKey().slice(0, 4)) {
    assert.equal(ownSummary.year.workedMinutes, beforeSummary.year.workedMinutes + 450)
    assert.equal(ownSummary.year.expectedMinutes, beforeSummary.year.expectedMinutes + 480)
    assert.equal(ownSummary.year.plusMinusMinutes, beforeSummary.year.plusMinusMinutes - 30)
  }
  assert.ok(ownState.dayIssues.some(issue => issue.source === 'zeitguru' && issue.date === historyDate && issue.suggestions.some(suggestion => suggestion.action === 'zeitguru_history')))
  for (const marker of ['private-source-reference', 'private-history-evidence', 'private-accounting-day-evidence', 'private-accounting-report-evidence', 'rawPrivateAccounting', 'rawPrivateReport']) assert.equal(ownStateText.includes(marker), false)
  response = await fetch(`${enabled.base}/api/zeitguru/history?fromDate=${addDays(historyDate, 1)}`, {headers})
  assert.equal((await response.json() as {rows: unknown[]}).rows.length, 0)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history?fromDate=2025-02-31`, {headers})).status, 400)
  response = await fetch(`${enabled.base}/api/zeitguru/history?userId=${localUserId}`, {headers: {...headers, Cookie: 'dco_core_session=other-token'}})
  const otherHistory = await response.json() as {rows: unknown[]; status: {accounting?: unknown}}
  assert.equal(otherHistory.rows.length, 0)
  assert.equal(otherHistory.status.accounting, undefined)
  response = await fetch(`${enabled.base}/api/state?userId=${localUserId}`, {headers: {...headers, Cookie: 'dco_core_session=other-token'}})
  assert.equal(response.status, 200)
  const otherStateText = await response.text(), otherState = JSON.parse(otherStateText) as StatePayload
  assert.notEqual(otherState.currentUser.id, localUserId)
  assert.equal(otherState.timeEntries.length, 0)
  assert.equal(otherState.adminTimeEntries, undefined)
  assert.equal(Object.keys(otherState.zeitguruAccounting ?? {}).length, 0)
  assert.equal(otherState.dayIssues.some(issue => issue.userId === localUserId), false)
  assert.equal(otherState.summaries.some(summary => summary.userId === localUserId), false)
  assert.equal(otherStateText.includes(imported.batch.id), false)
  assert.equal(otherStateText.includes('private-accounting'), false)
  const undoRequest = JSON.stringify({batchId: imported.batch.id, expectedFingerprint: imported.batch.fingerprint})
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history/undo`, {method: 'POST', headers: {...headers, Cookie: 'dco_core_session=other-token'}, body: undoRequest})).status, 404)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history/undo`, {method: 'POST', headers: {...headers, Origin: 'https://attacker.example'}, body: undoRequest})).status, 403)
  assert.equal(history.status(localUserId).totalRecords, 1)
  sql.exec('BEGIN IMMEDIATE')
  journal.withClockOperation(sql, { userId: localUserId, clientOperationId: 'duplicate-operation-1234', expectedGeneration: 1, expectedRevision: 0, action: 'start_work', request: { workLocation: null } }, () => ({ action: 'start_work', occurredAt: new Date().toISOString(), localEntryId: 'synthetic-entry' }))
  sql.exec('COMMIT')
  response = await fetch(`${enabled.base}/api/zeitguru`, { headers })
  const visible = await response.text()
  assert.equal(visible.includes('private-test-token'), false); assert.equal(visible.includes('private-test-refresh'), false)
  assert.equal(visible.includes('authCipher'), false); assert.equal(visible.includes('payloadCipher'), false)
  response = await fetch(`${enabled.base}/api/zeitguru/operations/duplicate-operation-1234`, { headers: { ...headers, Cookie: 'dco_core_session=other-token' } })
  assert.deepEqual(await response.json(), {})
  assert.equal((await fetch(`${enabled.base}/api/clock`, { method: 'POST', headers, body: '{"action":"start_work"}' })).status, 409)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM time_entries').get()!.n, 0)
  response = await fetch(`${enabled.base}/api/clock`, { method: 'POST', headers, body: '{"action":"start_work","clientOperationId":"duplicate-operation-1234","expectedRevision":0,"expectedGeneration":0}' })
  assert.equal(response.status, 200)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM time_entries').get()!.n, 0, 'duplicate does not apply a second local action')
  assert.equal(journal.operation(localUserId, 'duplicate-operation-1234')?.status, 'queued', 'duplicate does not trigger the provider worker')
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/disconnect`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{"expectedGeneration":1}' })).status, 403)
  assert.equal(journal.status(localUserId).enabled, true)
  forced = true
  assert.equal((await fetch(`${enabled.base}/api/zeitguru`, { headers })).status, 403)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/login`, { method: 'POST', headers, body: '{"email":"employee@example.test","password":"private-test-password"}' })).status, 403)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history`, {headers})).status, 403)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history/import`, {method: 'POST', headers, body: '{}'})).status, 403)
  forced = false; readOnly = true
  assert.equal((await fetch(`${enabled.base}/api/clock`, { method: 'POST', headers, body: '{"action":"start_work"}' })).status, 403)
  assert.equal((await fetch(`${enabled.base}/api/zeitguru/history/undo`, {method: 'POST', headers, body: undoRequest})).status, 403)
  readOnly = false
  response = await fetch(`${enabled.base}/api/zeitguru/history/undo`, {method: 'POST', headers, body: undoRequest})
  assert.equal(response.status, 200)
  assert.equal(history.status(localUserId).totalRecords, 0)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM time_entries').get()!.n, 0)
  response = await fetch(`${enabled.base}/api/state`, {headers})
  assert.equal(response.status, 200)
  const afterUndo = await response.json() as StatePayload
  assert.deepEqual(afterUndo.timeEntries, beforeImport.timeEntries)
  assert.equal(afterUndo.zeitguruAccounting?.[localUserId], undefined)
  assert.equal(afterUndo.dayIssues.some(issue => issue.source === 'zeitguru'), false)
  assert.deepEqual(afterUndo.summaries.find(summary => summary.userId === localUserId), beforeSummary)
  assert.equal(afterUndo.zeitguru?.enabled, true, 'undo leaves the existing connection enabled')
  response = await fetch(`${enabled.base}/api/zeitguru/history`, {headers})
  const undoneHistory = await response.json() as {rows: unknown[]; status: {totalRecords: number; accounting?: unknown}}
  assert.deepEqual(undoneHistory.rows, [])
  assert.equal(undoneHistory.status.totalRecords, 0)
  assert.equal(undoneHistory.status.accounting, undefined)
  revoked = true
  assert.equal((await fetch(`${enabled.base}/api/zeitguru`, { headers })).status, 401)
  assert.equal(enabled.output().includes('private-test-token'), false)
})
