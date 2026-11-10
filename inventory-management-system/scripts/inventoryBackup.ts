import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { gzipSync, gunzipSync } from 'node:zlib'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const magic = Buffer.from('DCOINV1\0')

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function encryptionKey() {
  const keyFile = option('--key-file')
  const encoded = (keyFile ? readFileSync(resolve(keyFile), 'utf8') : process.env.INVENTORY_BACKUP_KEY)?.trim()
  if (!encoded) throw new Error('Provide INVENTORY_BACKUP_KEY or --key-file. Use a base64-encoded 32-byte key.')
  const key = /^[0-9a-f]{64}$/i.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('Inventory backup key must decode to exactly 32 bytes.')
  return key
}

function inside(parent: string, child: string) {
  const root = `${resolve(parent)}${sep}`
  return resolve(child).startsWith(root)
}

function encrypt(payload: Buffer, key: Buffer) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted])
}

function decrypt(payload: Buffer, key: Buffer) {
  if (!payload.subarray(0, magic.length).equals(magic)) throw new Error('Not a Digital Core Office inventory backup.')
  const iv = payload.subarray(magic.length, magic.length + 12)
  const tag = payload.subarray(magic.length + 12, magic.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(payload.subarray(magic.length + 28)), decipher.final()])
}

function assertNoSymlinks(path: string) {
  let current = resolve(path)
  while (true) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Symbolic links are not allowed in backup or restore paths.')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function mediaPayload(mediaDir: string, prefix = ''): Array<{ name: string; data: string }> {
  if (!existsSync(mediaDir)) return []
  assertNoSymlinks(mediaDir)
  return readdirSync(mediaDir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(mediaDir, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot be included in backups.')
    if (entry.isDirectory()) return mediaPayload(path, name)
    if (!entry.isFile()) throw new Error('Unsupported media file type.')
    return [{ name, data: readFileSync(path).toString('base64') }]
  })
}

async function createBackup() {
  const databaseArgument = option('--database') || process.env.INVENTORY_SYSTEM_DATA
  const outputArgument = option('--output-dir')
  if (!databaseArgument || !outputArgument) throw new Error('--database and --output-dir are required.')
  const databasePath = resolve(databaseArgument)
  const outputDir = resolve(outputArgument)
  const mediaDir = resolve(option('--media-dir') || process.env.INVENTORY_MEDIA_DIR || join(dirname(databasePath), 'media'))
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) throw new Error(`Inventory database not found: ${databasePath}`)
  assertNoSymlinks(databasePath)
  assertNoSymlinks(outputDir)
  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const snapshotPath = join(outputDir, `.inventory-${stamp}.sqlite.tmp`)
  const outputPath = join(outputDir, `inventory-${stamp}.dco-backup`)
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try { await backup(source, snapshotPath) } finally { source.close() }
  try {
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    const integrity = String((snapshot.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check)
    snapshot.close()
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`)
    const envelope = Buffer.from(JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      databaseFile: basename(databasePath),
      database: readFileSync(snapshotPath).toString('base64'),
      media: mediaPayload(mediaDir),
    }))
    writeFileSync(outputPath, encrypt(gzipSync(envelope, { level: 9 }), encryptionKey()), { mode: 0o600, flag: 'wx' })
  } finally { if (existsSync(snapshotPath)) rmSync(snapshotPath) }
  const retainDays = Number(option('--retain-days') || '30')
  const cutoff = Date.now() - Math.max(1, retainDays) * 86_400_000
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    const candidate = join(outputDir, entry.name)
    if (entry.isFile() && /^inventory-.*\.dco-backup$/.test(entry.name) && inside(outputDir, candidate) && statSync(candidate).mtimeMs < cutoff) rmSync(candidate)
  }
  console.log(JSON.stringify({ ok: true, backup: outputPath, bytes: statSync(outputPath).size }))
}

function restoreBackup() {
  const inputArgument = option('--input')
  const databaseArgument = option('--database')
  if (!inputArgument || !databaseArgument) throw new Error('--input and --database are required.')
  const inputPath = resolve(inputArgument)
  const databasePath = resolve(databaseArgument)
  const mediaDir = resolve(option('--media-dir') || join(dirname(databasePath), 'media'))
  const targetDirectory = dirname(databasePath)
  if (process.argv.includes('--force')) throw new Error('In-place --force restore is not supported. Restore to a new empty directory.')
  assertNoSymlinks(inputPath)
  assertNoSymlinks(targetDirectory)
  assertNoSymlinks(mediaDir)
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) throw new Error('A valid --input backup file is required.')
  if (existsSync(targetDirectory) && (!statSync(targetDirectory).isDirectory() || readdirSync(targetDirectory).length > 0)) throw new Error('Restore requires a new or empty target directory; existing data is never overwritten.')
  if (!inside(targetDirectory, mediaDir)) throw new Error('Restore media must be inside the new target directory.')
  const envelope = JSON.parse(gunzipSync(decrypt(readFileSync(inputPath), encryptionKey())).toString('utf8')) as { version: number; database: string; media: Array<{ name: string; data: string }> }
  if (envelope.version !== 1 || !envelope.database) throw new Error('Unsupported or incomplete backup.')
  const seenPaths = new Set<string>()
  for (const file of envelope.media ?? []) {
    if (!file.name || file.name.includes('\\') || file.name.includes(':') || file.name.includes('\0') || file.name.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('Unsafe media filename in backup.')
    if (seenPaths.has(file.name.toLowerCase())) throw new Error('Duplicate media filename in backup.')
    seenPaths.add(file.name.toLowerCase())
  }
  const stageParent = dirname(targetDirectory)
  mkdirSync(stageParent, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(stageParent, '.inventory-restore-'))
  try {
    const stagedDatabase = join(stage, basename(databasePath))
    writeFileSync(stagedDatabase, Buffer.from(envelope.database, 'base64'), { mode: 0o600, flag: 'wx' })
    const database = new DatabaseSync(stagedDatabase, { readOnly: true })
    try {
      const results = database.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
      if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('Restored SQLite integrity check failed.')
    } finally { database.close() }
    const stagedMedia = join(stage, relative(targetDirectory, mediaDir))
    mkdirSync(stagedMedia, { recursive: true, mode: 0o700 })
    for (const file of envelope.media ?? []) {
      const target = join(stagedMedia, ...file.name.split('/'))
      if (!inside(stagedMedia, target)) throw new Error('Unsafe media filename in backup.')
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' })
    }
    assertNoSymlinks(targetDirectory)
    if (existsSync(targetDirectory)) {
      if (readdirSync(targetDirectory).length > 0) throw new Error('The restore target is no longer empty.')
      rmdirSync(targetDirectory)
    }
    renameSync(stage, targetDirectory)
  } finally {
    if (existsSync(stage) && inside(stageParent, stage)) rmSync(stage, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ ok: true, database: databasePath, mediaFiles: envelope.media?.length ?? 0 }))
}

if (process.argv.includes('--backup')) await createBackup()
else if (process.argv.includes('--restore')) restoreBackup()
else throw new Error('Choose --backup or --restore.')
