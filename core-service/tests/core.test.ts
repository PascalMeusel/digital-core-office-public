import assert from 'node:assert/strict'
import { generateKeyPairSync, pbkdf2Sync, scryptSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  authenticate,
  approveQrLoginChallenge,
  canonicalJson,
  claimQrLoginChallenge,
  closeConnection,
  connection,
  createQrLoginChallenge,
  importTimeUsers,
  importInventoryUsers,
  licenseState,
  moduleAccess,
  parseEnabledModules,
  setLicenseKey,
  verifyLicenseKey,
  type LicensePayload,
} from '../server/core.ts'

test('uses one-time QR challenges to transfer an authenticated app identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-core-qr-test-'))
  try {
    process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
    process.env.DCO_INITIAL_ADMIN_NAME = 'QR Admin'
    process.env.DCO_INITIAL_ADMIN_EMAIL = 'qr-admin@example.com'
    process.env.DCO_INITIAL_ADMIN_PASSWORD = 'QR-Admin-Password-2026!'
    closeConnection()

    const challenge = createQrLoginChallenge()
    assert.equal(claimQrLoginChallenge(challenge.token).status, 'pending')
    assert.equal(approveQrLoginChallenge(challenge.token, 'qr-admin@example.com').ok, true)
    const approved = claimQrLoginChallenge(challenge.token)
    assert.equal(approved.status, 'approved')
    assert.equal(approved.status === 'approved' ? approved.user.email : '', 'qr-admin@example.com')
    assert.equal(claimQrLoginChallenge(challenge.token).status, 'invalid')
  } finally {
    closeConnection()
    delete process.env.DCO_CORE_DATA
    delete process.env.DCO_INITIAL_ADMIN_NAME
    delete process.env.DCO_INITIAL_ADMIN_EMAIL
    delete process.env.DCO_INITIAL_ADMIN_PASSWORD
    rmSync(directory, { recursive: true, force: true })
  }
})

test('accepts every non-empty module combination and rejects invalid input', () => {
  const combinations = ['time', 'inventory', 'agile', 'time,inventory', 'time,agile', 'inventory,agile', 'time,inventory,agile']
  for (const combination of combinations) assert.deepEqual(new Set(parseEnabledModules(combination)), new Set(combination.split(',')))
  assert.throws(() => parseEnabledModules(''), /at least one/)
  assert.throws(() => parseEnabledModules('time,finance'), /Unsupported/)
})

test('imports Time users idempotently and preserves password compatibility', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-core-test-'))
  try {
    const sourcePath = join(directory, 'time.sqlite')
    const corePath = join(directory, 'core.sqlite')
    const source = new DatabaseSync(sourcePath)
    source.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, active INTEGER,
      mustChangePassword INTEGER, passwordSalt TEXT, passwordHash TEXT
    )`)
    const salt = 'migration-test-salt'
    const password = 'Existing-Password-2026!'
    const hash = pbkdf2Sync(password, salt, 310_000, 32, 'sha256').toString('hex')
    source.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('existing-user', 'Existing User', 'Existing.User@example.com', 'admin', 1, 0, salt, hash)
    source.close()

    process.env.DCO_CORE_DATA = corePath
    closeConnection()
    const first = importTimeUsers(sourcePath)
    const second = importTimeUsers(sourcePath)
    assert.equal(first.inserted, 1)
    assert.equal(second.updated, 1)
    assert.equal(first.checksum, second.checksum)
    assert.equal(authenticate('existing.user@example.com', password)?.id, 'existing-user')
  } finally {
    closeConnection()
    delete process.env.DCO_CORE_DATA
    rmSync(directory, { recursive: true, force: true })
  }
})

test('imports a decrypted Time userbase and merges an earlier encrypted identity duplicate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-core-json-test-'))
  try {
    const corePath = join(directory, 'core.sqlite')
    const encryptedSourcePath = join(directory, 'encrypted.sqlite')
    const duplicateSourcePath = join(directory, 'duplicate.sqlite')
    const sharedPath = join(directory, 'shared-userbase.json')
    const password = 'Preserved-Password-2026!'
    const salt = 'preserved-time-salt'
    const hash = pbkdf2Sync(password, salt, 310_000, 32, 'sha256').toString('hex')

    const sources: Array<[string, string, string]> = [
      [encryptedSourcePath, 'canonical-time-id', 'enc:v1:not-a-plaintext-email'],
      [duplicateSourcePath, 'supplemental-id', 'person@example.com'],
    ]
    for (const [path, id, email] of sources) {
      const source = new DatabaseSync(path)
      source.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, active INTEGER,
        mustChangePassword INTEGER, passwordSalt TEXT, passwordHash TEXT
      )`)
      source.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'Preserved User', email, 'employee', 1, 0, salt, hash)
      source.close()
    }

    writeFileSync(sharedPath, JSON.stringify({
      version: 1,
      source: 'time-tracking-system',
      users: [{
        id: 'canonical-time-id',
        name: 'Preserved User',
        email: 'person@example.com',
        role: 'employee',
        active: true,
        mustChangePassword: false,
        passwordSalt: salt,
        passwordHash: hash,
        passwordAlgorithm: 'time-pbkdf2-sha256',
      }],
    }))

    process.env.DCO_CORE_DATA = corePath
    closeConnection()
    importTimeUsers(encryptedSourcePath)
    importTimeUsers(duplicateSourcePath)
    connection().prepare("INSERT INTO module_memberships VALUES (?, 'inventory', 'receiver', 1)").run('supplemental-id')
    connection().prepare("INSERT INTO module_import_receipts VALUES (?, 'inventory', ?)").run('supplemental-id', new Date().toISOString())
    const result = importTimeUsers(sharedPath)
    assert.equal(result.updated, 1)
    assert.equal(authenticate('person@example.com', password)?.id, 'canonical-time-id')
    const core = new DatabaseSync(corePath)
    assert.equal((core.prepare('SELECT COUNT(*) count FROM core_users WHERE email = ?').get('person@example.com') as { count: number }).count, 1)
    assert.equal((core.prepare("SELECT role FROM module_memberships WHERE userId=? AND moduleId='inventory'").get('canonical-time-id') as {role:string}).role, 'receiver')
    assert.equal((core.prepare("SELECT COUNT(*) count FROM module_import_receipts WHERE userId=? AND moduleId='inventory'").get('canonical-time-id') as {count:number}).count, 1)
    core.close()
  } finally {
    closeConnection()
    delete process.env.DCO_CORE_DATA
    rmSync(directory, { recursive: true, force: true })
  }
})

