import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { backup, DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false
  try { return moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false }
}

const magic = Buffer.from('DCOSUITE2\0')
const maxManifestBytes = 4 * 1024 * 1024
const databaseNames = { core: 'digital-core-office.sqlite', time: 'time-tracker.sqlite', inventory: 'inventory-system.sqlite', agile: 'agile-project.sqlite' }
const excludedAsset = (name) => /^(?:\.env(?:\..*)?|backups?|configuration|config(?:\..*)?|settings(?:\..*)?|secrets?)$/i.test(name) || /(?:\.(?:sqlite|db)(?:-wal|-shm|-journal)?|\.dco-backup|\.tmp|\.(?:key|pem|p12|pfx))$/i.test(name)

export function parseArguments(arguments_) {
  const result = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arguments_[index])
    if (!match) throw new Error(`Unsupported argument: ${arguments_[index]}`)
    const value = match[2] ?? arguments_[++index]
    if (!value || value.startsWith('--')) throw new Error(`A value is required for --${match[1]}.`)
    if (result[match[1]] !== undefined) throw new Error(`Duplicate option: --${match[1]}`)
    result[match[1]] = value
  }
  return result
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function assertNoSymlinks(path) {
  const absolute = resolve(path)
  let current = absolute
  while (true) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return absolute
}

function encryptionKey(keyFile) {
  if (!keyFile) throw new Error('Provide --key-file or DCO_BACKUP_KEY_FILE with a base64-encoded 32-byte encryption key.')
  const path = assertNoSymlinks(keyFile)
  if (!lstatSync(path).isFile()) throw new Error('The encryption key must be a regular file.')
  const encoded = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(encoded) && !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('The backup key must be a 32-byte key encoded as hex or base64.')
  const key = Buffer.from(encoded, /^[0-9a-f]{64}$/i.test(encoded) ? 'hex' : 'base64')
  if (key.length !== 32) throw new Error('The backup key must decode to exactly 32 bytes.')
  return key
}

function modulesToBackUp(input) {
  const modules = [...new Set(['core', ...(Array.isArray(input) ? input : String(input || '').split(',')).map((name) => name.trim()).filter(Boolean)])]
  if (modules.some((name) => !Object.hasOwn(databaseNames, name))) throw new Error('Modules must be selected from core, time, inventory, and agile.')
  return modules
}

function validateRelativePath(path) {
  if (typeof path !== 'string' || path.length > 2048 || path.includes('\\') || path.includes(':') || path.includes('\0') || path.startsWith('/')) throw new Error('Unsafe path in backup manifest.')
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Unsafe path in backup manifest.')
  return path
}

async function fileDescription(path, archivePath, kind) {
  assertNoSymlinks(path)
  const metadata = lstatSync(path)
  if (!metadata.isFile()) throw new Error(`Expected a regular file: ${path}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  if (size !== metadata.size) throw new Error(`File changed while preparing the backup: ${path}`)
  return { path: validateRelativePath(archivePath), size, sha256: hash.digest('hex'), kind, source: path }
}

async function collectAssets(directory, prefix) {
  const files = []
  assertNoSymlinks(directory)
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (excludedAsset(entry.name)) continue
    const path = join(directory, entry.name)
    const archivePath = `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be included in backups: ${path}`)
    if (entry.isDirectory()) files.push(...await collectAssets(path, archivePath))
    else if (entry.isFile()) files.push(await fileDescription(path, archivePath, 'asset'))
    else throw new Error(`Unsupported file type in module data: ${path}`)
  }
  return files
}

function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = database.prepare('PRAGMA integrity_check').all()
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${path}`)
  } finally { database.close() }
}

function removePrivateStage(parent, stage) {
  if (!isInside(parent, stage) || resolve(parent) === resolve(stage)) throw new Error('Refusing to remove a path outside the private staging directory.')
  rmSync(stage, { recursive: true, force: true })
}

async function* archiveChunks(manifest, files) {
  const encoded = Buffer.from(JSON.stringify(manifest))
  if (encoded.length > maxManifestBytes) throw new Error('Backup manifest exceeds the supported size.')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(encoded.length)
  yield length
  yield encoded
  for (const file of files) {
    assertNoSymlinks(file.source)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(file.source, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) })) {
      hash.update(chunk)
      size += chunk.length
      yield chunk
    }
    if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`File changed while writing the backup: ${file.path}`)
  }
}

