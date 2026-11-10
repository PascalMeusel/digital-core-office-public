import {
  createHash,
  createHmac,
  createPublicKey,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const moduleIds = ['time', 'inventory', 'agile'] as const
export type ModuleId = (typeof moduleIds)[number]
export type SuiteRole = 'admin' | 'employee'

export interface CoreUser {
  id: string
  name: string
  email: string
  role: SuiteRole
  active: boolean
  mustChangePassword: boolean
}

export interface EnabledModule {
  id: ModuleId
  label: string
  labelDe: string
  path: string
}

export interface LicensePayload {
  version: 2
  licenseId: string
  holderName: string
  contactEmail: string
  plan: 'paid' | 'free_grant' | 'special_grant'
  modules: ModuleId[] | ['*']
  activeUserLimit: number | null
  issuedAt: string
  validUntil?: string
  specialTermsRef?: string
  notes?: string
}

interface UserRow {
  id: string
  name: string
  email: string
  role: SuiteRole
  active: number
  mustChangePassword: number
  passwordSalt: string
  passwordHash: string
  passwordAlgorithm: string
}

interface SessionRow {
  id: string
  userId: string
  tokenHash: string
  expiresAt: string
}

interface QrLoginChallengeRow {
  id: string
  tokenHash: string
  approvedByUserId?: string
  approvedAt?: string
  expiresAt: string
  usedAt?: string
  createdAt: string
}

interface CountRow { count: number }
interface LicenseRow { licenseKey: string }

const moduleDefinitions: Record<ModuleId, EnabledModule> = {
  time: { id: 'time', label: 'Time Tracking', labelDe: 'Zeiterfassung', path: '/time/' },
  inventory: { id: 'inventory', label: 'Inventory', labelDe: 'Inventar', path: '/inventory/' },
  agile: { id: 'agile', label: 'Agile Projects', labelDe: 'Agile Projekte', path: '/agile/' },
}

const timePasswordAlgorithm = 'time-pbkdf2-sha256'
const corePasswordAlgorithm = 'dco-pbkdf2-sha256-v1'
const inventoryPasswordAlgorithm = 'inventory-scrypt-v1' // gitleaks:allow -- algorithm identifier, not a credential
const agilePasswordAlgorithm = 'agile-scrypt-v1'
const modulePasswordAlgorithms = new Set([inventoryPasswordAlgorithm, agilePasswordAlgorithm])
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const sessionHours = Math.max(1, Number(process.env.DCO_SESSION_TTL_HOURS ?? 12))
const persistentSessionHours = Math.max(sessionHours, Number(process.env.DCO_PERSISTENT_SESSION_TTL_HOURS ?? 720))
const qrLoginTtlSeconds = Math.min(600, Math.max(60, Number(process.env.DCO_QR_LOGIN_TTL_SECONDS ?? 120)))
const freeUserLimit = 10
let database: DatabaseSync | undefined

export function parseEnabledModules(raw = process.env.DCO_ENABLED_MODULES ?? 'time,inventory,agile'): ModuleId[] {
  const values = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (values.length === 0) throw new Error('DCO_ENABLED_MODULES must enable at least one module.')
  const invalid = values.filter((value) => !moduleIds.includes(value as ModuleId))
  if (invalid.length > 0) throw new Error(`Unsupported DCO module(s): ${invalid.join(', ')}.`)
  return values as ModuleId[]
}

export function enabledModules() {
  return parseEnabledModules().map((id) => moduleDefinitions[id])
}

export function moduleAccess(moduleId: string, mode: 'read' | 'write' = 'write') {
  if (!moduleIds.includes(moduleId as ModuleId)) return { allowed: false, reason: 'unknown_module' as const }
  if (!parseEnabledModules().includes(moduleId as ModuleId)) return { allowed: false, reason: 'disabled' as const }
  const state = licenseState()
  if (!state.valid) return { allowed: mode === 'read', readOnly: true, reason: state.status, license: state }
  if (state.status === 'licensed') {
    const scope: readonly string[] = state.details?.modules ?? []
    if (!scope.includes('*') && !scope.includes(moduleId as ModuleId)) {
      return { allowed: mode === 'read', readOnly: true, reason: 'not_licensed' as const, license: state }
    }
  }
  return { allowed: true, readOnly: false, reason: state.status, license: state }
}

export function databasePath() {
  return resolve(process.env.DCO_CORE_DATA ?? resolve('server/data/digital-core-office.sqlite'))
}

export function connection() {
  if (!database) {
    const path = databasePath()
    mkdirSync(dirname(path), { recursive: true })
    database = new DatabaseSync(path)
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    ensureSchema(database)
    bootstrapAdmin(database)
    cleanupExpired(database)
  }
  return database
}

export function closeConnection() {
  database?.close()
  database = undefined
}

function ensureSchema(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS core_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      mustChangePassword INTEGER NOT NULL DEFAULT 0,
      passwordSalt TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      passwordAlgorithm TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS module_memberships (
      userId TEXT NOT NULL,
      moduleId TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (userId, moduleId),
      FOREIGN KEY (userId) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS core_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      usedAt TEXT,
      FOREIGN KEY (userId) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS core_qr_login_challenges (
      id TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      approvedByUserId TEXT,
      approvedAt TEXT,
      expiresAt TEXT NOT NULL,
      usedAt TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (approvedByUserId) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS suite_license (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      licenseKey TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_audit (
      id TEXT PRIMARY KEY,
      actorId TEXT NOT NULL,
      action TEXT NOT NULL,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS module_import_receipts (
      userId TEXT NOT NULL,
      moduleId TEXT NOT NULL,
      importedAt TEXT NOT NULL,
      PRIMARY KEY (userId, moduleId),
      FOREIGN KEY (userId) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_core_sessions_expires ON core_sessions(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_core_qr_login_expires ON core_qr_login_challenges(expiresAt);
  `)
  const columns = sql.prepare('PRAGMA table_info(core_users)').all() as unknown as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'managed')) sql.exec('ALTER TABLE core_users ADD COLUMN managed INTEGER NOT NULL DEFAULT 0')
  sql.exec("UPDATE module_memberships SET role = 'viewer' WHERE moduleId = 'inventory' AND role = 'employee'")
}

function bootstrapAdmin(sql: DatabaseSync) {
  const count = (sql.prepare('SELECT COUNT(*) AS count FROM core_users').get() as unknown as CountRow).count
  if (count > 0) return
  const email = normalizedEmail(process.env.DCO_INITIAL_ADMIN_EMAIL)
  const password = text(process.env.DCO_INITIAL_ADMIN_PASSWORD, 500)
  if (!email || !password) return
  if (password.length < 14 && process.env.DCO_ALLOW_UNSAFE_ADMIN_PASSWORD !== 'true') {
    throw new Error('DCO_INITIAL_ADMIN_PASSWORD must contain at least 14 characters.')
  }
  const now = new Date().toISOString()
  const id = randomUUID()
  const credential = hashPassword(password)
  sql.prepare(`INSERT INTO core_users
    (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt)
    VALUES (?, ?, ?, 'admin', 1, 1, ?, ?, ?, ?, ?)`)
    .run(id, text(process.env.DCO_INITIAL_ADMIN_NAME, 160) || 'Admin', email, credential.salt, credential.hash, corePasswordAlgorithm, now, now)
  upsertMemberships(sql, id, 'admin')
  sql.prepare('UPDATE core_users SET managed = 1 WHERE id = ?').run(id)
}

function cleanupExpired(sql: DatabaseSync) {
  const now = new Date().toISOString()
  sql.prepare('DELETE FROM core_sessions WHERE expiresAt <= ?').run(now)
  sql.prepare('DELETE FROM password_reset_tokens WHERE expiresAt <= ? OR usedAt IS NOT NULL').run(now)
  sql.prepare('DELETE FROM core_qr_login_challenges WHERE expiresAt <= ? OR usedAt IS NOT NULL').run(now)
}

function text(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

export function normalizedEmail(value: unknown) {
  return text(value, 180).toLowerCase()
}

function hashPassword(password: string, salt = randomBytes(24).toString('base64url')) {
  return { salt, hash: pbkdf2Sync(password, salt, 310_000, 32, 'sha256').toString('hex') }
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right)
}

function verifyPassword(password: string, row: UserRow) {
  if (row.passwordAlgorithm === timePasswordAlgorithm) {
    const expected = Buffer.from(row.passwordHash, 'hex')
    const current = pbkdf2Sync(password, row.passwordSalt, 310_000, 32, 'sha256')
    const legacy = pbkdf2Sync(password, row.passwordSalt, 100_000, 32, 'sha256')
    return safeEqual(expected, current) || safeEqual(expected, legacy)
  }
  if (modulePasswordAlgorithms.has(row.passwordAlgorithm)) {
    const expected = Buffer.from(row.passwordHash, 'base64url')
    return safeEqual(expected, scryptSync(password, row.passwordSalt, 64, scryptOptions))
  }
  const expected = Buffer.from(row.passwordHash, 'hex')
  return safeEqual(expected, pbkdf2Sync(password, row.passwordSalt, 310_000, 32, 'sha256'))
}

function publicUser(row: UserRow): CoreUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword),
  }
}

function userRowByEmail(sql: DatabaseSync, email: string) {
  return sql.prepare('SELECT * FROM core_users WHERE email = ?').get(email) as unknown as UserRow | undefined
}

function userRowById(sql: DatabaseSync, id: string) {
  return sql.prepare('SELECT * FROM core_users WHERE id = ?').get(id) as unknown as UserRow | undefined
}

export function authenticate(emailInput: unknown, passwordInput: unknown) {
  const email = normalizedEmail(emailInput)
  const password = typeof passwordInput === 'string' && passwordInput.length <= 500 ? passwordInput : ''
  const row = userRowByEmail(connection(), email)
  if (!row || !row.active || !password || !verifyPassword(password, row)) {
    pbkdf2Sync(password || 'missing', 'dco-missing-user', 100_000, 32, 'sha256')
    return undefined
  }
  connection().prepare('UPDATE core_users SET managed = 1 WHERE id = ?').run(row.id)
  return publicUser(row)
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(userId: string, persistent = false) {
  const sql = connection()
  // Once an account is activated in Core, module snapshots are never authoritative again.
  sql.prepare('UPDATE core_users SET managed = 1 WHERE id = ?').run(userId)
  const token = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + (persistent ? persistentSessionHours : sessionHours) * 3_600_000).toISOString()
  sql.prepare(`INSERT INTO core_sessions (id, userId, tokenHash, expiresAt, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), userId, tokenHash(token), expiresAt, now, now)
  return { token, expiresAt }
}

export function userForSession(token: string) {
  if (!token) return undefined
  const sql = connection()
  const session = sql.prepare('SELECT * FROM core_sessions WHERE tokenHash = ?').get(tokenHash(token)) as unknown as SessionRow | undefined
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return undefined
  const row = userRowById(sql, session.userId)
  if (!row?.active) return undefined
  sql.prepare('UPDATE core_sessions SET lastSeenAt = ? WHERE id = ?').run(new Date().toISOString(), session.id)
  return publicUser(row)
}

export function deleteSession(token: string) {
  connection().prepare('DELETE FROM core_sessions WHERE tokenHash = ?').run(tokenHash(token))
}

export function revokeUserSessions(userId: string) {
  const sql = connection()
  sql.prepare('DELETE FROM core_sessions WHERE userId = ?').run(userId)
  sql.prepare('DELETE FROM password_reset_tokens WHERE userId = ?').run(userId)
  sql.prepare('DELETE FROM core_qr_login_challenges WHERE approvedByUserId = ?').run(userId)
}

export interface ModuleMembership { moduleId: ModuleId; role: string; active: boolean }
const membershipRoles: Record<ModuleId, readonly string[]> = {
  time: ['admin', 'employee'], inventory: ['admin', 'hardware_developer', 'software_developer', 'buyer', 'receiver', 'buyer_receiver', 'stock_manager', 'viewer'], agile: ['admin', 'employee', 'viewer'],
}

export function userMemberships(userId: string): ModuleMembership[] {
  return (connection().prepare('SELECT moduleId, role, active FROM module_memberships WHERE userId = ?').all(userId) as unknown as Array<{ moduleId: ModuleId; role: string; active: number }>)
    .map((row) => ({ ...row, active: Boolean(row.active) }))
}

export function moduleIdentity(user: CoreUser, moduleId: ModuleId) {
  const membership = userMemberships(user.id).find((item) => item.moduleId === moduleId && item.active)
  const access = moduleAccess(moduleId, 'read')
  if (!membership || !access.allowed) return undefined
  return { ...user, moduleRole: membership.role, readOnly: Boolean(access.readOnly) || membership.role === 'viewer' }
}

export function listUsers() {
  return (connection().prepare('SELECT * FROM core_users ORDER BY name, id').all() as unknown as UserRow[])
    .map((row) => ({ ...publicUser(row), memberships: userMemberships(row.id) }))
}

function parseMemberships(input: unknown, role: SuiteRole): ModuleMembership[] {
  if (input === undefined) return moduleIds.map((moduleId) => ({ moduleId, role: role === 'admin' ? 'admin' : moduleId === 'inventory' ? 'viewer' : 'employee', active: parseEnabledModules().includes(moduleId) }))
  if (!Array.isArray(input)) throw new Error('Module permissions must be an array.')
  const seen = new Set<string>()
  return input.map((raw: Record<string, unknown>) => {
    if (!raw || !moduleIds.includes(raw.moduleId as ModuleId) || seen.has(String(raw.moduleId))) throw new Error('Invalid or duplicate module permission.')
    const moduleId = raw.moduleId as ModuleId
    seen.add(moduleId)
    if (!membershipRoles[moduleId].includes(String(raw.role))) throw new Error(`Invalid ${moduleId} role.`)
    if (typeof raw.active !== 'boolean') throw new Error('Module access must be true or false.')
    return { moduleId, role: String(raw.role), active: raw.active }
  })
}

export function saveUser(actorId: string, input: Record<string, unknown>, userId?: string) {
  const sql = connection()
  const existing = userId ? userRowById(sql, userId) : undefined
  if (userId && !existing) throw new Error('User not found.')
  const name = text(input.name ?? existing?.name, 160)
  const email = normalizedEmail(input.email ?? existing?.email)
  const role = input.role ?? existing?.role ?? 'employee'
  const active = input.active ?? Boolean(existing?.active ?? true)
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A name and valid email are required.')
  if (role !== 'admin' && role !== 'employee') throw new Error('Invalid suite role.')
  if (typeof active !== 'boolean') throw new Error('Active must be true or false.')
  if (existing?.role === 'admin' && existing.active && (role !== 'admin' || !active)) {
    const admins = (sql.prepare("SELECT COUNT(*) count FROM core_users WHERE role = 'admin' AND active = 1").get() as unknown as CountRow).count
    if (admins <= 1) throw new Error('Keep at least one active suite administrator.')
  }
  const duplicate = userRowByEmail(sql, email)
  if (duplicate && duplicate.id !== userId) throw new Error('This email is already in use.')
  const memberships = input.memberships === undefined && existing ? userMemberships(existing.id) : parseMemberships(input.memberships, role)
  const password = typeof input.password === 'string' ? input.password : undefined
  if ((!existing || password !== undefined) && (!password || password.length < 14 || password.length > 500)) throw new Error('The temporary password must contain 14 to 500 characters.')
  const credential = password === undefined ? undefined : hashPassword(password)
  const id = existing?.id ?? randomUUID()
  const now = new Date().toISOString()
  sql.exec('BEGIN IMMEDIATE')
  try {
    if (existing) {
      sql.prepare('UPDATE core_users SET name = ?, email = ?, role = ?, active = ?, managed = 1, updatedAt = ? WHERE id = ?').run(name, email, role, active ? 1 : 0, now, id)
      if (credential) sql.prepare('UPDATE core_users SET passwordSalt = ?, passwordHash = ?, passwordAlgorithm = ?, mustChangePassword = 1 WHERE id = ?').run(credential.salt, credential.hash, corePasswordAlgorithm, id)
      revokeUserSessions(id)
    } else {
      sql.prepare(`INSERT INTO core_users (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt, managed)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1)`).run(id, name, email, role, active ? 1 : 0, credential!.salt, credential!.hash, corePasswordAlgorithm, now, now)
    }
    sql.prepare('DELETE FROM module_memberships WHERE userId = ?').run(id)
    for (const membership of memberships) sql.prepare('INSERT INTO module_memberships (userId, moduleId, role, active) VALUES (?, ?, ?, ?)').run(id, membership.moduleId, membership.role, membership.active ? 1 : 0)
    audit(actorId, existing ? 'user_updated' : 'user_created', 'user', id, { role, active, memberships, passwordChanged: Boolean(credential) })
    sql.exec('COMMIT')
  } catch (error) { sql.exec('ROLLBACK'); throw error }
  return { ...publicUser(userRowById(sql, id)!), memberships: userMemberships(id) }
}

export function createQrLoginChallenge() {
  const sql = connection()
  cleanupExpired(sql)
  const token = randomBytes(32).toString('base64url')
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + qrLoginTtlSeconds * 1000).toISOString()
  sql.prepare(`INSERT INTO core_qr_login_challenges
    (id, tokenHash, approvedByUserId, approvedAt, expiresAt, usedAt, createdAt)
    VALUES (?, ?, NULL, NULL, ?, NULL, ?)`)
    .run(randomUUID(), tokenHash(token), expiresAt, createdAt)
  return { token, expiresAt }
}

export function approveQrLoginChallenge(tokenInput: unknown, emailInput: unknown) {
  const token = text(tokenInput, 240)
  const sql = connection()
  cleanupExpired(sql)
  const challenge = sql.prepare(`SELECT * FROM core_qr_login_challenges WHERE tokenHash = ?`)
    .get(tokenHash(token)) as unknown as QrLoginChallengeRow | undefined
  if (!token || !challenge || challenge.usedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    throw new Error('QR sign-in is invalid or expired.')
  }
  const user = userRowByEmail(sql, normalizedEmail(emailInput))
  if (!user?.active) throw new Error('The approving account is not available in Digital Core Office.')
  if (challenge.approvedByUserId && challenge.approvedByUserId !== user.id) {
    throw new Error('This QR sign-in was already approved by another account.')
  }
  const approvedAt = new Date().toISOString()
  sql.prepare(`UPDATE core_qr_login_challenges SET approvedByUserId = ?, approvedAt = ? WHERE id = ?`)
    .run(user.id, approvedAt, challenge.id)
  audit(user.id, 'qr_login_approved', 'qr_login_challenge', challenge.id)
  return { ok: true, expiresAt: challenge.expiresAt }
}

export function claimQrLoginChallenge(tokenInput: unknown) {
  const token = text(tokenInput, 240)
  const sql = connection()
  cleanupExpired(sql)
  const challenge = sql.prepare(`SELECT * FROM core_qr_login_challenges WHERE tokenHash = ?`)
    .get(tokenHash(token)) as unknown as QrLoginChallengeRow | undefined
  if (!token || !challenge || challenge.usedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    return { status: 'invalid' as const }
  }
  if (!challenge.approvedByUserId) {
    return { status: 'pending' as const, expiresAt: challenge.expiresAt }
  }
  const row = userRowById(sql, challenge.approvedByUserId)
  if (!row?.active) return { status: 'invalid' as const }
  const usedAt = new Date().toISOString()
  sql.prepare(`UPDATE core_qr_login_challenges SET usedAt = ? WHERE id = ? AND usedAt IS NULL`).run(usedAt, challenge.id)
  audit(row.id, 'qr_login_claimed', 'qr_login_challenge', challenge.id)
  return { status: 'approved' as const, user: publicUser(row) }
}

export function changePassword(userId: string, currentPassword: unknown, nextPassword: unknown) {
  const password = typeof nextPassword === 'string' ? nextPassword : ''
  if (password.length < 14 || password.length > 500) throw new Error('The new password must contain 14 to 500 characters.')
  const sql = connection()
  const row = userRowById(sql, userId)
  if (!row || typeof currentPassword !== 'string' || currentPassword.length > 500 || !verifyPassword(currentPassword, row)) throw new Error('The current password is incorrect.')
  if (verifyPassword(password, row)) throw new Error('The new password must be different from the current password.')
  const credential = hashPassword(password)
  sql.prepare(`UPDATE core_users SET passwordSalt = ?, passwordHash = ?, passwordAlgorithm = ?, mustChangePassword = 0, updatedAt = ? WHERE id = ?`)
    .run(credential.salt, credential.hash, corePasswordAlgorithm, new Date().toISOString(), userId)
  sql.prepare('UPDATE core_users SET managed = 1 WHERE id = ?').run(userId)
  revokeUserSessions(userId)
  audit(userId, 'password_changed', 'user', userId)
}

export function createPasswordReset(emailInput: unknown) {
  const sql = connection()
  const row = userRowByEmail(sql, normalizedEmail(emailInput))
  if (!row?.active) return undefined
  const token = randomBytes(32).toString('base64url')
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  sql.prepare(`INSERT INTO password_reset_tokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), row.id, tokenHash(token), expiresAt, now)
  return { token, user: publicUser(row), expiresAt }
}

export function completePasswordReset(token: string, passwordInput: unknown) {
  const password = typeof passwordInput === 'string' ? passwordInput : ''
  if (password.length < 14 || password.length > 500) throw new Error('The new password must contain 14 to 500 characters.')
  const sql = connection()
  const reset = sql.prepare(`SELECT * FROM password_reset_tokens WHERE tokenHash = ? AND usedAt IS NULL`).get(tokenHash(token)) as unknown as { id: string; userId: string; expiresAt: string } | undefined
  if (!reset || new Date(reset.expiresAt).getTime() <= Date.now()) throw new Error('The password-reset link is invalid or expired.')
  const user = userRowById(sql, reset.userId)
  if (!user?.active) throw new Error('The password-reset link is invalid or expired.')
  if (verifyPassword(password, user)) throw new Error('The new password must be different from the current password.')
  const credential = hashPassword(password)
  const now = new Date().toISOString()
  sql.exec('BEGIN TRANSACTION')
  try {
    sql.prepare(`UPDATE core_users SET passwordSalt = ?, passwordHash = ?, passwordAlgorithm = ?, mustChangePassword = 0, updatedAt = ? WHERE id = ?`)
      .run(credential.salt, credential.hash, corePasswordAlgorithm, now, reset.userId)
    sql.prepare('UPDATE core_users SET managed = 1 WHERE id = ?').run(reset.userId)
    revokeUserSessions(reset.userId)
    sql.exec('COMMIT')
  } catch (error) {
    sql.exec('ROLLBACK')
    throw error
  }
  audit(reset.userId, 'password_reset_completed', 'user', reset.userId)
  return publicUser(userRowById(sql, reset.userId)!)
}

function upsertMemberships(sql: DatabaseSync, userId: string, role: SuiteRole) {
  const statement = sql.prepare(`INSERT INTO module_memberships (userId, moduleId, role, active) VALUES (?, ?, ?, 1)
    ON CONFLICT(userId, moduleId) DO UPDATE SET role = excluded.role, active = 1`)
  for (const moduleId of moduleIds) statement.run(userId, moduleId, role === 'employee' && moduleId === 'inventory' ? 'viewer' : role)
}

function importModuleMembership(sql: DatabaseSync, userId: string, moduleId: ModuleId, role: string, active: boolean) {
  if (sql.prepare('SELECT 1 FROM module_import_receipts WHERE userId=? AND moduleId=?').get(userId, moduleId)) return false
  sql.prepare(`INSERT INTO module_memberships (userId,moduleId,role,active) VALUES (?,?,?,?)
    ON CONFLICT(userId,moduleId) DO UPDATE SET role=excluded.role, active=excluded.active`).run(userId, moduleId, role, active ? 1 : 0)
  sql.prepare('INSERT INTO module_import_receipts (userId,moduleId,importedAt) VALUES (?,?,?)').run(userId, moduleId, new Date().toISOString())
  return true
}

export function importTimeUsers(sourcePath: string) {
  const resolvedSourcePath = resolve(sourcePath)
  let rows: Array<Omit<UserRow, 'passwordAlgorithm'>>
  if (resolvedSourcePath.toLowerCase().endsWith('.json')) {
    const payload = JSON.parse(readFileSync(resolvedSourcePath, 'utf8')) as {
      version?: unknown
      source?: unknown
      users?: Array<Omit<UserRow, 'passwordAlgorithm'>>
    }
    if (payload.version !== 1 || payload.source !== 'time-tracking-system' || !Array.isArray(payload.users)) {
      throw new Error('Shared Time userbase file is invalid.')
    }
    rows = payload.users
  } else {
    const source = new DatabaseSync(resolvedSourcePath, { readOnly: true })
    rows = source.prepare(`SELECT id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash FROM users ORDER BY id`).all() as unknown as Array<Omit<UserRow, 'passwordAlgorithm'>>
    source.close()
  }
  const sql = connection()
  const now = new Date().toISOString()
  let inserted = 0
  let updated = 0
  sql.exec('BEGIN TRANSACTION')
  try {
    const existingById = sql.prepare('SELECT id, managed FROM core_users WHERE id = ?')
    const existingByEmail = sql.prepare('SELECT id, managed FROM core_users WHERE email = ?')
    const deleteUser = sql.prepare('DELETE FROM core_users WHERE id = ?')
    const upsert = sql.prepare(`INSERT INTO core_users
      (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, role=excluded.role, active=excluded.active,
        mustChangePassword=excluded.mustChangePassword, passwordSalt=excluded.passwordSalt, passwordHash=excluded.passwordHash,
        passwordAlgorithm=excluded.passwordAlgorithm, updatedAt=excluded.updatedAt`)
    for (const row of rows) {
      const email = normalizedEmail(row.email)
      const idMatch = existingById.get(row.id) as { id: string; managed: number } | undefined
      const emailMatch = existingByEmail.get(email) as { id: string; managed: number } | undefined
      if (idMatch?.managed || emailMatch?.managed) continue // Never undo Core password changes or offboarding with a stale module export.
      if (idMatch && emailMatch && idMatch.id !== emailMatch.id) {
        // Supplemental imports can create a plaintext identity while an earlier encrypted
        // Time import occupies the canonical Time id. Repair only identities not yet managed by Core.
        sql.prepare(`INSERT INTO module_memberships (userId,moduleId,role,active)
          SELECT ?,moduleId,role,active FROM module_memberships WHERE userId=?
          ON CONFLICT(userId,moduleId) DO NOTHING`).run(idMatch.id, emailMatch.id)
        sql.prepare(`INSERT INTO module_import_receipts (userId,moduleId,importedAt)
          SELECT ?,moduleId,importedAt FROM module_import_receipts WHERE userId=?
          ON CONFLICT(userId,moduleId) DO NOTHING`).run(idMatch.id, emailMatch.id)
        deleteUser.run(emailMatch.id)
      }
      const targetId = idMatch?.id ?? emailMatch?.id ?? row.id
      upsert.run(targetId, row.name, email, row.role === 'admin' ? 'admin' : 'employee', row.active ? 1 : 0,
        row.mustChangePassword ? 1 : 0, row.passwordSalt, row.passwordHash, timePasswordAlgorithm, now, now)
      importModuleMembership(sql, targetId, 'time', row.role === 'admin' ? 'admin' : 'employee', Boolean(row.active))
      if (idMatch || emailMatch) updated += 1
      else inserted += 1
    }
    sql.exec('COMMIT')
  } catch (error) {
    sql.exec('ROLLBACK')
    throw error
  }
  const checksum = createHash('sha256').update(rows.map((row) => `${row.id}:${normalizedEmail(row.email)}:${row.passwordHash}`).join('\n')).digest('hex')
  audit('migration', 'time_users_imported', 'userbase', sourcePath, { inserted, updated, count: rows.length, checksum })
  return { inserted, updated, count: rows.length, checksum }
}

export function importInventoryUsers(sourcePath: string) {
  return importSupplementalUsers(sourcePath, 'inventory')
}

export function importAgileUsers(sourcePath: string) {
  return importSupplementalUsers(sourcePath, 'agile')
}

function importSupplementalUsers(sourcePath: string, kind: 'inventory' | 'agile') {
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true })
  const rows = (kind === 'inventory'
    ? source.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, u.mustChangePassword,
        c.passwordSalt, c.passwordHash, c.passwordAlgorithm
      FROM inventory_users u LEFT JOIN inventory_user_credentials c ON c.userId = u.id ORDER BY u.id`).all()
    : source.prepare(`SELECT id, name, email, role, active, mustChangePassword,
        passwordSalt, passwordHash, passwordAlgorithm FROM agile_users ORDER BY id`).all()) as unknown as UserRow[]
  source.close()
  const sql = connection()
  const now = new Date().toISOString()
  let inserted = 0
  let existing = 0
  let skipped = 0
  let membershipsImported = 0
  sql.exec('BEGIN TRANSACTION')
  try {
    const insert = sql.prepare(`INSERT INTO core_users
      (id, name, email, role, active, mustChangePassword, passwordSalt, passwordHash, passwordAlgorithm, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of rows) {
      const email = normalizedEmail(row.email)
      const byId = sql.prepare('SELECT id,email,managed FROM core_users WHERE id=?').get(row.id) as {id:string;email:string;managed:number} | undefined
      const byEmail = sql.prepare('SELECT id,email,managed FROM core_users WHERE email=?').get(email) as {id:string;email:string;managed:number} | undefined
      // A module-local ID collision must never link or grant access to another email identity.
      if (byId && byId.email !== email && (!byEmail || byEmail.id !== byId.id)) { skipped += 1; continue }
      const current = byEmail ?? byId
      const importedRole = membershipRoles[kind].includes(row.role) ? row.role : kind === 'inventory' ? 'viewer' : 'employee'
      if (current) {
        if (!current.managed && importModuleMembership(sql, current.id, kind, importedRole, Boolean(row.active))) membershipsImported += 1
        existing += 1
        continue
      }
      if (row.passwordAlgorithm !== timePasswordAlgorithm && !modulePasswordAlgorithms.has(row.passwordAlgorithm)) {
        skipped += 1
        continue
      }
      // Module administrators do not implicitly receive suite-wide account authority.
      const role: SuiteRole = 'employee'
      insert.run(row.id, row.name, email, role, row.active ? 1 : 0, row.mustChangePassword ? 1 : 0,
        row.passwordSalt, row.passwordHash, row.passwordAlgorithm, now, now)
      if (importModuleMembership(sql, row.id, kind, importedRole, Boolean(row.active))) membershipsImported += 1
      inserted += 1
    }
    sql.exec('COMMIT')
  } catch (error) {
    sql.exec('ROLLBACK')
    throw error
  }
  const checksum = createHash('sha256').update(rows.map((row) => `${row.id}:${normalizedEmail(row.email)}:${row.passwordHash}`).join('\n')).digest('hex')
  audit('migration', `${kind}_users_imported`, 'userbase', sourcePath, { inserted, existing, skipped, membershipsImported, count: rows.length, checksum })
  return { inserted, existing, skipped, membershipsImported, count: rows.length, checksum }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`
}

function licensePublicKey() {
  const inline = process.env.DCO_LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n').trim()
  if (inline) return inline
  const path = process.env.DCO_LICENSE_PUBLIC_KEY_FILE
  return path ? readFileSync(path, 'utf8').trim() : undefined
}

export function verifyLicenseKey(licenseKey: string) {
  try {
    const publicKey = licensePublicKey()
    if (!publicKey) return { error: 'No suite license public key is configured.' }
    const normalized = licenseKey.trim().replace(/^DCO-/i, '').replace(/\s+/g, '')
    const envelope = JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8')) as { payload: LicensePayload; signature: string }
    const payload = envelope.payload
    if (payload.version !== 2 || !payload.licenseId || !payload.holderName || !payload.contactEmail) return { error: 'License payload is incomplete.' }
    if (!Array.isArray(payload.modules) || payload.modules.length === 0) return { error: 'License module scope is empty.' }
    if (payload.modules.some((module) => module !== '*' && !moduleIds.includes(module as ModuleId))) return { error: 'License module scope is invalid.' }
    if (!['paid', 'free_grant', 'special_grant'].includes(payload.plan)) return { error: 'License plan is invalid.' }
    if (payload.activeUserLimit !== null && (!Number.isInteger(payload.activeUserLimit) || payload.activeUserLimit < 1)) return { error: 'License user limit is invalid.' }
    if (!Number.isFinite(new Date(payload.issuedAt).getTime())) return { error: 'License issue date is invalid.' }
    if (payload.validUntil && !Number.isFinite(new Date(payload.validUntil).getTime())) return { error: 'License expiry date is invalid.' }
    const valid = verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(publicKey), Buffer.from(envelope.signature, 'base64url'))
    return valid ? { payload } : { error: 'License signature is invalid.' }
  } catch {
    return { error: 'License key cannot be decoded.' }
  }
}

export function setLicenseKey(licenseKey: string, actorId: string) {
  const checked = verifyLicenseKey(licenseKey)
  if (!checked.payload) throw new Error(checked.error)
  connection().prepare(`INSERT INTO suite_license (id, licenseKey, updatedAt, updatedBy) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET licenseKey=excluded.licenseKey, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`)
    .run(licenseKey.trim(), new Date().toISOString(), actorId)
  audit(actorId, 'license_updated', 'license', checked.payload.licenseId)
  return licenseState()
}

export function licenseState() {
  const sql = connection()
  const activeUsers = (sql.prepare('SELECT COUNT(*) AS count FROM core_users u WHERE active = 1 AND EXISTS (SELECT 1 FROM module_memberships m WHERE m.userId = u.id AND m.active = 1)').get() as unknown as CountRow).count
  const row = sql.prepare('SELECT licenseKey FROM suite_license WHERE id = 1').get() as unknown as LicenseRow | undefined
  if (!row) {
    const valid = activeUsers <= freeUserLimit
    return { status: valid ? 'community' : 'over_limit', valid, activeUsers, effectiveUserLimit: freeUserLimit, freeUserLimit }
  }
  const checked = verifyLicenseKey(row.licenseKey)
  if (!checked.payload) return { status: 'invalid', valid: false, activeUsers, effectiveUserLimit: freeUserLimit, freeUserLimit, message: checked.error }
  const payload = checked.payload
  if (payload.validUntil && new Date(payload.validUntil).getTime() < Date.now()) {
    const valid = activeUsers <= freeUserLimit
    return { status: valid ? 'community' : 'expired', valid, activeUsers, effectiveUserLimit: freeUserLimit, freeUserLimit, details: payload }
  }
  const effectiveUserLimit = payload.activeUserLimit ?? Number.MAX_SAFE_INTEGER
  const valid = activeUsers <= effectiveUserLimit
  return { status: valid ? 'licensed' : 'over_limit', valid, activeUsers, effectiveUserLimit, freeUserLimit, details: payload }
}

export function audit(actorId: string, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}) {
  connection().prepare(`INSERT INTO core_audit (id, actorId, action, targetType, targetId, details, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), actorId, action, targetType, targetId, JSON.stringify(details), new Date().toISOString())
}

export function ssoCookieValue(user: CoreUser, persistent: boolean) {
  const secret = process.env.DIGITAL_OFFICE_SSO_SECRET
  if (!secret) throw new Error('DIGITAL_OFFICE_SSO_SECRET is required.')
  const expiresAt = Date.now() + (persistent ? persistentSessionHours : sessionHours) * 3_600_000
  const encoded = Buffer.from(JSON.stringify({ email: user.email.toLowerCase(), stayLoggedIn: persistent, expiresAt })).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `v1.${encoded}.${signature}`
}
