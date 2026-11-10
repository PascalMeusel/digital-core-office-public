import './timezone.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { dateKeysBetween, toDateKey } from '../shared/dates.ts'
import type {
  AbsenceDay,
  BackupInfo,
  CalDavAccount,
  CalDavSyncStatus,
  CalendarGroup,
  CustomCalendarEvent,
  EmploymentTerm,
  ExternalCalendarEvent,
  HolidayOverride,
  HolidaySettings,
  ImportBatch,
  MailServerSettings,
  NotificationItem,
  RequestItem,
  Role,
  TimeEntry,
  User,
  UserInvitation,
} from '../shared/domain.ts'
import { currentEmploymentTerm, employmentTermsFor } from '../shared/terms.ts'
import { decryptRequiredText, decryptText, encryptText } from './fieldCrypto.ts'
import { defaultHolidaySettings, normalizeHolidaySettings } from './holidays.ts'

export interface StoredUser extends User {
  coreUserId?: string
  passwordSalt: string
  passwordHash: string
}

export interface AuditEvent {
  id: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  details: Record<string, unknown>
  createdAt: string
}

export interface EmailOutboxItem {
  id: string
  to: string[]
  subject: string
  text: string
  status: 'queued' | 'sent' | 'console'
  createdAt: string
}

export interface StoredUserInvitation extends UserInvitation {
  tokenHash: string
}

export interface StoredPasswordResetToken {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

export interface StoredMailServerSettings extends MailServerSettings {
  password: string
}

export interface StoredCalDavAccount extends CalDavAccount {
  password: string
}

export interface StoredLicenseSettings {
  licenseKey: string
  updatedAt: string
  updatedBy: string
}

export interface Database {
  users: StoredUser[]
  timeEntries: TimeEntry[]
  absences: AbsenceDay[]
  requests: RequestItem[]
  holidayOverrides: HolidayOverride[]
  calendarGroups: CalendarGroup[]
  calDavAccounts: StoredCalDavAccount[]
  externalCalendarEvents: ExternalCalendarEvent[]
  customCalendarEvents: CustomCalendarEvent[]
  notifications: NotificationItem[]
  importBatches: ImportBatch[]
  audit: AuditEvent[]
  emailOutbox: EmailOutboxItem[]
  userInvitations: StoredUserInvitation[]
  passwordResetTokens: StoredPasswordResetToken[]
  holidaySettings: HolidaySettings
  mailServerSettings?: StoredMailServerSettings
  licenseSettings?: StoredLicenseSettings
}

interface CountRow {
  count: number
}

interface IdRow {
  id: string
}

interface UserRow {
  coreUserId: string | null
  id: string
  name: string
  email: string
  role: Role
  expectedWeeklyMinutes: number
  yearlyVacationDays: number
  employmentTerms: string | null
  balanceAdjustmentMinutes: number | null
  vacationAdjustmentDays: number | null
  trackingStartDate: string | null
  calendarAccessUserIds: string
  responsibleAdminUserId: string | null
  active: number
  mustChangePassword: number | null
  passwordSalt: string
  passwordHash: string
}

interface TimeEntryRow {
  id: string
  userId: string
  date: string
  startedAt: string
  stoppedAt: string | null
  breaks: string
  manualBreakMinutes: number | null
  workLocation: TimeEntry['workLocation'] | null
  source: TimeEntry['source']
  note: string | null
  requestId: string | null
  importBatchId: string | null
  createdAt: string
  updatedAt: string
}

interface AbsenceRow {
  id: string
  userId: string
  date: string
  type: AbsenceDay['type']
  requestId: string | null
  label: string
  createdAt: string
}

interface RequestRow {
  id: string
  userId: string
  type: RequestItem['type']
  status: RequestItem['status']
  startDate: string | null
  endDate: string | null
  minutes: number | null
  balanceEffects: string | null
  correctionDate: string | null
  proposedStartTime: string | null
  proposedEndTime: string | null
  proposedBreakMinutes: number | null
  customTitle: string | null
  doctorNoteName: string | null
  doctorNoteDataUrl: string | null
  reason: string
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  adminNote: string | null
  undoneAt: string | null
  undoneBy: string | null
}

interface HolidayOverrideRow {
  id: string
  date: string
  name: string
  type: HolidayOverride['type']
  freePercent: number | null
  createdBy: string
  createdAt: string
}

interface CalendarGroupRow {
  id: string
  name: string
  memberUserIds: string
  createdAt: string
}

interface CalDavAccountRow {
  id: string
  userId: string
  name: string
  serverUrl: string
  username: string
  password: string
  calendarUrl: string | null
  calendarName: string | null
  shareEventTitles: number
  syncEnabled: number
  lastSyncAt: string | null
  lastSyncStatus: CalDavSyncStatus | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

interface ExternalCalendarEventRow {
  id: string
  userId: string
  accountId: string
  externalId: string
  title: string
  startAt: string
  endAt: string
  isAllDay: number
  busy: number
  createdAt: string
  updatedAt: string
}

interface CustomCalendarEventRow {
  id: string
  userId: string
  title: string
  description: string | null
  date: string
  startTime: string | null
  endTime: string | null
  isAllDay: number
  shareWithCalendarUsers: number
  createdAt: string
  updatedAt: string
}

interface NotificationRow {
  id: string
  userId: string
  title: string
  message: string
  read: number
  createdAt: string
  linkType: NotificationItem['linkType'] | null
  linkId: string | null
}

interface ImportBatchRow {
  id: string
  userId: string
  importedBy: string
  fileName: string
  importedRows: number
  skippedRows: number
  errors: string
  createdAt: string
}

interface MailServerSettingsRow {
  id: string
  host: string
  port: number
  secure: number
  smtpUser: string
  password: string
  fromAddress: string
  updatedAt: string
  updatedBy: string
}

interface LicenseSettingsRow {
  id: string
  licenseKey: string
  updatedAt: string
  updatedBy: string
}

interface HolidaySettingsRow {
  id: string
  country: string
  state: string | null
  region: string | null
  language: string
  updatedAt: string | null
  updatedBy: string | null
}

interface AuditRow {
  id: string
  actorId: string
  action: string
  targetType: string
  targetId: string
  details: string
  createdAt: string
}

interface EmailOutboxRow {
  id: string
  recipients: string
  subject: string
  text: string
  status: EmailOutboxItem['status']
  createdAt: string
}

interface UserInvitationRow {
  id: string
  userId: string
  email: string
  role: Role
  tokenHash: string
  createdBy: string
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
}

interface PasswordResetTokenRow {
  id: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultDataPath = join(moduleDir, 'data', 'time-tracker.sqlite')
const legacyJsonPath = join(moduleDir, 'data', 'time-tracker.json')
const dataPath = process.env.TIME_TRACKER_DATA ?? defaultDataPath
const backupDir = process.env.TIME_TRACKER_BACKUP_DIR ?? join(moduleDir, 'backups')
let connection: DatabaseSync | undefined
export const inactiveTrackingStartDate = '9999-12-31'

export function nowIso() {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  const decoded = decryptText(value)
  if (!decoded) {
    return fallback
  }

  try {
    return JSON.parse(decoded) as T
  } catch {
    return fallback
  }
}

function initialEmploymentTerm(expectedWeeklyMinutes: number, yearlyVacationDays: number, effectiveFrom = toDateKey(new Date())): EmploymentTerm {
  return {
    id: randomUUID(),
    effectiveFrom,
    expectedWeeklyMinutes,
    yearlyVacationDays,
    createdAt: nowIso(),
  }
}

function normalizeStoredUserTerms(user: StoredUser): StoredUser {
  const employmentTerms = employmentTermsFor(user)
  const currentTerm = currentEmploymentTerm({ ...user, employmentTerms })
  return {
    ...user,
    employmentTerms,
    expectedWeeklyMinutes: currentTerm.expectedWeeklyMinutes,
    yearlyVacationDays: currentTerm.yearlyVacationDays,
  }
}

export function publicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, coreUserId: _coreUserId, ...safeUser } = user
  return safeUser
}

export function passwordPolicyErrors(password: string, email = '', name = '') {
  const errors: string[] = []
  const lowerPassword = password.toLowerCase()
  const emailName = email.split('@')[0]?.toLowerCase() ?? ''
  const nameParts = name.toLowerCase().split(/\s+/).filter(Boolean)
  const weakFragments = ['password', 'passwort', 'zeitguru', 'admin', 'employee', 'welcome', 'qwerty', '123456']

  if (password.length < 12) errors.push('Use at least 12 characters.')
  if (!/[a-z]/.test(password)) errors.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) errors.push('Add an uppercase letter.')
  if (!/\d/.test(password)) errors.push('Add a number.')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Add a symbol.')
  if (emailName && lowerPassword.includes(emailName)) errors.push('Do not include your email name.')
  if (nameParts.some((part) => part.length >= 3 && lowerPassword.includes(part))) {
    errors.push('Do not include your name.')
  }
  if (weakFragments.some((fragment) => lowerPassword.includes(fragment))) {
    errors.push('Avoid common or company-specific password words.')
  }
  if (/([a-zA-Z0-9])\1{2,}/.test(password)) errors.push('Avoid repeated characters.')

