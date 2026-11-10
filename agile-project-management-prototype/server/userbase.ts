import { createHash, pbkdf2Sync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export type AgileUserRole = 'admin' | 'employee'

export interface AgileUser {
  id: string
  name: string
  email: string
  role: AgileUserRole
  active: boolean
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
}

export interface SharedUserbaseUser {
  id: string
  name: string
  email: string
  role: string
  active: boolean
  mustChangePassword: boolean
  passwordSalt: string
  passwordHash: string
  passwordAlgorithm: string
}

interface AgileUserRow {
  id: string
  name: string
  email: string
  role: AgileUserRole
  active: number
  mustChangePassword: number
  passwordSalt: string
  passwordHash: string
  passwordAlgorithm: string
  createdAt: string
  updatedAt: string
}

interface AgileSessionRow {
  id: string
  userId: string
  tokenHash: string
  expiresAt: string
  createdAt: string
  lastSeenAt: string
}

interface CountRow {
  count: number
}

interface TableInfoRow {
  name: string
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultDataPath = join(moduleDir, 'data', 'agile-project.sqlite')
const dataPath = process.env.AGILE_PROJECT_DATA ?? defaultDataPath
const localPasswordAlgorithm = 'agile-scrypt-v1'
const timePasswordAlgorithm = 'time-pbkdf2-sha256'
const scryptKeyLength = 64
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const sessionDurationMs = 12 * 60 * 60 * 1000
const persistentSessionDurationMs = 30 * 24 * 60 * 60 * 1000
let agileConnection: DatabaseSync | undefined

export function agileDataFilePath() {
  return dataPath
}

export function connection() {
  if (!agileConnection) {
    mkdirSync(dirname(dataPath), { recursive: true })
    agileConnection = new DatabaseSync(dataPath)
    agileConnection.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`)
    ensureSchema(agileConnection)
    ensureBootstrapAdminFromEnv(agileConnection)
    cleanupExpiredSessions(agileConnection)
  }

  return agileConnection
}

function ensureSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agile_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      mustChangePassword INTEGER NOT NULL DEFAULT 0,
      passwordSalt TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      passwordAlgorithm TEXT NOT NULL DEFAULT '${localPasswordAlgorithm}',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agile_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES agile_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agile_sessions_user ON agile_sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_agile_sessions_expires ON agile_sessions(expiresAt);
  `)
  ensurePasswordAlgorithmColumn(database)
  const columns = new Set((database.prepare('PRAGMA table_info(agile_users)').all() as unknown as TableInfoRow[]).map(column => column.name))
  if (!columns.has('coreUserId')) database.exec('ALTER TABLE agile_users ADD COLUMN coreUserId TEXT;')
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agile_core_user ON agile_users(coreUserId) WHERE coreUserId IS NOT NULL;')
}

function ensurePasswordAlgorithmColumn(database: DatabaseSync) {
  const columns = new Set((database.prepare(`PRAGMA table_info(agile_users)`).all() as unknown as TableInfoRow[]).map((column) => column.name))
  if (!columns.has('passwordAlgorithm')) {
    database.exec(`ALTER TABLE agile_users ADD COLUMN passwordAlgorithm TEXT NOT NULL DEFAULT '${localPasswordAlgorithm}';`)
  }
}

function ensureBootstrapAdminFromEnv(database: DatabaseSync) {
  const password = process.env.AGILE_INITIAL_ADMIN_PASSWORD
  if (!password || tableCount(database, 'agile_users') > 0) {
    return
  }

  const now = nowIso()
  const email = parseText(process.env.AGILE_INITIAL_ADMIN_EMAIL, 180).toLowerCase() || 'admin@agile.local'
  const name = parseText(process.env.AGILE_INITIAL_ADMIN_NAME, 160) || 'Admin'
  const mustChangePassword = process.env.AGILE_INITIAL_ADMIN_MUST_CHANGE_PASSWORD !== 'false'
  const { hash, salt } = hashScryptPassword(password)
  database
    .prepare(
      `INSERT INTO agile_users
       (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run('agile-user-admin', name, email, 'admin', mustChangePassword ? 1 : 0, salt, hash, localPasswordAlgorithm, now, now)
}

function tableCount(database: DatabaseSync, table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count
}

function nowIso() {
  return new Date().toISOString()
}

function parseText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizedEmail(value: unknown) {
  return parseText(value, 180).toLowerCase()
}

function rowToUser(row: AgileUserRow): AgileUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function userByEmail(database: DatabaseSync, email: string) {
  const row = database.prepare(`SELECT * FROM agile_users WHERE email = ?`).get(email) as unknown as AgileUserRow | undefined
  return row ? rowToUser(row) : undefined
}

export function userByEmailAddress(emailInput: string) {
  const email = normalizedEmail(emailInput)
  if (!email) return undefined
  const user = userByEmail(connection(), email)
  return user?.active ? user : undefined
}

/** Core verifies access on every request; this row stores only the local profile. */
export function upsertCoreProfile(identity: { id: string; name: string; email: string; moduleRole: string; mustChangePassword: boolean }) {
  const database = connection()
  const email = normalizedEmail(identity.email)
  const role = identity.moduleRole === 'admin' ? 'admin' : 'employee'
  const now = nowIso()
  database.exec('BEGIN IMMEDIATE')
  try {
    const linked = database.prepare('SELECT * FROM agile_users WHERE coreUserId=?').get(identity.id) as unknown as (AgileUserRow & {coreUserId?: string}) | undefined
    const emailMatch = database.prepare('SELECT * FROM agile_users WHERE email=?').get(email) as unknown as (AgileUserRow & {coreUserId?: string}) | undefined
    // Email is a mutable cache key. Never transfer a previous Core identity's local authorship.
    if (emailMatch && emailMatch.id !== linked?.id && (linked || emailMatch.coreUserId) && emailMatch.coreUserId !== identity.id) {
      database.prepare('UPDATE agile_users SET email=?, active=0, updatedAt=? WHERE id=?')
        .run(`core-cache-${randomUUID()}@invalid`, now, emailMatch.id)
    }
    const existing = linked ?? (emailMatch && !emailMatch.coreUserId ? emailMatch : undefined)
    const id = existing?.id ?? (userById(database, identity.id) ? randomUUID() : identity.id)
    if (existing) {
      database.prepare('UPDATE agile_users SET coreUserId=?, name=?, email=?, role=?, active=1, mustChangePassword=?, updatedAt=? WHERE id=?')
        .run(identity.id, identity.name, email, role, identity.mustChangePassword ? 1 : 0, now, id)
    } else {
      database.prepare(`INSERT INTO agile_users (id,coreUserId,name,email,role,active,mustChangePassword,passwordSalt,passwordHash,passwordAlgorithm,createdAt,updatedAt)
        VALUES (?,?,?,?,?,1,?,?,?,'core-managed-disabled',?,?)`)
        .run(id, identity.id, identity.name, email, role, identity.mustChangePassword ? 1 : 0, randomBytes(24).toString('base64url'), randomBytes(64).toString('base64url'), now, now)
    }
    database.exec('COMMIT')
    return userById(database, id)!
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function userById(database: DatabaseSync, id: string) {
  const row = database.prepare(`SELECT * FROM agile_users WHERE id = ?`).get(id) as unknown as AgileUserRow | undefined
  return row ? rowToUser(row) : undefined
}

function credentialByEmail(database: DatabaseSync, email: string) {
  return database.prepare(`SELECT * FROM agile_users WHERE email = ?`).get(email) as unknown as AgileUserRow | undefined
}

function hashScryptPassword(password: string, salt = randomBytes(24).toString('base64url')) {
  const hash = scryptSync(password, salt, scryptKeyLength, scryptOptions).toString('base64url')
  return { hash, salt }
}

function safeCompare(expected: Buffer, actual: Buffer) {
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function verifyTimePassword(password: string, salt: string, hash: string) {
  const expected = Buffer.from(hash, 'hex')
  const current = pbkdf2Sync(password, salt, 310_000, 32, 'sha256')
  const legacy = pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
  return safeCompare(expected, current) || safeCompare(expected, legacy)
}

function verifyScryptPassword(password: string, salt: string, hash: string) {
  const expected = Buffer.from(hash, 'base64url')
  const actual = Buffer.from(hashScryptPassword(password, salt).hash, 'base64url')
  return safeCompare(expected, actual)
}

function verifyPassword(password: string, row: AgileUserRow) {
  if (row.passwordAlgorithm === timePasswordAlgorithm) {
    return verifyTimePassword(password, row.passwordSalt, row.passwordHash)
  }
  return verifyScryptPassword(password, row.passwordSalt, row.passwordHash)
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function cleanupExpiredSessions(database: DatabaseSync) {
  database.prepare(`DELETE FROM agile_sessions WHERE expiresAt <= ?`).run(nowIso())
}

export function createSession(userId: string, stayLoggedIn = false) {
  const database = connection()
  const token = randomBytes(32).toString('base64url')
  const now = nowIso()
  const expiresAt = new Date(Date.now() + (stayLoggedIn ? persistentSessionDurationMs : sessionDurationMs)).toISOString()
  database
    .prepare(`INSERT INTO agile_sessions (id, userId, tokenHash, expiresAt, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), userId, hashToken(token), expiresAt, now, now)
  return { token, expiresAt }
}

export function userFromSessionToken(token: string) {
  if (!token) {
    return undefined
  }

  const database = connection()
  const session = database
    .prepare(`SELECT * FROM agile_sessions WHERE tokenHash = ?`)
    .get(hashToken(token)) as unknown as AgileSessionRow | undefined
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    if (session) {
      database.prepare(`DELETE FROM agile_sessions WHERE id = ?`).run(session.id)
    }
    return undefined
  }

  database.prepare(`UPDATE agile_sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?`).run(
    nowIso(),
    new Date(Date.now() + sessionDurationMs).toISOString(),
    session.id,
  )
  const user = userById(database, session.userId)
  return user?.active ? user : undefined
}

export function deleteSession(token: string) {
  if (token) {
    connection().prepare(`DELETE FROM agile_sessions WHERE tokenHash = ?`).run(hashToken(token))
  }
}

export function authenticate(emailInput: string, password: string) {
  const email = normalizedEmail(emailInput)
  if (!email || !password) {
    return undefined
  }

  const database = connection()
  const row = credentialByEmail(database, email)
  if (!row || !row.active || !verifyPassword(password, row)) {
    hashScryptPassword(password || 'missing-password')
    return undefined
  }
  return rowToUser(row)
}

export function importSharedUserbase(users: SharedUserbaseUser[]) {
  const database = connection()
  const now = nowIso()
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const source of users) {
    const email = normalizedEmail(source.email)
    const name = parseText(source.name, 160)
    const passwordAlgorithm = parseText(source.passwordAlgorithm, 80)
    const role: AgileUserRole = source.role === 'admin' ? 'admin' : 'employee'

    if (!source.id || !email || !name || !source.passwordHash || !source.passwordSalt || passwordAlgorithm !== timePasswordAlgorithm) {
      skipped += 1
      continue
    }

    const existing = userByEmail(database, email)
    const userId = existing?.id ?? source.id
    if (existing) {
      database
        .prepare(
          `UPDATE agile_users
           SET name = ?, role = ?, active = ?, mustChangePassword = ?, passwordSalt = ?, passwordHash = ?, passwordAlgorithm = ?, updatedAt = ?
           WHERE id = ?`,
        )
        .run(name, role, source.active ? 1 : 0, source.mustChangePassword ? 1 : 0, source.passwordSalt, source.passwordHash, passwordAlgorithm, now, userId)
      updated += 1
    } else {
      database
        .prepare(
          `INSERT INTO agile_users
           (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, name, email, role, source.active ? 1 : 0, source.mustChangePassword ? 1 : 0, source.passwordSalt, source.passwordHash, passwordAlgorithm, now, now)
      inserted += 1
    }
  }

  return { inserted, updated, skipped }
}