test('imports inventory-only users without resetting their scrypt passwords', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-inventory-import-test-'))
  try {
    const sourcePath = join(directory, 'inventory.sqlite')
    const source = new DatabaseSync(sourcePath)
    source.exec(`
      CREATE TABLE inventory_users (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, active INTEGER, mustChangePassword INTEGER);
      CREATE TABLE inventory_user_credentials (userId TEXT PRIMARY KEY, passwordHash TEXT, passwordSalt TEXT, passwordAlgorithm TEXT);
    `)
    const salt = 'inventory-import-salt'
    const password = 'Existing-Inventory-Password-2026!'
    const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')
    source.prepare('INSERT INTO inventory_users VALUES (?, ?, ?, ?, ?, ?)')
      .run('inventory-only', 'Inventory User', 'inventory@example.com', 'buyer', 1, 0)
    source.prepare('INSERT INTO inventory_user_credentials VALUES (?, ?, ?, ?)')
      .run('inventory-only', hash, salt, 'inventory-scrypt-v1')
    source.close()

    process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
    closeConnection()
    assert.equal(importInventoryUsers(sourcePath).inserted, 1)
    assert.equal(authenticate('inventory@example.com', password)?.id, 'inventory-only')
  } finally {
    closeConnection()
    delete process.env.DCO_CORE_DATA
    rmSync(directory, { recursive: true, force: true })
  }
})

test('verifies an unlimited all-module special grant and applies it suite-wide', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-license-test-'))
  try {
    process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    process.env.DCO_LICENSE_PUBLIC_KEY = publicKey.export({ format: 'pem', type: 'spki' }).toString()
    closeConnection()
    const payload: LicensePayload = {
      version: 2,
      licenseId: 'example-company-test',
      holderName: 'ExampleCompany GmbH',
      contactEmail: 'contact@example.test',
      plan: 'special_grant',
      modules: ['*'],
      activeUserLimit: null,
      issuedAt: '2026-09-02T00:00:00.000Z',
      specialTermsRef: 'individual agreement',
    }
    const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url')
    const key = `DCO-${Buffer.from(JSON.stringify({ payload, signature })).toString('base64url')}`
    assert.equal(verifyLicenseKey(key).payload?.licenseId, payload.licenseId)
    const state = setLicenseKey(key, 'test')
    assert.equal(state.valid, true)
    assert.equal(licenseState().details?.activeUserLimit, null)
    assert.equal(moduleAccess('time').allowed, true)
    assert.equal(moduleAccess('inventory').allowed, true)
  } finally {
    closeConnection()
    delete process.env.DCO_CORE_DATA
    delete process.env.DCO_LICENSE_PUBLIC_KEY
    rmSync(directory, { recursive: true, force: true })
  }
})