  return errors
}

function hashPasswordWithIterations(password: string, salt: string, iterations: number) {
  return pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')
}

export function hashPassword(password: string, salt: string) {
  return hashPasswordWithIterations(password, salt, 310_000)
}

function legacyHashPassword(password: string, salt: string) {
  return hashPasswordWithIterations(password, salt, 100_000)
}

function safeHashCompare(expectedHash: string, actualHash: string) {
  const expected = Buffer.from(expectedHash, 'hex')
  const actual = Buffer.from(actualHash, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function verifyPassword(user: StoredUser, password: string) {
  return (
    safeHashCompare(user.passwordHash, hashPassword(password, user.passwordSalt)) ||
    safeHashCompare(user.passwordHash, legacyHashPassword(password, user.passwordSalt))
  )
}

export function makeStoredUser(
  name: string,
  email: string,
  role: Role,
  password: string,
  expectedWeeklyMinutes = 40 * 60,
  yearlyVacationDays = 30,
  trackingStartDate = toDateKey(new Date()),
): StoredUser {
  const passwordSalt = randomBytes(16).toString('hex')
  return {
    id: randomUUID(),
    name,
    email: email.toLowerCase(),
    role,
    expectedWeeklyMinutes,
    yearlyVacationDays,
    trackingStartDate,
    employmentTerms: [initialEmploymentTerm(expectedWeeklyMinutes, yearlyVacationDays, trackingStartDate)],
    balanceAdjustmentMinutes: 0,
    vacationAdjustmentDays: 0,
    calendarAccessUserIds: [],
    active: true,
    mustChangePassword: false,
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
  }
}

function databaseFromUsers(users: StoredUser[]): Database {
  return {
    users,
    timeEntries: [],
    absences: [],
    requests: [],
    holidayOverrides: [],
    calendarGroups:
      users.length > 0
        ? [
            {
              id: 'group-default',
              name: 'Default Team',
              memberUserIds: users.map((user) => user.id),
              createdAt: nowIso(),
            },
          ]
        : [],
    calDavAccounts: [],
    externalCalendarEvents: [],
    customCalendarEvents: [],
    notifications: [],
    importBatches: [],
    audit: [],
    emailOutbox: [],
    userInvitations: [],
    passwordResetTokens: [],
    holidaySettings: defaultHolidaySettings,
    mailServerSettings: undefined,
    licenseSettings: undefined,
  }
}

function initialAdminDatabaseFromEnvironment(): Database | undefined {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim()
  const password = process.env.INITIAL_ADMIN_PASSWORD ?? ''
  const name = process.env.INITIAL_ADMIN_NAME?.trim() || 'Initial Admin'
  const allowUnsafePassword = process.env.INITIAL_ADMIN_ALLOW_UNSAFE_PASSWORD === 'true'
  const mustChangePassword = process.env.INITIAL_ADMIN_MUST_CHANGE_PASSWORD !== 'false'

  if (!email && !password) {
    return undefined
  }

  if (!email || !password) {
    throw new Error('Set both INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD for the first production admin.')
  }

  if (!allowUnsafePassword) {
    const policyErrors = passwordPolicyErrors(password, email, name)
    if (policyErrors.length > 0) {
      throw new Error(`INITIAL_ADMIN_PASSWORD is not safe enough: ${policyErrors.join(' ')}`)
    }
  }

  const admin = makeStoredUser(name, email, 'admin', password, 40 * 60, 30)
  admin.mustChangePassword = mustChangePassword
  return databaseFromUsers([admin])
}

function ensureSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      expectedWeeklyMinutes INTEGER NOT NULL,
      yearlyVacationDays INTEGER NOT NULL,
      employmentTerms TEXT NOT NULL DEFAULT '[]',
      balanceAdjustmentMinutes INTEGER NOT NULL DEFAULT 0,
      vacationAdjustmentDays REAL NOT NULL DEFAULT 0,
      trackingStartDate TEXT,
      calendarAccessUserIds TEXT NOT NULL DEFAULT '[]',
      responsibleAdminUserId TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      mustChangePassword INTEGER NOT NULL DEFAULT 0,
      passwordSalt TEXT NOT NULL,
      passwordHash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      date TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      stoppedAt TEXT,
      breaks TEXT NOT NULL DEFAULT '[]',
      manualBreakMinutes INTEGER,
      workLocation TEXT,
      source TEXT NOT NULL,
      note TEXT,
      requestId TEXT,
      importBatchId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_time_entries_user_date ON time_entries(userId, date);
    CREATE TABLE IF NOT EXISTS absences (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      requestId TEXT,
      label TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_absences_user_date ON absences(userId, date);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      startDate TEXT,
      endDate TEXT,
      minutes INTEGER,
      correctionDate TEXT,
      proposedStartTime TEXT,
      proposedEndTime TEXT,
      proposedBreakMinutes INTEGER,
      customTitle TEXT,
      doctorNoteName TEXT,
      doctorNoteDataUrl TEXT,
      reason TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      decidedAt TEXT,
      decidedBy TEXT,
      adminNote TEXT,
      undoneAt TEXT,
      undoneBy TEXT
    );
    CREATE TABLE IF NOT EXISTS holiday_overrides (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      freePercent REAL NOT NULL DEFAULT 100,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      memberUserIds TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS caldav_accounts (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      serverUrl TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      calendarUrl TEXT,
      calendarName TEXT,
      shareEventTitles INTEGER NOT NULL DEFAULT 0,
      syncEnabled INTEGER NOT NULL DEFAULT 1,
      lastSyncAt TEXT,
      lastSyncStatus TEXT NOT NULL DEFAULT 'never',
      lastSyncError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_caldav_accounts_user ON caldav_accounts(userId);
    CREATE TABLE IF NOT EXISTS external_calendar_events (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      externalId TEXT NOT NULL,
      title TEXT NOT NULL,
      startAt TEXT NOT NULL,
      endAt TEXT NOT NULL,
      isAllDay INTEGER NOT NULL DEFAULT 0,
      busy INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_external_calendar_events_user_start ON external_calendar_events(userId, startAt);
    CREATE INDEX IF NOT EXISTS idx_external_calendar_events_account ON external_calendar_events(accountId);
    CREATE TABLE IF NOT EXISTS custom_calendar_events (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      startTime TEXT,
      endTime TEXT,
      isAllDay INTEGER NOT NULL DEFAULT 1,
      shareWithCalendarUsers INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_calendar_events_user_date ON custom_calendar_events(userId, date);
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      linkType TEXT,
      linkId TEXT
    );
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      importedBy TEXT NOT NULL,
      fileName TEXT NOT NULL,
      importedRows INTEGER NOT NULL,
      skippedRows INTEGER NOT NULL,
      errors TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      actorId TEXT NOT NULL,
      action TEXT NOT NULL,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      recipients TEXT NOT NULL,
      subject TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_invitations (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      acceptedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      usedAt TEXT
    );
    DROP TABLE IF EXISTS company_settings;
    CREATE TABLE IF NOT EXISTS holiday_settings (
      id TEXT PRIMARY KEY,
      country TEXT NOT NULL,
      state TEXT,
      region TEXT,
      language TEXT NOT NULL,
      updatedAt TEXT,
      updatedBy TEXT
    );
    CREATE TABLE IF NOT EXISTS mail_server_settings (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      secure INTEGER NOT NULL DEFAULT 0,
      smtpUser TEXT NOT NULL,
      password TEXT NOT NULL,
      fromAddress TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS license_settings (
      id TEXT PRIMARY KEY,
      licenseKey TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL
    );
  `)

  const columns = database.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'coreUserId')) {
    database.exec(`ALTER TABLE users ADD COLUMN coreUserId TEXT; CREATE UNIQUE INDEX IF NOT EXISTS idx_users_core_id ON users(coreUserId);`)
  }
  if (!columns.some((column) => column.name === 'balanceAdjustmentMinutes')) {
    database.exec(`ALTER TABLE users ADD COLUMN balanceAdjustmentMinutes INTEGER NOT NULL DEFAULT 0;`)
  }
  if (!columns.some((column) => column.name === 'vacationAdjustmentDays')) {
    database.exec(`ALTER TABLE users ADD COLUMN vacationAdjustmentDays REAL NOT NULL DEFAULT 0;`)
  }
  if (!columns.some((column) => column.name === 'employmentTerms')) {
    database.exec(`ALTER TABLE users ADD COLUMN employmentTerms TEXT NOT NULL DEFAULT '[]';`)
  }
  if (!columns.some((column) => column.name === 'trackingStartDate')) {
    database.exec(`ALTER TABLE users ADD COLUMN trackingStartDate TEXT;`)
  }
  if (!columns.some((column) => column.name === 'responsibleAdminUserId')) {
    database.exec(`ALTER TABLE users ADD COLUMN responsibleAdminUserId TEXT;`)
  }
  if (!columns.some((column) => column.name === 'mustChangePassword')) {
    database.exec(`ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0;`)
  }
  const timeColumns = database.prepare(`PRAGMA table_info(time_entries)`).all() as Array<{ name: string }>
  if (!timeColumns.some((column) => column.name === 'importBatchId')) {
    database.exec(`ALTER TABLE time_entries ADD COLUMN importBatchId TEXT;`)
  }
  if (!timeColumns.some((column) => column.name === 'workLocation')) {
    database.exec(`ALTER TABLE time_entries ADD COLUMN workLocation TEXT;`)
  }
  const requestColumns = database.prepare(`PRAGMA table_info(requests)`).all() as Array<{ name: string }>
  if (!requestColumns.some((column) => column.name === 'balanceEffects')) {
    database.exec(`ALTER TABLE requests ADD COLUMN balanceEffects TEXT;`)
  }
  if (!requestColumns.some((column) => column.name === 'doctorNoteName')) {
    database.exec(`ALTER TABLE requests ADD COLUMN doctorNoteName TEXT;`)
  }
  if (!requestColumns.some((column) => column.name === 'customTitle')) {
    database.exec(`ALTER TABLE requests ADD COLUMN customTitle TEXT;`)
  }
  if (!requestColumns.some((column) => column.name === 'doctorNoteDataUrl')) {
    database.exec(`ALTER TABLE requests ADD COLUMN doctorNoteDataUrl TEXT;`)
  }
  if (!requestColumns.some((column) => column.name === 'undoneAt')) {
    database.exec(`ALTER TABLE requests ADD COLUMN undoneAt TEXT;`)
  }
  if (!requestColumns.some((column) => column.name === 'undoneBy')) {
    database.exec(`ALTER TABLE requests ADD COLUMN undoneBy TEXT;`)
  }
  const holidayColumns = database.prepare(`PRAGMA table_info(holiday_overrides)`).all() as Array<{ name: string }>
  if (!holidayColumns.some((column) => column.name === 'freePercent')) {
    database.exec(`ALTER TABLE holiday_overrides ADD COLUMN freePercent REAL NOT NULL DEFAULT 100;`)
  }
}

function databaseConnection() {
  if (!connection) {
    mkdirSync(dirname(dataPath), { recursive: true })
    connection = new DatabaseSync(dataPath)
    connection.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
    ensureSchema(connection)
    migrateLegacyJsonIfNeeded(connection)
    seedIfEmpty(connection)
    seedDefaultCalendarGroupIfEmpty(connection)
    seedHolidaySettingsIfEmpty(connection)
    seedResponsibleAdminsIfMissing(connection)
    backfillApprovedRequestAbsences(connection)
    backfillTrackingStartDates(connection)
  }

  return connection
}

function tableCount(database: DatabaseSync, table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count
}

function migrateLegacyJsonIfNeeded(database: DatabaseSync) {
  if (tableCount(database, 'users') > 0 || !existsSync(legacyJsonPath)) {
    return
  }

  const legacy = JSON.parse(readFileSync(legacyJsonPath, 'utf8')) as Partial<Database>
  writeDatabase({
    users: (legacy.users ?? []).map((user) => ({
      ...user,
      employmentTerms:
        user.employmentTerms?.length
          ? user.employmentTerms
          : [initialEmploymentTerm(user.expectedWeeklyMinutes ?? 40 * 60, user.yearlyVacationDays ?? 30)],
      balanceAdjustmentMinutes: user.balanceAdjustmentMinutes ?? 0,
      vacationAdjustmentDays: user.vacationAdjustmentDays ?? 0,
      trackingStartDate: user.trackingStartDate ?? toDateKey(new Date()),
      responsibleAdminUserId: user.responsibleAdminUserId,
      mustChangePassword: user.mustChangePassword ?? false,
    })) as StoredUser[],
    timeEntries: (legacy.timeEntries ?? []).map((entry) => ({
      ...entry,
      source: entry.source ?? 'clock',
    })) as TimeEntry[],
    absences: legacy.absences ?? [],
    requests: legacy.requests ?? [],
    holidayOverrides: legacy.holidayOverrides ?? [],
    calendarGroups: legacy.calendarGroups ?? [],
    calDavAccounts: [],
    externalCalendarEvents: [],
    customCalendarEvents: legacy.customCalendarEvents ?? [],
    notifications: legacy.notifications ?? [],
    importBatches: legacy.importBatches ?? [],
    audit: legacy.audit ?? [],
    emailOutbox: legacy.emailOutbox ?? [],
    userInvitations: legacy.userInvitations ?? [],
    passwordResetTokens: [],
    holidaySettings: legacy.holidaySettings ?? defaultHolidaySettings,
    mailServerSettings: legacy.mailServerSettings,
    licenseSettings: legacy.licenseSettings,
  })
}

function seedIfEmpty(database: DatabaseSync) {
  if (tableCount(database, 'users') === 0) {
    if (process.env.DCO_CORE_URL?.trim()) return
    const initialAdminDatabase = initialAdminDatabaseFromEnvironment()
    if (initialAdminDatabase) {
      writeDatabase(initialAdminDatabase)
      return
    }

    throw new Error('No users exist. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD to create the first admin account.')
  }
}

function seedDefaultCalendarGroupIfEmpty(database: DatabaseSync) {
  if (tableCount(database, 'calendar_groups') > 0 || tableCount(database, 'users') === 0) {
    return
  }

  const memberUserIds = (database.prepare(`SELECT id FROM users WHERE active = 1 ORDER BY role, name`).all() as unknown as IdRow[]).map(
    (row) => row.id,
  )

  insertCalendarGroup(database, {
    id: 'group-default',
    name: 'Default Team',
    memberUserIds,
    createdAt: nowIso(),
  })
}

function seedHolidaySettingsIfEmpty(database: DatabaseSync) {
  if (tableCount(database, 'holiday_settings') > 0) {
    return
  }

  insertHolidaySettings(database, defaultHolidaySettings)
}

function seedResponsibleAdminsIfMissing(database: DatabaseSync) {
  const admin = database.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY name LIMIT 1`).get() as
    | IdRow
    | undefined
  if (!admin) {
    return
  }

  database
    .prepare(
      `UPDATE users
       SET responsibleAdminUserId = ?
       WHERE role = 'employee'
         AND active = 1
         AND (responsibleAdminUserId IS NULL OR responsibleAdminUserId = '')`,
    )
    .run(admin.id)
}

function requestAbsenceType(type: RequestItem['type']): AbsenceDay['type'] | undefined {
  if (type === 'vacation') {
    return 'vacation'
  }
  if (type === 'sick_leave') {
    return 'sick_leave'
  }
  if (type === 'child_sick_leave') {
    return 'child_sick_leave'
  }
  if (type === 'overtime_time_off') {
    return 'overtime_time_off'
  }
  return undefined
}

function absenceLabelForType(type: AbsenceDay['type']) {
  if (type === 'vacation') {
    return 'Vacation'
  }
  if (type === 'sick_leave') {
    return 'Sick leave'
  }
  if (type === 'child_sick_leave') {
    return 'Child sick leave'
  }
  return 'Overtime time off'
}

function backfillApprovedRequestAbsences(database: DatabaseSync) {
  const requests = database
    .prepare(
      `SELECT * FROM requests
       WHERE status = 'approved'
         AND startDate IS NOT NULL
         AND endDate IS NOT NULL
         AND type IN ('vacation', 'sick_leave', 'child_sick_leave', 'overtime_time_off')`,
    )
    .all() as unknown as RequestRow[]

  for (const request of requests) {
    const absenceType = requestAbsenceType(request.type)
    const startDate = decryptText(request.startDate)
    const endDate = decryptText(request.endDate)
    if (!absenceType || !startDate || !endDate) {
      continue
    }

    const existingDates = new Set(
      (database
        .prepare(
          `SELECT * FROM absences
           WHERE requestId = ?
             AND userId = ?
             AND type = ?`,
        )
        .all(request.id, request.userId, absenceType) as unknown as AbsenceRow[]).map((absence) => decryptRequiredText(absence.date)),
    )

    for (const date of dateKeysBetween(startDate, endDate)) {
      if (existingDates.has(date)) {
        continue
      }

      insertAbsence(database, {
        id: randomUUID(),
        userId: request.userId,
        date,
        type: absenceType,
        requestId: request.id,
        label: absenceLabelForType(absenceType),
        createdAt: nowIso(),
      })
    }
  }
}

function dateKeyFromIso(value: string | null | undefined) {
  const dateKey = value?.slice(0, 10)
  return dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : undefined
}

function earliestDateKey(values: Array<string | undefined>) {
  return values.filter(Boolean).sort()[0]
}

function backfillTrackingStartDates(database: DatabaseSync) {
  const users = database.prepare(`SELECT * FROM users`).all() as unknown as UserRow[]
  const invitations = database.prepare(`SELECT * FROM user_invitations`).all() as unknown as UserInvitationRow[]
  const timeEntries = database.prepare(`SELECT userId, date FROM time_entries`).all() as unknown as Array<Pick<TimeEntryRow, 'userId' | 'date'>>
  const absences = database.prepare(`SELECT userId, date FROM absences`).all() as unknown as Array<Pick<AbsenceRow, 'userId' | 'date'>>

  for (const user of users) {
    const existingStartDate = decryptText(user.trackingStartDate)
    if (existingStartDate) {
      continue
    }

    const registrationDates = invitations
      .filter((invitation) => invitation.userId === user.id)
      .map((invitation) => dateKeyFromIso(invitation.acceptedAt))
    const entryDates = timeEntries
      .filter((entry) => entry.userId === user.id)
      .map((entry) => decryptText(entry.date) ?? undefined)
    const absenceDates = absences
      .filter((absence) => absence.userId === user.id)
      .map((absence) => decryptText(absence.date) ?? undefined)
    const trackingStartDate = earliestDateKey([...registrationDates, ...entryDates, ...absenceDates]) ?? inactiveTrackingStartDate

    database
      .prepare(`UPDATE users SET trackingStartDate = ? WHERE id = ?`)
      .run(encryptText(trackingStartDate) ?? trackingStartDate, user.id)
  }
}

function clearTable(database: DatabaseSync, table: string) {
  database.prepare(`DELETE FROM ${table}`).run()
}

function insertUser(database: DatabaseSync, user: StoredUser) {
  const normalizedUser = normalizeStoredUserTerms(user)
  database
    .prepare(`
      INSERT INTO users (
        id, name, email, role, expectedWeeklyMinutes, yearlyVacationDays, employmentTerms, balanceAdjustmentMinutes, vacationAdjustmentDays, trackingStartDate,
        calendarAccessUserIds, responsibleAdminUserId, active, mustChangePassword, passwordSalt, passwordHash, coreUserId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      normalizedUser.id,
      encryptText(normalizedUser.name) ?? '',
      encryptText(normalizedUser.email.toLowerCase()) ?? '',
      normalizedUser.role,
      normalizedUser.expectedWeeklyMinutes,
      normalizedUser.yearlyVacationDays,
      encryptText(JSON.stringify(normalizedUser.employmentTerms)) ?? '[]',
      normalizedUser.balanceAdjustmentMinutes ?? 0,
      normalizedUser.vacationAdjustmentDays ?? 0,
      encryptText(normalizedUser.trackingStartDate) ?? '',
      encryptText(JSON.stringify(normalizedUser.calendarAccessUserIds ?? [])) ?? '[]',
      normalizedUser.responsibleAdminUserId ?? null,
      normalizedUser.active ? 1 : 0,
      normalizedUser.mustChangePassword ? 1 : 0,
      normalizedUser.passwordSalt,
      normalizedUser.passwordHash,
      normalizedUser.coreUserId ?? null,
    )
}

function insertTimeEntry(database: DatabaseSync, entry: TimeEntry) {
  database
    .prepare(`
      INSERT INTO time_entries (
        id, userId, date, startedAt, stoppedAt, breaks, manualBreakMinutes, source,
        workLocation, note, requestId, importBatchId, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.id,
      entry.userId,
      encryptText(entry.date) ?? '',
      encryptText(entry.startedAt) ?? '',
      encryptText(entry.stoppedAt ?? null),
      encryptText(JSON.stringify(entry.breaks ?? [])) ?? '[]',
      entry.manualBreakMinutes ?? null,
      entry.source,
      encryptText(entry.workLocation ?? null),
      encryptText(entry.note ?? null),
      entry.requestId ?? null,
      entry.importBatchId ?? null,
      entry.createdAt,
      entry.updatedAt,
    )
}

function insertAbsence(database: DatabaseSync, absence: AbsenceDay) {
  database
    .prepare(
      `INSERT INTO absences (id, userId, date, type, requestId, label, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      absence.id,
      absence.userId,
      encryptText(absence.date) ?? '',
      absence.type,
      absence.requestId ?? null,
      encryptText(absence.label) ?? '',
      absence.createdAt,
    )
}

function insertRequest(database: DatabaseSync, request: RequestItem) {
  database
    .prepare(`
      INSERT INTO requests (
        id, userId, type, status, startDate, endDate, minutes, correctionDate,
        proposedStartTime, proposedEndTime, proposedBreakMinutes, customTitle, doctorNoteName, doctorNoteDataUrl, reason,
        createdAt, decidedAt, decidedBy, adminNote, undoneAt, undoneBy, balanceEffects
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      request.id,
      request.userId,
      request.type,
      request.status,
      encryptText(request.startDate ?? null),
      encryptText(request.endDate ?? null),
      request.minutes ?? null,
      encryptText(request.correctionDate ?? null),
      encryptText(request.proposedStartTime ?? null),
      encryptText(request.proposedEndTime ?? null),
      request.proposedBreakMinutes ?? null,
      encryptText(request.customTitle ?? null),
      encryptText(request.doctorNoteName ?? null),
      encryptText(request.doctorNoteDataUrl ?? null),
      encryptText(request.reason) ?? '',
      request.createdAt,
      request.decidedAt ?? null,
      request.decidedBy ?? null,
      encryptText(request.adminNote ?? null),
      request.undoneAt ?? null,
      request.undoneBy ?? null,
      encryptText(request.balanceEffects === undefined ? null : JSON.stringify(request.balanceEffects)),
    )
}

function insertHolidayOverride(database: DatabaseSync, override: HolidayOverride) {
  database
    .prepare(`INSERT INTO holiday_overrides (id, date, name, type, freePercent, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(override.id, override.date, override.name, override.type, override.freePercent, override.createdBy, override.createdAt)
}

function insertCalendarGroup(database: DatabaseSync, group: CalendarGroup) {
  database
    .prepare(`INSERT INTO calendar_groups (id, name, memberUserIds, createdAt) VALUES (?, ?, ?, ?)`)
    .run(group.id, encryptText(group.name) ?? '', encryptText(JSON.stringify(group.memberUserIds)) ?? '[]', group.createdAt)
}

function insertCalDavAccount(database: DatabaseSync, account: StoredCalDavAccount) {
  database
    .prepare(`
      INSERT INTO caldav_accounts (
        id, userId, name, serverUrl, username, password, calendarUrl, calendarName,
        shareEventTitles, syncEnabled, lastSyncAt, lastSyncStatus, lastSyncError, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      account.id,
      account.userId,
      encryptText(account.name) ?? '',
      encryptText(account.serverUrl) ?? '',
      encryptText(account.username) ?? '',
      encryptText(account.password) ?? '',
      encryptText(account.calendarUrl ?? null),
      encryptText(account.calendarName ?? null),
      account.shareEventTitles ? 1 : 0,
      account.syncEnabled ? 1 : 0,
      account.lastSyncAt ?? null,
      account.lastSyncStatus,
      encryptText(account.lastSyncError ?? null),
      account.createdAt,
      account.updatedAt,
    )
}

function insertExternalCalendarEvent(database: DatabaseSync, event: ExternalCalendarEvent) {
  database
    .prepare(`
      INSERT INTO external_calendar_events (
        id, userId, accountId, externalId, title, startAt, endAt, isAllDay, busy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      event.id,
      event.userId,
      event.accountId,
      encryptText(event.externalId) ?? '',
      encryptText(event.title) ?? '',
      encryptText(event.startAt) ?? '',
      encryptText(event.endAt) ?? '',
      event.isAllDay ? 1 : 0,
      event.busy ? 1 : 0,
      event.createdAt,
      event.updatedAt,
    )
}

function insertCustomCalendarEvent(database: DatabaseSync, event: CustomCalendarEvent) {
  database
    .prepare(`
      INSERT INTO custom_calendar_events (
        id, userId, title, description, date, startTime, endTime, isAllDay, shareWithCalendarUsers, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      event.id,
      event.userId,
      encryptText(event.title) ?? '',
      encryptText(event.description ?? null),
      encryptText(event.date) ?? '',
      encryptText(event.startTime ?? null),
      encryptText(event.endTime ?? null),
      event.isAllDay ? 1 : 0,
      event.shareWithCalendarUsers ? 1 : 0,
      event.createdAt,
      event.updatedAt,
    )
}

function insertMailServerSettings(database: DatabaseSync, settings: StoredMailServerSettings) {
  database
    .prepare(
      `INSERT INTO mail_server_settings (id, host, port, secure, smtpUser, password, fromAddress, updatedAt, updatedBy)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      encryptText(settings.host) ?? '',
      settings.port,
      settings.secure ? 1 : 0,
      encryptText(settings.user) ?? '',
      encryptText(settings.password) ?? '',
      encryptText(settings.fromAddress) ?? '',
      settings.updatedAt,
      settings.updatedBy,
    )
}

function insertHolidaySettings(database: DatabaseSync, settings: HolidaySettings) {
  const normalized = normalizeHolidaySettings(settings)
  database
    .prepare(
      `INSERT INTO holiday_settings (id, country, state, region, language, updatedAt, updatedBy)
       VALUES ('default', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalized.country,
      normalized.state ?? null,
      normalized.region ?? null,
      normalized.language,
      normalized.updatedAt ?? null,
      normalized.updatedBy ?? null,
    )
}

function insertLicenseSettings(database: DatabaseSync, settings: StoredLicenseSettings) {
  database
    .prepare(
      `INSERT INTO license_settings (id, licenseKey, updatedAt, updatedBy)
       VALUES ('default', ?, ?, ?)`,
    )
    .run(encryptText(settings.licenseKey) ?? '', settings.updatedAt, settings.updatedBy)
}

function insertNotification(database: DatabaseSync, notification: NotificationItem) {
  database
    .prepare(`
      INSERT INTO notifications (id, userId, title, message, read, createdAt, linkType, linkId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      notification.id,
      notification.userId,
      encryptText(notification.title) ?? '',
      encryptText(notification.message) ?? '',
      notification.read ? 1 : 0,
      notification.createdAt,
      notification.linkType ?? null,
      encryptText(notification.linkId ?? null),
    )
}

function insertImportBatch(database: DatabaseSync, batch: ImportBatch) {
  database
    .prepare(`
      INSERT INTO import_batches (id, userId, importedBy, fileName, importedRows, skippedRows, errors, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      batch.id,
      batch.userId,
      batch.importedBy,
      encryptText(batch.fileName) ?? '',
      batch.importedRows,
      batch.skippedRows,
      encryptText(JSON.stringify(batch.errors)) ?? '[]',
      batch.createdAt,
    )
}

function insertAudit(database: DatabaseSync, audit: AuditEvent) {
  database
    .prepare(`INSERT INTO audit (id, actorId, action, targetType, targetId, details, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      audit.id,
      audit.actorId,
      audit.action,
      audit.targetType,
      audit.targetId,
      encryptText(JSON.stringify(audit.details)) ?? '{}',
      audit.createdAt,
    )
}

function insertEmailOutbox(database: DatabaseSync, item: EmailOutboxItem) {
  database
    .prepare(`INSERT INTO email_outbox (id, recipients, subject, text, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      item.id,
      encryptText(JSON.stringify(item.to)) ?? '[]',
      encryptText(item.subject) ?? '',
      encryptText(item.text) ?? '',
      item.status,
      item.createdAt,
    )
}

function insertUserInvitation(database: DatabaseSync, invitation: StoredUserInvitation) {
  database
    .prepare(
      `INSERT INTO user_invitations
       (id, userId, email, role, tokenHash, createdBy, createdAt, expiresAt, acceptedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      invitation.id,
      invitation.userId,
      encryptText(invitation.email.toLowerCase()) ?? '',
      invitation.role,
      invitation.tokenHash,
      invitation.createdBy,
      invitation.createdAt,
      invitation.expiresAt,
      invitation.acceptedAt ?? null,
    )
}

function insertPasswordResetToken(database: DatabaseSync, resetToken: StoredPasswordResetToken) {
  database
    .prepare(
      `INSERT INTO password_reset_tokens
       (id, userId, tokenHash, createdAt, expiresAt, usedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(resetToken.id, resetToken.userId, resetToken.tokenHash, resetToken.createdAt, resetToken.expiresAt, resetToken.usedAt ?? null)
}

const databaseBaselines = new WeakMap<Database, Database>()

export class DatabaseConflictError extends Error {
  constructor() {
    super('This record changed while the operation was running. Reload and try again.')
    this.name = 'DatabaseConflictError'
  }
}

export function readDatabase(): Database {
  const sql = databaseConnection()
  sql.exec('BEGIN')
  try {
    const database = readDatabaseContents()
    sql.exec('COMMIT')
    databaseBaselines.set(database, structuredClone(database))
    return database
  } catch (error) {
    sql.exec('ROLLBACK')
    throw error
  }
}

function readDatabaseContents(): Database {
  const database = databaseConnection()
  return {
    users: (database.prepare(`SELECT * FROM users ORDER BY role, name`).all() as unknown as UserRow[])
      .map((row) => ({
        id: row.id,
        coreUserId: row.coreUserId ?? undefined,
        name: decryptRequiredText(row.name),
        email: decryptRequiredText(row.email).toLowerCase(),
        role: row.role,
        expectedWeeklyMinutes: row.expectedWeeklyMinutes,
        yearlyVacationDays: row.yearlyVacationDays,
        employmentTerms: parseJson(row.employmentTerms, []),
        balanceAdjustmentMinutes: row.balanceAdjustmentMinutes ?? 0,
        vacationAdjustmentDays: row.vacationAdjustmentDays ?? 0,
        trackingStartDate: decryptText(row.trackingStartDate) ?? toDateKey(new Date()),
        calendarAccessUserIds: parseJson<string[]>(row.calendarAccessUserIds, []),
        responsibleAdminUserId: row.responsibleAdminUserId ?? undefined,
        active: Boolean(row.active),
        mustChangePassword: Boolean(row.mustChangePassword),
        passwordSalt: row.passwordSalt,
        passwordHash: row.passwordHash,
      }))
      .map(normalizeStoredUserTerms)
      .sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name)),
    timeEntries: (database.prepare(`SELECT * FROM time_entries ORDER BY date DESC, startedAt DESC`).all() as unknown as TimeEntryRow[]).map(
      (row) => ({
        id: row.id,
        userId: row.userId,
        date: decryptRequiredText(row.date),
        startedAt: decryptRequiredText(row.startedAt),
        stoppedAt: decryptText(row.stoppedAt) ?? undefined,
        breaks: parseJson(row.breaks, []),
        manualBreakMinutes: row.manualBreakMinutes ?? undefined,
        workLocation: decryptText(row.workLocation) as TimeEntry['workLocation'] | undefined,
        source: row.source,
        note: decryptText(row.note) ?? undefined,
        requestId: row.requestId ?? undefined,
        importBatchId: row.importBatchId ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ).sort((left, right) => right.date.localeCompare(left.date) || right.startedAt.localeCompare(left.startedAt)),
    absences: (database.prepare(`SELECT * FROM absences ORDER BY date DESC`).all() as unknown as AbsenceRow[]).map((row) => ({
      id: row.id,
      userId: row.userId,
      date: decryptRequiredText(row.date),
      type: row.type,
      requestId: row.requestId ?? undefined,
      label: decryptRequiredText(row.label),
      createdAt: row.createdAt,
    })).sort((left, right) => right.date.localeCompare(left.date)),
    requests: (database.prepare(`SELECT * FROM requests ORDER BY createdAt DESC`).all() as unknown as RequestRow[]).map((row) => ({
      id: row.id,
      userId: row.userId,
      type: row.type,
      status: row.status,
      startDate: decryptText(row.startDate) ?? undefined,
      endDate: decryptText(row.endDate) ?? undefined,
      minutes: row.minutes ?? undefined,
      balanceEffects: row.balanceEffects === null ? undefined : parseJson(row.balanceEffects, []),
      correctionDate: decryptText(row.correctionDate) ?? undefined,
      proposedStartTime: decryptText(row.proposedStartTime) ?? undefined,
      proposedEndTime: decryptText(row.proposedEndTime) ?? undefined,
      proposedBreakMinutes: row.proposedBreakMinutes ?? undefined,
      customTitle: decryptText(row.customTitle) ?? undefined,
      doctorNoteName: decryptText(row.doctorNoteName) ?? undefined,
      doctorNoteDataUrl: decryptText(row.doctorNoteDataUrl) ?? undefined,
      reason: decryptRequiredText(row.reason),
      createdAt: row.createdAt,
      decidedAt: row.decidedAt ?? undefined,
      decidedBy: row.decidedBy ?? undefined,
      adminNote: decryptText(row.adminNote) ?? undefined,
      undoneAt: row.undoneAt ?? undefined,
      undoneBy: row.undoneBy ?? undefined,
    })),
    holidayOverrides: (database.prepare(`SELECT * FROM holiday_overrides ORDER BY createdAt DESC`).all() as unknown as HolidayOverrideRow[]).map(
      (row) => ({ ...row, freePercent: row.freePercent ?? 100 }),
    ),
    calendarGroups: (database.prepare(`SELECT * FROM calendar_groups ORDER BY name`).all() as unknown as CalendarGroupRow[]).map((row) => ({
      id: row.id,
      name: decryptRequiredText(row.name),
      memberUserIds: parseJson<string[]>(row.memberUserIds, []),
      createdAt: row.createdAt,
    })).sort((left, right) => left.name.localeCompare(right.name)),
    calDavAccounts: (database.prepare(`SELECT * FROM caldav_accounts ORDER BY name`).all() as unknown as CalDavAccountRow[]).map((row) => ({
      id: row.id,
      userId: row.userId,
      name: decryptRequiredText(row.name),
      serverUrl: decryptRequiredText(row.serverUrl),
      username: decryptRequiredText(row.username),
      password: decryptRequiredText(row.password),
      calendarUrl: decryptText(row.calendarUrl) ?? undefined,
      calendarName: decryptText(row.calendarName) ?? undefined,
      shareEventTitles: Boolean(row.shareEventTitles),
      syncEnabled: Boolean(row.syncEnabled),
      passwordConfigured: decryptRequiredText(row.password).length > 0,
      lastSyncAt: row.lastSyncAt ?? undefined,
      lastSyncStatus: row.lastSyncStatus ?? 'never',
      lastSyncError: decryptText(row.lastSyncError) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })).sort((left, right) => left.name.localeCompare(right.name)),
    externalCalendarEvents: (
      database.prepare(`SELECT * FROM external_calendar_events ORDER BY startAt`).all() as unknown as ExternalCalendarEventRow[]
    ).map((row) => ({
      id: row.id,
      userId: row.userId,
      accountId: row.accountId,
      externalId: decryptRequiredText(row.externalId),
      title: decryptRequiredText(row.title),
      startAt: decryptRequiredText(row.startAt),
      endAt: decryptRequiredText(row.endAt),
      isAllDay: Boolean(row.isAllDay),
      busy: Boolean(row.busy),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })).sort((left, right) => left.startAt.localeCompare(right.startAt)),
    customCalendarEvents: (
      database.prepare(`SELECT * FROM custom_calendar_events ORDER BY date, startTime, title`).all() as unknown as CustomCalendarEventRow[]
    ).map((row) => ({
      id: row.id,
      userId: row.userId,
      title: decryptRequiredText(row.title),
      description: decryptText(row.description) ?? undefined,
      date: decryptRequiredText(row.date),
      startTime: decryptText(row.startTime) ?? undefined,
      endTime: decryptText(row.endTime) ?? undefined,
      isAllDay: Boolean(row.isAllDay),
      shareWithCalendarUsers: Boolean(row.shareWithCalendarUsers),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })).sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        (left.startTime ?? '').localeCompare(right.startTime ?? '') ||
        left.title.localeCompare(right.title),
    ),
    notifications: (database.prepare(`SELECT * FROM notifications ORDER BY createdAt DESC`).all() as unknown as NotificationRow[]).map((row) => ({
      id: row.id,
      userId: row.userId,
      title: decryptRequiredText(row.title),
      message: decryptRequiredText(row.message),
      read: Boolean(row.read),
      createdAt: row.createdAt,
      linkType: row.linkType ?? undefined,
      linkId: decryptText(row.linkId) ?? undefined,
    })),
    importBatches: (database.prepare(`SELECT * FROM import_batches ORDER BY createdAt DESC`).all() as unknown as ImportBatchRow[]).map((row) => ({
      id: row.id,
      userId: row.userId,
      importedBy: row.importedBy,
      fileName: decryptRequiredText(row.fileName),
      importedRows: row.importedRows,
      skippedRows: row.skippedRows,
      errors: parseJson(row.errors, []),
      createdAt: row.createdAt,
    })),
    audit: (database.prepare(`SELECT * FROM audit ORDER BY createdAt DESC`).all() as unknown as AuditRow[]).map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      details: parseJson(row.details, {}),
      createdAt: row.createdAt,
    })),
    emailOutbox: (database.prepare(`SELECT * FROM email_outbox ORDER BY createdAt DESC`).all() as unknown as EmailOutboxRow[]).map((row) => ({
      id: row.id,
      to: parseJson(row.recipients, []),
      subject: decryptRequiredText(row.subject),
      text: decryptRequiredText(row.text),
      status: row.status,
      createdAt: row.createdAt,
    })),
    userInvitations: (database.prepare(`SELECT * FROM user_invitations ORDER BY createdAt DESC`).all() as unknown as UserInvitationRow[]).map(
      (row) => ({
        id: row.id,
        userId: row.userId,
        email: decryptRequiredText(row.email).toLowerCase(),
        role: row.role,
        tokenHash: row.tokenHash,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        acceptedAt: row.acceptedAt ?? undefined,
      }),
    ),
    passwordResetTokens: (
      database.prepare(`SELECT * FROM password_reset_tokens ORDER BY createdAt DESC`).all() as unknown as PasswordResetTokenRow[]
    ).map((row) => ({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt ?? undefined,
    })),
    holidaySettings: (() => {
      const row = database.prepare(`SELECT * FROM holiday_settings WHERE id = 'default'`).get() as unknown as
        | HolidaySettingsRow
        | undefined
      return row
        ? normalizeHolidaySettings({
            country: row.country,
            state: row.state ?? undefined,
            region: row.region ?? undefined,
            language: row.language,
            updatedAt: row.updatedAt ?? undefined,
            updatedBy: row.updatedBy ?? undefined,
          })
        : defaultHolidaySettings
    })(),
    mailServerSettings: (() => {
      const row = database.prepare(`SELECT * FROM mail_server_settings WHERE id = 'default'`).get() as unknown as
        | MailServerSettingsRow
        | undefined
      return row
        ? {
            host: decryptRequiredText(row.host),
            port: row.port,
            secure: Boolean(row.secure),
            user: decryptRequiredText(row.smtpUser),
            password: decryptRequiredText(row.password),
            fromAddress: decryptRequiredText(row.fromAddress),
            passwordConfigured: decryptRequiredText(row.password).length > 0,
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
        }
        : undefined
    })(),
    licenseSettings: (() => {
      const row = database.prepare(`SELECT * FROM license_settings WHERE id = 'default'`).get() as unknown as
        | LicenseSettingsRow
        | undefined
      return row
        ? {
            licenseKey: decryptRequiredText(row.licenseKey),
            updatedAt: row.updatedAt,
            updatedBy: row.updatedBy,
          }
        : undefined
    })(),
  }
}

export function writeDatabase(database: Database) {
  return writeDatabaseAtomically(database, (_sql, persist) => persist())
}

/**
 * Wrap synchronous persistence in the same SQLite transaction as another journal.
 * The wrapper may skip persist (for an idempotent duplicate); no snapshot baseline
 * is then advanced. It must not perform network work or manage the transaction.
 */
export function writeDatabaseAtomically<T>(database: Database, wrapPersist: (sql: DatabaseSync, persist: () => void) => T): T {
  const sql = databaseConnection()
  sql.exec('BEGIN IMMEDIATE')
  try {
    let persistedBaseline: Database | undefined
    let persisted = false
    const persist = () => {
      if (persisted || !sql.isTransaction) throw new Error('Database persistence must run once inside its transaction.')
      // Compare the records this operation actually changed against its read
      // snapshot. An asynchronous calendar/mail request must never replace newer
      // clock entries, credentials or approvals from another request.
      const current = readDatabaseContents()
      const baseline = databaseBaselines.get(database) ?? current
      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
      function rows<T extends { id: string }>(table: string, before: T[], after: T[], latest: T[], insert: (sql: DatabaseSync, row: T) => void) {
        const originals = new Map(before.map((row) => [row.id, row]))
        const updates = new Map(after.map((row) => [row.id, row]))
        const persisted = new Map(latest.map((row) => [row.id, row]))
        for (const id of new Set([...originals.keys(), ...updates.keys()])) {
          const original = originals.get(id)
          const update = updates.get(id)
          if (same(original, update)) continue
          const latestRow = persisted.get(id)
          if (!same(original, latestRow)) {
            if (same(update, latestRow)) continue
            throw new DatabaseConflictError()
          }
          sql.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
          if (update) insert(sql, update)
        }
      }
      rows('users', baseline.users, database.users, current.users, insertUser)
      rows('time_entries', baseline.timeEntries, database.timeEntries, current.timeEntries, insertTimeEntry)
      rows('absences', baseline.absences, database.absences, current.absences, insertAbsence)
      rows('requests', baseline.requests, database.requests, current.requests, insertRequest)
      rows('holiday_overrides', baseline.holidayOverrides, database.holidayOverrides, current.holidayOverrides, insertHolidayOverride)
      rows('calendar_groups', baseline.calendarGroups, database.calendarGroups, current.calendarGroups, insertCalendarGroup)
      rows('caldav_accounts', baseline.calDavAccounts, database.calDavAccounts, current.calDavAccounts, insertCalDavAccount)
      rows('external_calendar_events', baseline.externalCalendarEvents, database.externalCalendarEvents, current.externalCalendarEvents, insertExternalCalendarEvent)
      rows('custom_calendar_events', baseline.customCalendarEvents, database.customCalendarEvents, current.customCalendarEvents, insertCustomCalendarEvent)
      rows('notifications', baseline.notifications, database.notifications, current.notifications, insertNotification)
      rows('import_batches', baseline.importBatches, database.importBatches, current.importBatches, insertImportBatch)
      rows('audit', baseline.audit, database.audit, current.audit, insertAudit)
      rows('email_outbox', baseline.emailOutbox, database.emailOutbox, current.emailOutbox, insertEmailOutbox)
      rows('user_invitations', baseline.userInvitations, database.userInvitations, current.userInvitations, insertUserInvitation)
      rows('password_reset_tokens', baseline.passwordResetTokens, database.passwordResetTokens, current.passwordResetTokens, insertPasswordResetToken)
      function settings<T>(table: string, before: T | undefined, after: T | undefined, latest: T | undefined, insert: (sql: DatabaseSync, value: T) => void) {
        if (same(before, after)) return
        if (!same(before, latest)) throw new DatabaseConflictError()
        clearTable(sql, table)
        if (after) insert(sql, after)
      }
      settings('holiday_settings', baseline.holidaySettings, database.holidaySettings, current.holidaySettings, insertHolidaySettings)
      settings('mail_server_settings', baseline.mailServerSettings, database.mailServerSettings, current.mailServerSettings, insertMailServerSettings)
      settings('license_settings', baseline.licenseSettings, database.licenseSettings, current.licenseSettings, insertLicenseSettings)
      persistedBaseline = structuredClone(database)
      persisted = true
    }
    const result = wrapPersist(sql, persist)
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) throw new Error('Database persistence wrappers must be synchronous.')
    sql.exec('COMMIT')
    if (persistedBaseline) databaseBaselines.set(database, persistedBaseline)
    return result
  } catch (error) {
    sql.exec('ROLLBACK')
    throw error
  }
}

export function addAudit(
  database: Database,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
) {
  database.audit.unshift({
    id: randomUUID(),
    actorId,
    action,
    targetType,
    targetId,
    details,
    createdAt: nowIso(),
  })
}

export function addNotification(
  database: Database,
  userId: string,
  title: string,
  message: string,
  linkType?: NotificationItem['linkType'],
  linkId?: string,
) {
  database.notifications.unshift({
    id: randomUUID(),
    userId,
    title,
    message,
    read: false,
    createdAt: nowIso(),
    linkType,
    linkId,
  })
}

export function adminUsers(database: Database) {
  return database.users.filter((user) => user.role === 'admin' && user.active)
}

function isoWeekKey(date: Date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = copy.getUTCDay() || 7
  copy.setUTCDate(copy.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function listBackups() {
  if (!existsSync(backupDir)) {
    return []
  }

  return readdirSync(backupDir)
    .filter((file) => file.endsWith('.sqlite'))
    .sort()
}

const weeklyBackupsInProgress = new Map<string, Promise<string>>()

export async function ensureWeeklyBackup() {
  const database = databaseConnection()
  mkdirSync(backupDir, { recursive: true })
  const weekKey = isoWeekKey(new Date())
  const backupPath = join(backupDir, `time-tracker-${weekKey}.sqlite`)
  if (existsSync(backupPath)) return backupPath
  const active = weeklyBackupsInProgress.get(backupPath)
  if (active) return active
  const temporaryPath = `${backupPath}.${randomUUID()}.partial`
  const operation = (async () => {
    try {
      // SQLite's online backup reads a consistent snapshot including committed
      // WAL pages. Publish only the complete file; interrupted files are ignored.
      await backup(database, temporaryPath)
      if (!existsSync(backupPath)) renameSync(temporaryPath, backupPath)
      return backupPath
    } finally {
      rmSync(temporaryPath, { force: true })
      weeklyBackupsInProgress.delete(backupPath)
    }
  })()
  weeklyBackupsInProgress.set(backupPath, operation)
  return operation
}

export function backupInfo(): BackupInfo {
  const backups = listBackups()
  return {
    dataFile: dataPath,
    backupDir,
    lastWeeklyBackup: backups.at(-1),
    nextAutomaticCheck: 'Daily while the server is running; a new file is created once per ISO week.',
  }
}

export function dataFilePath() {
  return dataPath
}
