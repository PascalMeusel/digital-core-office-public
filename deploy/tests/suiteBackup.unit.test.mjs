import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSuiteBackup, parseArguments, restoreSuiteBackup } from '../scripts/suite-backup-lib.mjs'
import { verifyBackup } from '../scripts/verify-backup.mjs'

test('backup CLI executes through a symlinked current-release path instead of silently doing nothing', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t)
  const script = join(f.root, 'current-backup.mjs')
  symlinkSync(resolve(import.meta.dirname, '../scripts/backup-suite.mjs'), script)
  const output = execFileSync(process.execPath, [script, `--data-root=${f.dataRoot}`, `--output=${f.outputDirectory}`, `--key-file=${f.keyFile}`, '--modules=inventory'], { encoding: 'utf8' })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.ok(existsSync(result.bundle))
})

const names = { core: 'digital-core-office.sqlite', time: 'time-tracker.sqlite', inventory: 'inventory-system.sqlite', agile: 'agile-project.sqlite' }

function fixture(t, modules = ['core', 'inventory']) {
  const root = mkdtempSync(join(tmpdir(), 'dco-suite-backup-test-'))
  const dataRoot = join(root, 'data')
  const outputDirectory = join(root, 'backups')
  const keyFile = join(root, 'backup.key')
  const key = randomBytes(32)
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 })
  const sources = []
  for (const module of modules) {
    const directory = join(dataRoot, module)
    mkdirSync(directory, { recursive: true })
    const database = new DatabaseSync(join(directory, names[module]))
    database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT);')
    database.prepare('INSERT INTO entries(value) VALUES (?)').run(`${module} committed in WAL`)
    sources.push(database)
  }
  t.after(() => {
    sources.forEach((database) => database.close())
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, dataRoot, outputDirectory, keyFile, key, sources, modules }
}

function verifyEntry(path, value) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(database.prepare('SELECT value FROM entries').get().value, value)
  } finally { database.close() }
}

test('scheduled restore verification checks a real encrypted backup, cleans its private restore and records tampering', async t => {
  const f = fixture(t)
  const created = await createSuiteBackup(f)
  mkdirSync(join(f.outputDirectory, 'scheduled'))
  writeFileSync(join(f.outputDirectory, 'scheduled/latest-result.json'), JSON.stringify(created))
  const verified = await verifyBackup({ directory: f.outputDirectory, keyFile: f.keyFile })
  assert.equal(verified.ok, true)
  assert.deepEqual(verified.modules, f.modules)
  assert.deepEqual(readdirSync(join(f.outputDirectory, 'verification')), [])
  const bytes = readFileSync(created.bundle); bytes[bytes.length - 20] ^= 0x40; writeFileSync(created.bundle, bytes)
  await assert.rejects(verifyBackup({ directory: f.outputDirectory, keyFile: f.keyFile }))
  assert.equal(JSON.parse(readFileSync(join(f.outputDirectory, 'verification-result.json'))).ok, false)
  assert.deepEqual(readdirSync(join(f.outputDirectory, 'verification')), [])
  verifyEntry(join(f.dataRoot, 'core', names.core), 'core committed in WAL')
})