export async function createSuiteBackup({ dataRoot = '/data', outputDirectory, modules, keyFile, configFile, retainDays } = {}) {
  if (!outputDirectory) throw new Error('--output is required.')
  const root = assertNoSymlinks(dataRoot)
  const output = assertNoSymlinks(outputDirectory)
  if (isInside(root, output)) throw new Error('Store backups outside the application data directory.')
  const key = encryptionKey(keyFile)
  if (isInside(root, keyFile) || isInside(output, keyFile)) throw new Error('Store the encryption key separately from application data and backups.')
  const selected = modulesToBackUp(modules)
  const retention = retainDays === undefined ? undefined : Number(retainDays)
  if (retention !== undefined && (!Number.isFinite(retention) || retention < 1)) throw new Error('--retain-days must be at least 1.')
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const temporary = mkdtempSync(join(tmpdir(), 'dco-suite-backup-'))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bundle = join(output, `suite-${stamp}-${randomUUID().slice(0, 8)}.dco-backup`)
  const partial = `${bundle}.tmp`
  try {
    const files = []
    for (const module of selected) {
      const sourceDirectory = assertNoSymlinks(join(root, module))
      const sourcePath = assertNoSymlinks(join(sourceDirectory, databaseNames[module]))
      if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error(`Enabled module database is missing: ${sourcePath}`)
      const snapshotPath = join(temporary, `${module}.sqlite`)
      const source = new DatabaseSync(sourcePath, { readOnly: true })
      try { await backup(source, snapshotPath) } finally { source.close() }
      verifyDatabase(snapshotPath)
      files.push(await fileDescription(snapshotPath, `${module}/${databaseNames[module]}`, 'sqlite'))
      files.push(...await collectAssets(sourceDirectory, module))
    }
    if (configFile) files.push(await fileDescription(assertNoSymlinks(configFile), 'configuration/operator-config', 'config'))
    const manifest = { format: 'digital-core-office-suite', version: 2, createdAt: new Date().toISOString(), modules: selected, consistency: 'Online consistent snapshot of each SQLite database; independent module snapshots.', configIncluded: Boolean(configFile), files: files.map(({ source: _source, ...file }) => file) }
    validateManifest(manifest)
    const iv = randomBytes(12)
    const header = Buffer.concat([magic, iv])
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(header)
    writeFileSync(partial, header, { flag: 'wx', mode: 0o600 })
    await pipeline(Readable.from(archiveChunks(manifest, files)), createGzip(), cipher, createWriteStream(partial, { flags: 'a', mode: 0o600 }))
    const handle = await open(partial, 'a')
    try { await handle.writeFile(cipher.getAuthTag()); await handle.sync() } finally { await handle.close() }
    renameSync(partial, bundle)
    if (retention !== undefined) {
      const cutoff = Date.now() - retention * 86_400_000
      for (const entry of readdirSync(output, { withFileTypes: true })) {
        const candidate = join(output, entry.name)
        if (entry.isFile() && /^suite-.*\.dco-backup$/.test(entry.name) && candidate !== bundle && lstatSync(candidate).mtimeMs < cutoff) rmSync(candidate)
      }
    }
    return { ok: true, bundle, bytes: statSync(bundle).size, modules: selected, files: files.length, configIncluded: Boolean(configFile) }
  } finally {
    if (existsSync(partial)) rmSync(partial)
    removePrivateStage(tmpdir(), temporary)
  }
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== 'digital-core-office-suite' || manifest.version !== 2 || !Array.isArray(manifest.modules) || !Array.isArray(manifest.files)) throw new Error('Unsupported suite backup manifest.')
  const modules = modulesToBackUp(manifest.modules)
  if (modules.length !== manifest.modules.length || !manifest.modules.includes('core')) throw new Error('Invalid module list in backup manifest.')
  const paths = new Set()
  for (const file of manifest.files) {
    validateRelativePath(file.path)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) || !['sqlite', 'asset', 'config'].includes(file.kind)) throw new Error('Invalid file metadata in backup manifest.')
    const [module] = file.path.split('/')
    if (file.kind === 'config' ? file.path !== 'configuration/operator-config' : !modules.includes(module)) throw new Error('Unexpected destination in backup manifest.')
    if (file.kind === 'sqlite' && file.path !== `${module}/${databaseNames[module]}`) throw new Error('Unexpected database destination in backup manifest.')
    if (paths.has(file.path.toLowerCase())) throw new Error('Duplicate destination in backup manifest.')
    paths.add(file.path.toLowerCase())
  }
  for (const module of modules) {
    if (!manifest.files.some((file) => file.kind === 'sqlite' && file.path === `${module}/${databaseNames[module]}`)) throw new Error(`Backup is missing the ${module} database.`)
  }
}

class ArchiveReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0) }
  async *take(size) {
    while (size > 0) {
      if (this.buffer.length === 0) {
        const next = await this.iterator.next()
        if (next.done) throw new Error('Truncated suite backup payload.')
        this.buffer = next.value
      }
      const length = Math.min(size, this.buffer.length)
      yield this.buffer.subarray(0, length)
      this.buffer = this.buffer.subarray(length)
      size -= length
    }
  }
  async read(size) { const chunks = []; for await (const chunk of this.take(size)) chunks.push(chunk); return Buffer.concat(chunks) }
  async finish() {
    if (this.buffer.length || !(await this.iterator.next()).done) throw new Error('Unexpected trailing data in suite backup.')
  }
}

function assertEmptyTarget(target) {
  assertNoSymlinks(target)
  if (existsSync(target) && (!lstatSync(target).isDirectory() || readdirSync(target).length > 0)) throw new Error('Restore requires a new or empty target directory; existing application data is never overwritten.')
}

export async function restoreSuiteBackup({ bundle, target, keyFile } = {}) {
  if (!bundle || !target) throw new Error('--bundle and --target are required.')
  const input = assertNoSymlinks(bundle)
  const destination = assertNoSymlinks(target)
  assertEmptyTarget(destination)
  const key = encryptionKey(keyFile)
  const metadata = lstatSync(input)
  const headerLength = magic.length + 12
  if (!metadata.isFile() || metadata.size <= headerLength + 16) throw new Error('Invalid suite backup file.')
  const inputHandle = await open(input, 'r')
  const header = Buffer.alloc(headerLength)
  const tag = Buffer.alloc(16)
  try { await inputHandle.read(header, 0, header.length, 0); await inputHandle.read(tag, 0, tag.length, metadata.size - tag.length) } finally { await inputHandle.close() }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Not a supported Digital Core Office suite backup.')
  const parent = dirname(destination)
  assertNoSymlinks(parent)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(parent, '.dco-suite-restore-'))
  try {
    const compressed = join(stage, '.authenticated-payload.gz')
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length))
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    await pipeline(createReadStream(input, { start: headerLength, end: metadata.size - 17 }), decipher, createWriteStream(compressed, { flags: 'wx', mode: 0o600 }))
    const decompressed = createReadStream(compressed).compose(createGunzip())
    const reader = new ArchiveReader(decompressed)
    let manifest
    try {
      const manifestLength = (await reader.read(4)).readUInt32BE()
      if (manifestLength > maxManifestBytes) throw new Error('Backup manifest exceeds the supported size.')
      manifest = JSON.parse((await reader.read(manifestLength)).toString('utf8'))
      validateManifest(manifest)
      for (const file of manifest.files) {
        const output = join(stage, ...file.path.split('/'))
        if (!isInside(stage, output)) throw new Error('Unsafe restore destination.')
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
        const hash = createHash('sha256')
        async function* contents() { for await (const chunk of reader.take(file.size)) { hash.update(chunk); yield chunk } }
        await pipeline(Readable.from(contents()), createWriteStream(output, { flags: 'wx', mode: 0o600 }))
        if (hash.digest('hex') !== file.sha256) throw new Error(`Checksum mismatch while restoring ${file.path}.`)
        if (file.kind === 'sqlite') verifyDatabase(output)
      }
      await reader.finish()
    } finally { decompressed.destroy(); await finished(decompressed).catch(() => {}) }
    rmSync(compressed)
    writeFileSync(join(stage, 'restore-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    assertEmptyTarget(destination)
    if (existsSync(destination)) rmdirSync(destination)
    renameSync(stage, destination)
    return { ok: true, target: destination, modules: manifest.modules, files: manifest.files.length, configIncluded: manifest.configIncluded === true, requiredSeparately: ['Application configuration and application data-encryption keys must be restored securely before services start.'] }
  } finally { if (existsSync(stage)) removePrivateStage(parent, stage) }
}
