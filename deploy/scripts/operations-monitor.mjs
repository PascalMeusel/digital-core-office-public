import { existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { parseArguments, isDirectExecution } from './suite-backup-lib.mjs'

export function loadMailer(corePackage) { return createRequire(corePackage)('nodemailer') }

export function monitoredServices(raw = process.env.DCO_ENABLED_MODULES ?? 'time,inventory,agile') {
  const ports = { time: 4177, inventory: 4187, agile: 4197 }
  const modules = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))]
  if (!modules.length || modules.some(module => !Object.hasOwn(ports, module))) throw new Error('Invalid enabled modules for health checks.')
  return { core: 4167, ...Object.fromEntries(modules.map(module => [module, ports[module]])) }
}

export function operationalProblems({ health, backup, backupAge, backupFailed, verification, diskFreeRatio, now = Date.now() }) {
  const problems = []
  for (const [module, ok] of Object.entries(health)) if (!ok) problems.push(`${module} health check failed`)
  if (!backup?.ok || !Number.isFinite(backupAge) || backupAge > 36 * 3_600_000 || backupFailed) problems.push('Daily backup failed or is older than 36 hours')
  if (!verification?.ok || !Number.isFinite(verification.completedAt) || now - verification.completedAt > 8 * 86_400_000) problems.push('Weekly backup restore verification failed or is overdue')
  if (!Number.isFinite(diskFreeRatio) || diskFreeRatio < 0.15) problems.push('Server disk has less than 15% available space')
  return problems.sort()
}

export async function recordAndNotify({ stateFile, problems, send, now = Date.now() }) {
  let previous
  try { previous = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
  const changed = JSON.stringify(previous?.problems) !== JSON.stringify(problems)
  if (changed && (problems.length || previous?.problems?.length)) {
    // Persist only after delivery. A failed SMTP connection remains retryable.
    await send(problems.length ? 'Digital Core Office: action required' : 'Digital Core Office: recovered',
      problems.length ? problems.join('\n') : 'All monitored services, backups, restore checks and disk space have recovered.')
  }
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
  writeFileSync(stateFile, JSON.stringify({ problems, checkedAt: now }), { mode: 0o600 })
  return { ok: problems.length === 0, problems, notified: changed && Boolean(problems.length || previous?.problems?.length) }
}

async function run(options) {
  const backupDirectory = options['backup-directory'] || '/var/backups/digital-core-office'
  const stateFile = options['state-file'] || '/var/lib/digital-core-office-operations/monitor.json'
  const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
  const backup = readJson(join(backupDirectory, 'scheduled/latest-result.json'))
  const verification = readJson(join(backupDirectory, 'verification-result.json'))
  const health = Object.fromEntries(await Promise.all(Object.entries(monitoredServices()).map(async ([module, port]) =>
    [module, await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false)])))
  let backupAge, backupFailed = true
  if (backup?.bundle && existsSync(backup.bundle)) backupAge = Date.now() - statSync(backup.bundle).mtimeMs
  try { backupFailed = execFileSync('systemctl', ['show', 'digital-core-office-suite-backup.service', '--property=Result', '--value'], { encoding: 'utf8' }).trim() !== 'success' } catch {}
  const disk = statfsSync(backupDirectory)
  const problems = operationalProblems({ health, backup, backupAge, backupFailed, verification, diskFreeRatio: disk.bavail / disk.blocks })
  const nodemailer = loadMailer(options['core-package'] || '/opt/digital-core-office/current/core-service/package.json')
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM || !options.recipient) throw new Error('Missing alert mail configuration.')
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 })
  if (options['verify-mail'] === 'true') { await transport.verify(); return { ok: true, smtpVerified: true } }
  if (options['test-mail'] === 'true') {
    const delivered = await transport.sendMail({ from: process.env.SMTP_FROM, to: options.recipient, subject: 'Digital Core Office monitoring configured', text: 'Operational alerts are configured for this address. Encrypted daily backups and weekly restore verification remain on the existing company server.' })
    if (!delivered.accepted.length) throw new Error('Alert recipient was not accepted.')
    return { ok: true, testMailAccepted: true }
  }
  return recordAndNotify({ stateFile, problems, send: (subject, text) => transport.sendMail({ from: process.env.SMTP_FROM, to: options.recipient, subject, text }) })
}

if (isDirectExecution(import.meta.url)) {
  try { console.log(JSON.stringify(await run(parseArguments(process.argv.slice(2))))) }
  catch { console.error('Operational monitoring or alert delivery failed. No credentials are included in this log.'); process.exitCode = 1 }
}
