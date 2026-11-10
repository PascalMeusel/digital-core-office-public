import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { operationalProblems, recordAndNotify, loadMailer, monitoredServices } from '../scripts/operations-monitor.mjs'
import { releaseRetentionPlan } from '../scripts/retain-releases.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dco-operations-test-'))
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  return root
}

test('health monitoring follows enabled products when Agile is removed', () => {
  assert.deepEqual(monitoredServices('time,inventory'), { core: 4167, time: 4177, inventory: 4187 })
  assert.deepEqual(monitoredServices('inventory'), { core: 4167, inventory: 4187 })
  assert.throws(() => monitoredServices('time,unknown'))
  assert.throws(() => monitoredServices(''))
})
test('monitor resolves the mail package entry instead of assuming a version-specific internal file', t => {
  const root = fixture(t), core = join(root, 'core'), vendor = join(core, 'node_modules/nodemailer')
  mkdirSync(vendor, { recursive: true })
  writeFileSync(join(core, 'package.json'), '{}')
  writeFileSync(join(vendor, 'package.json'), '{"main":"modern-entry.cjs"}')
  writeFileSync(join(vendor, 'modern-entry.cjs'), 'exports.createTransport = () => ({ fixture: true })')
  assert.deepEqual(loadMailer(join(core, 'package.json')).createTransport(), { fixture: true })
})
test('operations check backup age, restore verification, failed jobs, service health and available disk', () => {
  const now = 1_800_000_000_000
  const healthy = { now, health: { core: true, time: true }, backup: { ok: true }, backupAge: 1000, backupFailed: false, verification: { ok: true, completedAt: now }, diskFreeRatio: 0.5 }
  assert.deepEqual(operationalProblems(healthy), [])
  assert.equal(operationalProblems({ ...healthy, health: { time: false }, backupAge: 37 * 3_600_000, verification: { ok: false }, diskFreeRatio: 0.1 }).length, 4)
  assert.equal(operationalProblems({ ...healthy, backupFailed: true }).length, 1)
  assert.equal(operationalProblems({ ...healthy, verification: { ok: true, completedAt: now - 9 * 86_400_000 } }).length, 1)
})
test('alerts notify once per changed failure and once on recovery; failed SMTP remains retryable', async t => {
  const root = fixture(t), stateFile = join(root, 'status.json'), messages = []
  const send = async (...message) => { messages.push(message) }
  await recordAndNotify({ stateFile, problems: [], send })
  assert.equal(messages.length, 0)
  await recordAndNotify({ stateFile, problems: ['Backup failure'], send })
  await recordAndNotify({ stateFile, problems: ['Backup failure'], send })
  assert.equal(messages.length, 1)
  await assert.rejects(recordAndNotify({ stateFile, problems: [], send: async () => { throw Error('offline') } }))
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).problems, ['Backup failure'])
  await recordAndNotify({ stateFile, problems: [], send })
  assert.equal(messages.length, 2)
  assert.match(messages[1][0], /recovered/)
})
test('release retention keeps current, newest five and any running release without removing files in dry run', t => {
  const root = fixture(t), releases = join(root, 'releases')
  mkdirSync(releases)
  const paths = Array.from({ length: 9 }, (_, i) => join(releases, `20260930-company-r${i + 1}`))
  for (const path of paths) mkdirSync(path)
  const plan = releaseRetentionPlan({ releases, current: paths[1], protectedPaths: [paths[0]], keep: 5 })
  assert.deepEqual(plan.obsolete, [paths[3], paths[2]])
  assert.equal(readdirSync(releases).length, 9)
  assert.throws(() => releaseRetentionPlan({ releases, current: root }), /outside/)
  assert.throws(() => releaseRetentionPlan({ releases, current: paths[1], keep: 1 }), /three/)
})
