import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const statusFile = '/tmp/dco-suite-backup-status.json'
const intervalHours = Number(process.env.DCO_BACKUP_INTERVAL_HOURS || 24)
const retainDays = Number(process.env.DCO_BACKUP_RETAIN_DAYS || 30)
if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('DCO_BACKUP_INTERVAL_HOURS must be between 1 and 168.')
if (!Number.isInteger(retainDays) || retainDays < 1) throw new Error('DCO_BACKUP_RETAIN_DAYS must be a positive integer.')
if (process.argv.includes('--health')) {
  try {
    const status = JSON.parse(readFileSync(statusFile, 'utf8'))
    process.exit(status.ok && Date.now() - status.completedAt < (intervalHours + 1) * 3_600_000 ? 0 : 1)
  } catch { process.exit(1) }
}

let stopped = false
let child
let timer
function stop() { stopped = true; clearTimeout(timer); child?.kill('SIGTERM') }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
async function run() {
  const result = await new Promise((done) => {
    child = spawn(process.execPath, [join(import.meta.dirname, 'backup-suite.mjs'), '--data-root=/data', '--output=/backups', '--key-file=/run/secrets/backup_key', `--retain-days=${retainDays}`], { stdio: 'inherit' })
    child.once('error', () => done(1))
    child.once('exit', (code) => done(code ?? 1))
  })
  child = undefined
  writeFileSync(statusFile, JSON.stringify({ ok: result === 0, completedAt: Date.now() }), { mode: 0o600 })
  if (!stopped) timer = setTimeout(() => void run(), result === 0 ? intervalHours * 3_600_000 : 5 * 60_000)
}
void run()
