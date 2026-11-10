import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { restoreSuiteBackup, parseArguments, isDirectExecution } from './suite-backup-lib.mjs'

export async function verifyBackup({ directory, keyFile, now = Date.now() }) {
  const root = realpathSync(directory)
  const statusFile = join(root, 'verification-result.json')
  let temporary
  try {
    const latest = JSON.parse(readFileSync(join(root, 'scheduled/latest-result.json'), 'utf8'))
    if (!latest.ok || typeof latest.bundle !== 'string') throw new Error('No successful backup is recorded.')
    const bundle = resolve(latest.bundle)
    if (!bundle.startsWith(root + '/') && !bundle.startsWith(root + '\\')) throw new Error('Backup is outside the backup directory.')
    if (!lstatSync(bundle).isFile() || lstatSync(bundle).isSymbolicLink()) throw new Error('Invalid backup file.')
    if (now - lstatSync(bundle).mtimeMs > 36 * 3_600_000) throw new Error('The latest backup is too old.')
    const parent = join(root, 'verification')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (lstatSync(parent).isSymbolicLink()) throw new Error('Invalid verification directory.')
    temporary = mkdtempSync(join(parent, 'restore-'))
    const restored = await restoreSuiteBackup({ bundle, keyFile, target: join(temporary, 'data') })
    const result = { ok: true, completedAt: now, bundle, modules: restored.modules, files: restored.files, configIncluded: restored.configIncluded }
    writeFileSync(statusFile, JSON.stringify(result), { mode: 0o600 })
    return result
  } catch (error) {
    writeFileSync(statusFile, JSON.stringify({ ok: false, completedAt: now }), { mode: 0o600 })
    throw error
  } finally {
    // Only remove the private, freshly allocated verification directory.
    if (temporary && existsSync(temporary)) rmSync(temporary, { recursive: true, force: true })
  }
}

if (isDirectExecution(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  try { console.log(JSON.stringify(await verifyBackup({ directory: options.directory, keyFile: options['key-file'] }))) }
  catch { console.error('Backup restore verification failed. See the protected verification status.'); process.exitCode = 1 }
}