test('backs up only selected modules using online SQLite snapshots and round-trips nested attachments', async (t) => {
  const f = fixture(t)
  const media = join(f.dataRoot, 'inventory', 'media', '2026', 'September')
  mkdirSync(media, { recursive: true })
  const attachment = Buffer.from('%PDF-1.7\nDelivery note: five devices.\n%%EOF')
  writeFileSync(join(media, 'delivery-note.pdf'), attachment)
  writeFileSync(join(f.dataRoot, 'inventory', '.env'), 'DO_NOT_BACK_UP=secret')
  mkdirSync(join(f.dataRoot, 'inventory', 'backups'))
  writeFileSync(join(f.dataRoot, 'inventory', 'backups', 'old.sqlite'), 'do not include recursive backups')
  const created = await createSuiteBackup({ ...f, modules: 'inventory' })
  assert.deepEqual(created.modules, ['core', 'inventory'])
  assert.equal(created.files, 3)
  assert.ok(!readFileSync(created.bundle).includes(attachment))
  assert.equal(readdirSync(f.outputDirectory).length, 1)
  const target = join(f.root, 'restored')
  const restored = await restoreSuiteBackup({ bundle: created.bundle, target, keyFile: f.keyFile })
  assert.deepEqual(restored.modules, ['core', 'inventory'])
  verifyEntry(join(target, 'core', names.core), 'core committed in WAL')
  verifyEntry(join(target, 'inventory', names.inventory), 'inventory committed in WAL')
  assert.deepEqual(readFileSync(join(target, 'inventory', 'media', '2026', 'September', 'delivery-note.pdf')), attachment)
  assert.equal(existsSync(join(target, 'time')), false)
  assert.equal(existsSync(join(target, 'inventory', '.env')), false)
  assert.equal(existsSync(join(target, 'inventory', 'backups')), false)
  assert.ok(restored.requiredSeparately.some((item) => item.includes('data-encryption keys')))
})

test('supports all optional modules and explicitly included operator configuration', async (t) => {
  const f = fixture(t, Object.keys(names))
  const configFile = join(f.root, 'operator.env')
  writeFileSync(configFile, 'TIME_DATA_ENCRYPTION_KEY=separately-controlled-test-value')
  const created = await createSuiteBackup({ ...f, modules: 'time,inventory,agile', configFile })
  const target = join(f.root, 'empty-target')
  mkdirSync(target)
  await restoreSuiteBackup({ bundle: created.bundle, target, keyFile: f.keyFile })
  for (const module of Object.keys(names)) verifyEntry(join(target, module, names[module]), `${module} committed in WAL`)
  assert.equal(readFileSync(join(target, 'configuration', 'operator-config'), 'utf8'), readFileSync(configFile, 'utf8'))
})

test('refuses to overwrite live data and rejects wrong keys or modified encrypted bundles', async (t) => {
  const f = fixture(t)
  const created = await createSuiteBackup(f)
  await assert.rejects(restoreSuiteBackup({ bundle: created.bundle, target: f.dataRoot, keyFile: f.keyFile }), /new or empty/)
  const badKey = join(f.root, 'wrong.key')
  writeFileSync(badKey, randomBytes(32).toString('base64'))
  const target = join(f.root, 'should-not-exist')
  await assert.rejects(restoreSuiteBackup({ bundle: created.bundle, target, keyFile: badKey }))
  assert.equal(existsSync(target), false)
  const bytes = readFileSync(created.bundle)
  bytes[bytes.length - 20] ^= 0x40
  const tampered = join(f.outputDirectory, 'tampered.dco-backup')
  writeFileSync(tampered, bytes)
  await assert.rejects(restoreSuiteBackup({ bundle: tampered, target, keyFile: f.keyFile }))
  assert.equal(existsSync(target), false)
  assert.equal(readdirSync(f.root).some((name) => name.startsWith('.dco-suite-restore-')), false)
  verifyEntry(join(f.dataRoot, 'core', names.core), 'core committed in WAL')
})

function authenticatedBundle(f, manifest, payloads = []) {
  const header = Buffer.concat([Buffer.from('DCOSUITE2\0'), randomBytes(12)])
  const cipher = createCipheriv('aes-256-gcm', f.key, header.subarray(10))
  cipher.setAAD(header)
  const encoded = Buffer.from(JSON.stringify(manifest))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(encoded.length)
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.concat([length, encoded, ...payloads]))), cipher.final()])
  const path = join(f.root, `crafted-${randomBytes(4).toString('hex')}.dco-backup`)
  writeFileSync(path, Buffer.concat([header, encrypted, cipher.getAuthTag()]))
  return path
}

test('rejects authenticated traversal, checksum mismatches, and corrupt SQLite before publishing a restore', async (t) => {
  const f = fixture(t, ['core'])
  const contents = Buffer.from('this is not sqlite')
  const file = { path: `core/${names.core}`, kind: 'sqlite', size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }
  const manifest = { format: 'digital-core-office-suite', version: 2, modules: ['core'], files: [file] }
  const traversal = authenticatedBundle(f, { ...manifest, files: [file, { ...file, path: 'core/../../outside.sqlite', kind: 'asset' }] }, [contents, contents])
  const target = join(f.root, 'restored')
  await assert.rejects(restoreSuiteBackup({ bundle: traversal, target, keyFile: f.keyFile }), /Unsafe path/)
  const checksum = authenticatedBundle(f, { ...manifest, files: [{ ...file, sha256: '0'.repeat(64) }] }, [contents])
  await assert.rejects(restoreSuiteBackup({ bundle: checksum, target, keyFile: f.keyFile }), /Checksum mismatch/)
  const corruption = authenticatedBundle(f, manifest, [contents])
  await assert.rejects(restoreSuiteBackup({ bundle: corruption, target, keyFile: f.keyFile }))
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(join(f.root, 'outside.sqlite')), false)
  assert.equal(readdirSync(f.root).some((name) => name.startsWith('.dco-suite-restore-')), false)
})

test('rejects source and restore symlinks and keeps encryption keys separate', async (t) => {
  const f = fixture(t)
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  const link = join(f.dataRoot, 'inventory', 'media')
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createSuiteBackup(f), /Symbolic links/)
  rmSync(link)
  const created = await createSuiteBackup(f)
  const restoreLink = join(f.root, 'restored-link')
  symlinkSync(outside, restoreLink, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(restoreSuiteBackup({ bundle: created.bundle, target: restoreLink, keyFile: f.keyFile }), /Symbolic links/)
  const unsafeKey = join(f.outputDirectory, 'secret.key')
  writeFileSync(unsafeKey, f.key.toString('base64'))
  await assert.rejects(createSuiteBackup({ ...f, keyFile: unsafeKey }), /separately/)
})

test('retention deletes only old completed suite bundles after a successful backup', async (t) => {
  const f = fixture(t)
  mkdirSync(f.outputDirectory)
  const old = join(f.outputDirectory, 'suite-old.dco-backup')
  const unrelated = join(f.outputDirectory, 'operator-important.txt')
  writeFileSync(old, 'old backup')
  writeFileSync(unrelated, 'must remain')
  const oldDate = new Date(Date.now() - 90 * 86_400_000)
  utimesSync(old, oldDate, oldDate)
  await assert.rejects(createSuiteBackup({ ...f, modules: 'time', retainDays: 30 }), /missing/)
  assert.equal(existsSync(old), true)
  await createSuiteBackup({ ...f, retainDays: 30 })
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(unrelated), true)
})

test('accepts both equals and separated CLI arguments', () => {
  assert.deepEqual(parseArguments(['--data-root=/data', '--output', '/backups', '--modules=inventory']), { 'data-root': '/data', output: '/backups', modules: 'inventory' })
})

test('the CLI defaults to enabled modules plus Core and supports separate-value and equals arguments', async (t) => {
  const f = fixture(t)
  const script = fileURLToPath(new URL('../scripts/backup-suite.mjs', import.meta.url))
  const created = JSON.parse(execFileSync(process.execPath, [script, `--data-root=${f.dataRoot}`, '--output', f.outputDirectory, '--key-file', f.keyFile], { encoding: 'utf8', env: { ...process.env, DCO_ENABLED_MODULES: 'inventory' } }))
  assert.deepEqual(created.modules, ['core', 'inventory'])
  const restoreScript = fileURLToPath(new URL('../scripts/restore-suite.mjs', import.meta.url))
  const target = join(f.root, 'cli-restore')
  const restored = JSON.parse(execFileSync(process.execPath, [restoreScript, `--bundle=${created.bundle}`, '--target', target, `--key-file=${f.keyFile}`], { encoding: 'utf8' }))
  assert.equal(restored.ok, true)
  verifyEntry(join(target, 'inventory', names.inventory), 'inventory committed in WAL')
})
