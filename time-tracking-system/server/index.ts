import { organizationTimezone } from './timezone.ts'
import { coreEnabled, CoreAuthError, requireCoreIdentity, loginWithCore, logoutFromCore, coreCookieTokenForRequest, coreSessionCookie, coreAccountRequest, type CoreIdentity, type CoreRequest } from '../../packages/core-client/index.ts'
import { provisionCoreUser } from './coreAuth.ts'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type {
  CalDavAccount,
  CalendarGroup,
  ClockAction,
  CustomCalendarEvent,
  ExternalCalendarEvent,
  MailServerSettings,
  RequestItem,
  RequestStatus,
  RequestType,
  Role,
  TimeEntry,
  UserInvitation,
  WorkLocation,
} from '../shared/domain.ts'
import {
  clampDateRange,
  endOfMonth,
  endOfWeek,
  formatDecimalHours,
  isSensibleDateKey,
  isValidDateKey,
  parseDateKey,
  sensibleDateBounds,
  startOfMonth,
  startOfWeek,
  toDateKey,
} from '../shared/dates.ts'
import {
  addAudit,
  DatabaseConflictError,
  addNotification,
  adminUsers,
  backupInfo,
  dataFilePath,
  ensureWeeklyBackup,
  hashPassword,
  inactiveTrackingStartDate,
  makeStoredUser,
  nowIso,
  passwordPolicyErrors,
  publicUser,
  readDatabase,
  type StoredCalDavAccount,
  type StoredUser,
  verifyPassword,
  writeDatabase,
  writeDatabaseAtomically,
} from './store.ts'
import { clockStatusForUser, openEntryForUser, summariesForUsers, summaryForUser, vacationUsedDays } from './calculations.ts'
import { dayIssuesForUsers } from './dayIssues.ts'
import {
  currentHolidayYears,
  holidaySettingsSupported,
  holidayTemplateOptions,
  holidaysForYears,
  makeHolidayOverride,
  normalizeHolidaySettings,
  yearsForDateRange,
} from './holidays.ts'
import { mailServerConfigured, sendEmail } from './mailer.ts'
import { importTimeCsv } from './csvImport.ts'
import { currentEmploymentTerm, employmentTermsFor, termForDate } from '../shared/terms.ts'
import { buildTimeCsvExport, type TimeExportLanguage, type TimeExportPeriod } from './csvExport.ts'
import { buildCalendarIcsExport, type CalendarExportLanguage, type CalendarExportMode } from './calendarExport.ts'
import { licenseStateForDatabase, verifyLicenseKey } from './license.ts'
import { syncCalDavAccount } from './caldav.ts'
import { applyApprovedRequestEffects, undoApprovedRequestEffects, validateTimeCorrection } from './requestEffects.ts'
import { zeitguruEvaluationEnabled } from './zeitguruConfig.ts'
import { ZeitguruStore, ZeitguruStoreError } from './zeitguruStore.ts'
import { ZeitguruService, ZeitguruBridgeError, zeitguruPublicError } from './zeitguruService.ts'
import { ZeitguruWebProvider } from './zeitguruWebProvider.ts'
import { applyZeitguruLiveSync, applyZeitguruRebase } from './zeitguruLiveSync.ts'
import { ZeitguruHistoryStore, ZeitguruHistoryError as ZeitguruHistoryStoreError } from './zeitguruHistoryStore.ts'
import { ZeitguruHistoryService } from './zeitguruHistoryService.ts'
import { ZeitguruAccountingStore, ZeitguruAccountingError } from './zeitguruAccountingStore.ts'
import type { ZeitguruAccountingContexts } from '../shared/timeAccounting.ts'
import { OvertimePolicyStore, OvertimePolicyError } from './overtimePolicyStore.ts'
import { OvertimePolicyService } from './overtimePolicyService.ts'

interface AuthedRequest extends Request {
  user?: StoredUser
}

const app = express()
const port = Number(process.env.PORT ?? 4177)
const host = process.env.HOST ?? '0.0.0.0'
const tokens = new Map<string, { userId: string; expiresAt: number }>()
const loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil?: number }>()
const passwordResetAttempts = new Map<string, { count: number; resetAt: number; blockedUntil?: number }>()
const moduleDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(moduleDir, '..', 'dist')
const indexHtmlPath = join(distDir, 'index.html')
const httpServer = createServer(app)
const liveServer = new WebSocketServer({ noServer: true })
const liveClients = new Map<WebSocket, { userId: string }>()
const liveCoreRequests = new Map<WebSocket, CoreRequest>()
const coreIdentities = new Map<string, CoreIdentity>()
let liveBroadcastTimer: NodeJS.Timeout | undefined
const automaticClockOutAfterMinutes = 13 * 60
const automaticClockOutCheckMs = 60_000
const zeitguru: ZeitguruService | undefined = zeitguruEvaluationEnabled() ? (() => {
  readDatabase()
  return new ZeitguruService(new ZeitguruStore(dataFilePath()), new ZeitguruWebProvider(), {
    user: id => readDatabase().users.find(user => user.id === id),
    isClockedOut: id => !openEntryForUser(readDatabase().timeEntries, id),
    changed: () => scheduleLiveStateBroadcast(),
    synchronize: (userId, generation, revision, observed, consentedAt, connect, historicalReviewDates) => applyZeitguruLiveSync(zeitguru!.journal, userId, generation, revision, observed, consentedAt, connect, historicalReviewDates),
    rebase: (userId, generation, revision, unsent, plans) => applyZeitguruRebase(zeitguru!.journal, userId, generation, revision, unsent, plans),
  })
})() : undefined
const zeitguruAccounting = zeitguru ? new ZeitguruAccountingStore(dataFilePath(),{inputs:(from,to)=>{
  const database=readDatabase()
  return{absences:database.absences,holidays:holidaysForYears(yearsForDateRange(from,to),database.holidayOverrides,database.holidaySettings)}
}}) : undefined
const zeitguruHistory = zeitguru ? new ZeitguruHistoryService(new ZeitguruHistoryStore(dataFilePath()), zeitguru, { accountingStore: zeitguruAccounting, nativeEntries: () => readDatabase().timeEntries }) : undefined
readDatabase()
const overtimePolicies = new OvertimePolicyStore(dataFilePath())
const overtimeMonitor = new OvertimePolicyService(overtimePolicies, () => {
  const database=readDatabase(), accounting: ZeitguruAccountingContexts={}
  const projected=database.users.filter(user=>user.active).flatMap(user=>{
    const projection=zeitguruAccounting?.projection(user.id,database.timeEntries)
    if(projection?.accounting) accounting[user.id]=projection.accounting
    return projection?.entries??[]
  })
  return {database,entries:[...database.timeEntries,...projected],accounting,holidays:holidaysForYears(currentHolidayYears(),database.holidayOverrides,database.holidaySettings)}
})

app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(securityHeaders)
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json({ limit: '5mb' }))

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const sessionTtlMs = numberFromEnv('SESSION_TTL_HOURS', 12) * 60 * 60 * 1000
const loginRateLimitMax = Math.max(1, Math.round(numberFromEnv('LOGIN_RATE_LIMIT_MAX', 8)))
const loginRateLimitWindowMs = numberFromEnv('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000
const passwordResetRateLimitMax = Math.max(1, Math.round(numberFromEnv('PASSWORD_RESET_RATE_LIMIT_MAX', 5)))
const passwordResetRateLimitWindowMs = numberFromEnv('PASSWORD_RESET_RATE_LIMIT_WINDOW_MINUTES', 30) * 60 * 1000
const doctorNoteMaxBytes = Math.round(numberFromEnv('DOCTOR_NOTE_MAX_BYTES', 2 * 1024 * 1024))
const maxRequestRangeDays = Math.max(1, Math.round(numberFromEnv('MAX_REQUEST_RANGE_DAYS', 366)))
const persistentSessionTtlMs = numberFromEnv('PERSISTENT_SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000
const sessionSecret = process.env.SESSION_SECRET ?? process.env.DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('hex')
const digitalOfficeSsoCookieName = process.env.DIGITAL_OFFICE_SSO_COOKIE_NAME?.trim() || 'digital_office_sso'
const digitalOfficeSsoSecret = process.env.DIGITAL_OFFICE_SSO_SECRET ?? sessionSecret
const digitalOfficeCookieDomain = process.env.DIGITAL_OFFICE_COOKIE_DOMAIN?.trim()

function securityHeaders(request: Request, response: Response, next: NextFunction) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'SAMEORIGIN')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'sha256-VWOyWoKX77oYk0fAbOgBV7YoHQ9hCm+xkBeb5XDnMcI='",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  )

  if (request.secure || request.get('x-forwarded-proto') === 'https') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  next()
}

function originFromUrl(value: string | undefined) {
  if (!value) {
    return undefined
  }

  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function normalizeOrigin(value: string | undefined) {
  return value?.trim().replace(/\/+$/, '')
}

function originMatchesRequestHost(origin: string | undefined, requestHost: string | undefined) {
  if (!origin || !requestHost) {
    return false
  }

  try {
    const parsedOrigin = new URL(origin)
    return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') && parsedOrigin.host === requestHost
  } catch {
    return false
  }
}

function configuredCorsOrigins() {
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  const appOrigin = originFromUrl(process.env.APP_BASE_URL)
  const mobileOrigins = [
    'http://asset.localhost',
    'https://asset.localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ]
  const developmentOrigins =
    process.env.NODE_ENV === 'production'
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4177', 'http://127.0.0.1:4177']
  return new Set([...configured, ...(appOrigin ? [appOrigin] : []), ...mobileOrigins, ...developmentOrigins])
}

function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin || configuredCorsOrigins().has(normalizedOrigin)) {
    callback(null, true)
    return
  }

  callback(null, false)
}

function handleJsonParseError(error: unknown, _request: Request, response: Response, next: NextFunction) {
  const parseError = error as { status?: number; type?: string } | undefined
  if (parseError?.status === 400 && parseError.type === 'entity.parse.failed') {
    response.status(400).json({ message: 'Invalid JSON body' })
    return
  }

  next(error)
}

function signTokenPayload(encodedPayload: string) {
  return createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url')
}

function safeTokenSignatureMatch(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name) cookies.set(name, value)
  }
  return cookies
}

function secureCookieForRequest(request: Request) {
  return request.secure || request.get('x-forwarded-proto') === 'https'
}

function signDigitalOfficeSsoPayload(encodedPayload: string) {
  return createHmac('sha256', digitalOfficeSsoSecret).update(encodedPayload).digest('base64url')
}

function digitalOfficeSsoCookieValue(user: StoredUser, stayLoggedIn: boolean) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      email: user.email.toLowerCase(),
      stayLoggedIn,
      expiresAt: Date.now() + (stayLoggedIn ? persistentSessionTtlMs : sessionTtlMs),
    }),
  ).toString('base64url')
  return `v1.${encodedPayload}.${signDigitalOfficeSsoPayload(encodedPayload)}`
}

function digitalOfficeSsoCookie(request: Request, user: StoredUser, stayLoggedIn: boolean) {
  return [
    `${digitalOfficeSsoCookieName}=${digitalOfficeSsoCookieValue(user, stayLoggedIn)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    digitalOfficeCookieDomain ? `Domain=${digitalOfficeCookieDomain}` : '',
    stayLoggedIn ? `Max-Age=${Math.floor(persistentSessionTtlMs / 1000)}` : '',
    secureCookieForRequest(request) ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function clearDigitalOfficeSsoCookie(request: Request) {
  return [
    `${digitalOfficeSsoCookieName}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    digitalOfficeCookieDomain ? `Domain=${digitalOfficeCookieDomain}` : '',
    'Max-Age=0',
    secureCookieForRequest(request) ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function digitalOfficeSsoForRequest(request: Request) {
  const token = parseCookies(request.header('cookie')).get(digitalOfficeSsoCookieName)
  const [version, encodedPayload, signature] = (token ?? '').split('.')
  if (version !== 'v1' || !encodedPayload || !signature) {
    return undefined
  }

  if (!safeTokenSignatureMatch(signDigitalOfficeSsoPayload(encodedPayload), signature)) {
    return undefined
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      email?: unknown
      stayLoggedIn?: unknown
      expiresAt?: unknown
    }
    if (typeof payload.email !== 'string' || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
      return undefined
    }
    return {
      email: payload.email.toLowerCase(),
      stayLoggedIn: payload.stayLoggedIn === true,
    }
  } catch {
    return undefined
  }
}

function issueToken(userId: string, stayLoggedIn = false) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      userId,
      expiresAt: Date.now() + (stayLoggedIn ? persistentSessionTtlMs : sessionTtlMs),
    }),
  ).toString('base64url')
  return `v1.${encodedPayload}.${signTokenPayload(encodedPayload)}`
}

function userIdForSignedToken(token: string) {
  const [version, encodedPayload, signature] = token.split('.')
  if (version !== 'v1' || !encodedPayload || !signature) {
    return undefined
  }

  if (!safeTokenSignatureMatch(signTokenPayload(encodedPayload), signature)) {
    return undefined
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      userId?: unknown
      expiresAt?: unknown
    }
    if (typeof payload.userId !== 'string' || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
      return undefined
    }
    return payload.userId
  } catch {
    return undefined
  }
}

function userIdForToken(token: string | undefined) {
  if (!token) {
    return undefined
  }

  const signedUserId = userIdForSignedToken(token)
  if (signedUserId) {
    return signedUserId
  }

  const session = tokens.get(token)
  if (!session) {
    return undefined
  }

  if (session.expiresAt <= Date.now()) {
    tokens.delete(token)
    return undefined
  }

  return session.userId
}

function loginAttemptKey(request: Request, email: string) {
  return `${request.ip ?? 'unknown'}:${email || 'unknown'}`
}

function retrySecondsForLogin(request: Request, email: string) {
  const key = loginAttemptKey(request, email)
  const attempt = loginAttempts.get(key)
  if (!attempt) {
    return 0
  }

  const now = Date.now()
  if (attempt.resetAt <= now) {
    loginAttempts.delete(key)
    return 0
  }

  return attempt.blockedUntil && attempt.blockedUntil > now ? Math.ceil((attempt.blockedUntil - now) / 1000) : 0
}

function recordFailedLogin(request: Request, email: string) {
  const key = loginAttemptKey(request, email)
  const now = Date.now()
  const current = loginAttempts.get(key)
  const attempt = current && current.resetAt > now ? current : { count: 0, resetAt: now + loginRateLimitWindowMs }
  attempt.count += 1
  if (attempt.count >= loginRateLimitMax) {
    attempt.blockedUntil = attempt.resetAt
  }
  loginAttempts.set(key, attempt)
}

function clearFailedLogins(request: Request, email: string) {
  loginAttempts.delete(loginAttemptKey(request, email))
}

function passwordResetAttemptKey(request: Request, email: string) {
  return `${request.ip ?? 'unknown'}:${email || 'unknown'}`
}

function passwordResetAllowed(request: Request, email: string) {
  const key = passwordResetAttemptKey(request, email)
  const now = Date.now()
  const current = passwordResetAttempts.get(key)
  const attempt = current && current.resetAt > now ? current : { count: 0, resetAt: now + passwordResetRateLimitWindowMs }
  if (attempt.blockedUntil && attempt.blockedUntil > now) {
    return false
  }

  attempt.count += 1
  if (attempt.count >= passwordResetRateLimitMax) {
    attempt.blockedUntil = attempt.resetAt
  }
  passwordResetAttempts.set(key, attempt)
  return true
}

async function requireAuth(request: AuthedRequest, response: Response, next: NextFunction) {
  if (coreEnabled()) {
    try {
      const identity = await requireCoreIdentity(request, 'time', { allowPasswordChange: request.path === '/api/state' || request.path === '/api/account/password', ...(request.path === '/api/account/password' ? { write: false } : {}) })
      const user = provisionCoreUser(identity)
      request.user = user
      coreIdentities.set(user.id, identity)
      next()
    } catch (error) {
      response.status(error instanceof CoreAuthError ? error.status : error instanceof DatabaseConflictError ? 409 : 503).json({ message: error instanceof Error ? error.message : 'Authentication unavailable' })
    }
    return
  }
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '')
  const userId = userIdForToken(token)
  const database = readDatabase()
  const user = userId ? database.users.find((candidate) => candidate.id === userId && candidate.active) : undefined

  if (!user) {
    response.status(401).json({ message: 'Authentication required' })
    return
  }

  request.user = user
  if (user.mustChangePassword && request.path !== '/api/state' && request.path !== '/api/account/password') {
    response.status(428).json({ message: 'Password change required' })
    return
  }

  next()
}

function requireAdmin(request: AuthedRequest, response: Response, next: NextFunction) {
  if (request.user?.role !== 'admin') {
    response.status(403).json({ message: 'Admin access required' })
    return
  }

  next()
}

function groupPeerIdsFor(userId: string, groups: CalendarGroup[]) {
  const peerIds = new Set<string>()
  for (const group of groups) {
    if (group.memberUserIds.includes(userId)) {
      group.memberUserIds.forEach((memberId) => peerIds.add(memberId))
    }
  }
  peerIds.delete(userId)
  return peerIds
}

function calendarAccessTargetsFor(user: StoredUser, users: StoredUser[], groups: CalendarGroup[]) {
  if (user.role === 'admin') {
    return users.filter((candidate) => candidate.active && candidate.id !== user.id).map(publicUser)
  }

  const peerIds = groupPeerIdsFor(user.id, groups)
  return users.filter((candidate) => candidate.active && peerIds.has(candidate.id)).map(publicUser)
}

function visibleUsersFor(currentUser: StoredUser, users: StoredUser[], groups: CalendarGroup[]) {
  if (currentUser.role === 'admin') {
    return users.filter((user) => user.active).map(publicUser)
  }

  const peerIds = groupPeerIdsFor(currentUser.id, groups)
  return users
    .filter(
      (user) =>
        user.active && (user.id === currentUser.id || (peerIds.has(user.id) && user.calendarAccessUserIds.includes(currentUser.id))),
    )
    .map(publicUser)
}

function publicCalDavAccount(account: StoredCalDavAccount): CalDavAccount {
  const { password: _password, ...publicAccount } = account
  return {
    ...publicAccount,
    passwordConfigured: account.password.length > 0,
  }
}

function visibleExternalCalendarEventsFor(
  currentUser: StoredUser,
  events: ExternalCalendarEvent[],
  accounts: StoredCalDavAccount[],
  visibleUserIds: Set<string>,
) {
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  return events
    .filter((event) => visibleUserIds.has(event.userId) && accountById.get(event.accountId)?.syncEnabled)
    .map((event) => {
      const account = accountById.get(event.accountId)
      const canSeeTitle = event.userId === currentUser.id || currentUser.role === 'admin' || Boolean(account?.shareEventTitles)
      const visibleEvent = {
        ...event,
        title: canSeeTitle ? event.title : '',
      }
      return event.userId === currentUser.id || currentUser.role === 'admin'
        ? visibleEvent
        : {
            ...visibleEvent,
            accountId: '',
            externalId: '',
            createdAt: '',
            updatedAt: '',
          }
    })
}

function visibleCustomCalendarEventsFor(
  currentUser: StoredUser,
  events: CustomCalendarEvent[],
  visibleUserIds: Set<string>,
) {
  return events
    .filter(
      (event) =>
        event.userId === currentUser.id ||
        currentUser.role === 'admin' ||
        (event.shareWithCalendarUsers && visibleUserIds.has(event.userId)),
    )
    .map((event) =>
      event.userId === currentUser.id || currentUser.role === 'admin'
        ? event
        : {
            ...event,
            description: undefined,
            createdAt: '',
            updatedAt: '',
          },
    )
}

type PublicUser = ReturnType<typeof publicUser>
type PublicAbsence = ReturnType<typeof readDatabase>['absences'][number]
type StateUser = Pick<PublicUser, 'id' | 'name' | 'active'> & Partial<Omit<PublicUser, 'id' | 'name' | 'active'>>

function identityUserForState(user: PublicUser): StateUser {
  return {
    id: user.id,
    name: user.name,
    active: user.active,
  }
}

function adminUserForState(currentUser: StoredUser, user: PublicUser): StateUser {
  if (user.id === currentUser.id) {
    return user
  }

  const { mustChangePassword: _mustChangePassword, ...safeUser } = user
  return safeUser
}

function employeeUserForState(currentUser: StoredUser, user: PublicUser): StateUser {
  if (user.id === currentUser.id) {
    return user
  }

  return identityUserForState(user)
}

function calendarUserForState(user: PublicUser): StateUser {
  return {
    id: user.id,
    name: user.name,
    active: user.active,
  }
}

function stateUserFor(currentUser: StoredUser, user: PublicUser): PublicUser {
  return (currentUser.role === 'admin' ? adminUserForState(currentUser, user) : employeeUserForState(currentUser, user)) as PublicUser
}

function stateUsersFor(currentUser: StoredUser, users: PublicUser[]) {
  return users.map((user) => stateUserFor(currentUser, user))
}

function calendarUsersForState(users: PublicUser[]) {
  return users.map(calendarUserForState) as PublicUser[]
}

function visibleAbsencesFor(currentUser: StoredUser, absences: PublicAbsence[], visibleUserIds: Set<string>) {
  const visibleAbsenceTypes = new Set(['vacation', 'overtime_time_off'])
  return absences
    .filter((absence) => {
      if (!visibleUserIds.has(absence.userId)) {
        return false
      }
      if (currentUser.role === 'admin' || absence.userId === currentUser.id) {
        return true
      }
      return visibleAbsenceTypes.has(absence.type)
    })
    .map((absence) =>
      currentUser.role === 'admin' || absence.userId === currentUser.id
        ? absence
        : {
            ...absence,
            requestId: undefined,
            label: absence.type === 'vacation' ? 'Vacation' : 'Unavailable',
          },
    )
}

function visibleCalendarGroupsFor(currentUser: StoredUser, groups: CalendarGroup[]) {
  if (currentUser.role === 'admin') {
    return groups
  }

  return []
}

function visibleHolidayTemplateOptionsFor(currentUser: StoredUser, settings: ReturnType<typeof normalizeHolidaySettings>) {
  if (currentUser.role === 'admin') {
    return holidayTemplateOptions(settings)
  }

  return { countries: [], states: [], regions: [] }
}

function visibleBackupInfoFor(currentUser: StoredUser) {
  if (currentUser.role === 'admin') {
    return backupInfo()
  }

  return { dataFile: '', backupDir: '', nextAutomaticCheck: '' }
}

function addHolidayYear(years: Set<number>, dateKey: string | undefined) {
  if (dateKey && isSensibleDateKey(dateKey)) {
    years.add(Number(dateKey.slice(0, 4)))
  }
}

function holidayYearsForState(currentUser: StoredUser, database: ReturnType<typeof readDatabase>) {
  const years = new Set(currentHolidayYears())
  const scopedUserIds =
    currentUser.role === 'admin' ? new Set(database.users.map((user) => user.id)) : new Set([currentUser.id])

  database.timeEntries.forEach((entry) => {
    if (scopedUserIds.has(entry.userId)) {
      addHolidayYear(years, entry.date)
    }
  })
  database.absences.forEach((absence) => {
    if (scopedUserIds.has(absence.userId)) {
      addHolidayYear(years, absence.date)
    }
  })
  database.requests.forEach((item) => {
    if (scopedUserIds.has(item.userId)) {
      addHolidayYear(years, item.startDate)
      addHolidayYear(years, item.endDate)
      addHolidayYear(years, item.correctionDate)
    }
  })
  database.users.forEach((user) => {
    if (!scopedUserIds.has(user.id)) {
      return
    }
    addHolidayYear(years, user.trackingStartDate)
    user.employmentTerms.forEach((term) => addHolidayYear(years, term.effectiveFrom))
  })

  return [...years].sort((left, right) => left - right)
}

function elapsedMinutesUntil(entry: TimeEntry, timestamp: string) {
  return Math.max(0, Math.round((new Date(timestamp).getTime() - new Date(entry.startedAt).getTime()) / 60000))
}

function trackedBreakMinutesUntil(entry: TimeEntry, timestamp: string) {
  return Math.round(
    entry.breaks.reduce((total, segment) => {
      const stoppedAt = segment.stoppedAt ?? timestamp
      return total + Math.max(0, (new Date(stoppedAt).getTime() - new Date(segment.startedAt).getTime()) / 60000)
    }, 0),
  )
}

function appendTimeEntryNote(entry: TimeEntry, note: string) {
  entry.note = entry.note ? `${entry.note}\n${note}` : note
}

function autoClockOutOverlongEntries(database: ReturnType<typeof readDatabase>, timestamp = nowIso()) {
  const closedEntries: TimeEntry[] = []

  for (const entry of database.timeEntries) {
    if (entry.stoppedAt) {
      continue
    }

    const elapsedMinutes = elapsedMinutesUntil(entry, timestamp)
    if (elapsedMinutes <= automaticClockOutAfterMinutes) {
      continue
    }

    const user = database.users.find((candidate) => candidate.id === entry.userId && candidate.active)
    if (!user) {
      continue
    }

    entry.breaks.forEach((segment) => {
      segment.stoppedAt ||= timestamp
    })

    const trackedBreakMinutes = trackedBreakMinutesUntil(entry, timestamp)
    const manualBreakMinutesForZeroWork = Math.max(0, elapsedMinutes - trackedBreakMinutes)
    entry.stoppedAt = timestamp
    entry.manualBreakMinutes = Math.max(entry.manualBreakMinutes ?? 0, manualBreakMinutesForZeroWork)
    entry.updatedAt = timestamp
    appendTimeEntryNote(
      entry,
      `Automatically clocked out after running for more than ${automaticClockOutAfterMinutes / 60} hours. This entry counts as 0 hours until corrected.`,
    )

    addNotification(
      database,
      user.id,
      'Arbeitszeit automatisch beendet',
      'Der Timer lief länger als 13 Stunden. Der Eintrag zählt mit 0 Stunden, bis du eine Zeitkorrektur beantragst. / Timer ran for more than 13 hours. The entry counts as 0 hours until corrected.',
      'time',
      entry.id,
    )
    addAudit(database, 'system', 'auto_clock_out_over_13h', 'time_entry', entry.id, {
      userId: user.id,
      elapsedMinutes,
      stoppedAt: timestamp,
      manualBreakMinutes: entry.manualBreakMinutes,
    })
    closedEntries.push(entry)
  }

  return closedEntries
}

function enforceAutomaticClockOuts() {
  const database = readDatabase()
  const closedEntries = autoClockOutOverlongEntries(database)
  if (closedEntries.length === 0) {
    return []
  }

  saveDatabase(database)
  return closedEntries
}

function stateForUser(currentUser: StoredUser) {
  // Password onboarding needs identity only. Return before any business reads or automatic clock changes.
  if (currentUser.mustChangePassword) {
    const user = {
      id: currentUser.id, name: currentUser.name, email: currentUser.email, role: currentUser.role,
      active: currentUser.active, mustChangePassword: true,
      expectedWeeklyMinutes: 0, yearlyVacationDays: 0, balanceAdjustmentMinutes: 0, vacationAdjustmentDays: 0,
      trackingStartDate: '', employmentTerms: [], calendarAccessUserIds: [],
    }
    return {
      currentUser: user, organizationTimezone, coreManaged: coreEnabled(), readOnly: true,
      users: [user], visibleCalendarUsers: [], shareableCalendarUsers: [], calendarGroups: [], calDavAccounts: [],
      externalCalendarEvents: [], customCalendarEvents: [], timeEntries: [], adminTimeEntries: [], absences: [],
      holidays: [], holidayOverrides: [], holidaySettings: { country: '', language: '' },
      holidayTemplateOptions: { countries: [], states: [], regions: [] }, requests: [], notifications: [],
      importBatches: [], userInvitations: [], backup: { dataFile: '', backupDir: '', nextAutomaticCheck: '' },
      summaries: [], clockStatus: 'off_work' as const, clockStatuses: {}, clockLocations: {}, dayIssues: [],
    }
  }
  const database = readDatabase()
  const closedEntries = autoClockOutOverlongEntries(database)
  if (closedEntries.length > 0) {
    saveDatabase(database)
  }
  const activeUsers = database.users.filter((user) => user.active)
  const rawVisibleCalendarUsers = visibleUsersFor(currentUser, database.users, database.calendarGroups)
  const rawShareableCalendarUsers = calendarAccessTargetsFor(currentUser, database.users, database.calendarGroups)
  const publicUsers =
    currentUser.role === 'admin'
      ? activeUsers.map(publicUser)
      : [
          ...new Map(
            [publicUser(currentUser), ...rawVisibleCalendarUsers, ...rawShareableCalendarUsers].map((user) => [user.id, user]),
          ).values(),
        ]
  const visibleCalendarUsers = calendarUsersForState(rawVisibleCalendarUsers)
  // Contact details are only exposed for recipients eligible for personal sharing.
  const shareableCalendarUsers = rawShareableCalendarUsers.map(user => ({ ...calendarUserForState(user), email: user.email })) as PublicUser[]
  const users = stateUsersFor(currentUser, publicUsers)
  const visibleIds = new Set(rawVisibleCalendarUsers.map((user) => user.id))
  const clockStatuses = Object.fromEntries(
    rawVisibleCalendarUsers.map((user) => [user.id, clockStatusForUser(database.timeEntries, user.id)]),
  )
  const clockLocations = Object.fromEntries(
    rawVisibleCalendarUsers.map((user) => [user.id, openEntryForUser(database.timeEntries, user.id)?.workLocation]),
  )
  const holidays = holidaysForYears(holidayYearsForState(currentUser, database), database.holidayOverrides, database.holidaySettings)
  const requestScope =
    currentUser.role === 'admin'
      ? database.requests
      : database.requests.filter((request) => request.userId === currentUser.id)
  const summaryUsers = currentUser.role === 'admin' ? activeUsers.map(publicUser) : [publicUser(currentUser)]
  const issueUsers = currentUser.role === 'admin' ? activeUsers.map(publicUser) : [publicUser(currentUser)]
  const accountingContexts: ZeitguruAccountingContexts = {}
  const projectedEntries = summaryUsers.flatMap(user => {
    const projection = zeitguruAccounting?.projection(user.id, database.timeEntries)
    if (projection?.accounting) accountingContexts[user.id] = projection.accounting
    return projection?.entries ?? []
  })
  const accountingEntries = [...database.timeEntries, ...projectedEntries]

  return {
    currentUser: publicUser(currentUser),
    ...(zeitguru ? { zeitguru: zeitguruState(currentUser.id, database) } : {}),
    organizationTimezone,
    coreManaged: coreEnabled(),
    readOnly: coreEnabled() ? coreIdentities.get(currentUser.id)?.readOnly : false,
    users,
    visibleCalendarUsers,
    shareableCalendarUsers,
    calendarGroups: visibleCalendarGroupsFor(currentUser, database.calendarGroups),
    calDavAccounts: database.calDavAccounts
      .filter((account) => account.userId === currentUser.id)
      .map(publicCalDavAccount),
    externalCalendarEvents: visibleExternalCalendarEventsFor(
      currentUser,
      database.externalCalendarEvents,
      database.calDavAccounts,
      visibleIds,
    ),
    customCalendarEvents: visibleCustomCalendarEventsFor(currentUser, database.customCalendarEvents, visibleIds),
    timeEntries: accountingEntries.filter((entry) => entry.userId === currentUser.id),
    adminTimeEntries: currentUser.role === 'admin' ? accountingEntries : undefined,
    zeitguruAccounting: accountingContexts,
    absences: visibleAbsencesFor(currentUser, database.absences, visibleIds),
    holidays,
    holidayOverrides: currentUser.role === 'admin' ? database.holidayOverrides : undefined,
    holidaySettings: currentUser.role === 'admin' ? database.holidaySettings : undefined,
    holidayTemplateOptions: currentUser.role === 'admin' ? visibleHolidayTemplateOptionsFor(currentUser, database.holidaySettings) : undefined,
    requests: requestScope,
    notifications: database.notifications.filter((notification) => notification.userId === currentUser.id),
    importBatches: currentUser.role === 'admin' ? database.importBatches : undefined,
    userInvitations:
      currentUser.role === 'admin'
        ? database.userInvitations.filter((invitation) => !invitation.acceptedAt).map(publicInvitation)
        : undefined,
    backup: currentUser.role === 'admin' ? visibleBackupInfoFor(currentUser) : undefined,
    mailServerSettings: currentUser.role === 'admin' ? publicMailServerSettings(database.mailServerSettings) : undefined,
    overtimePolicy: currentUser.role === 'admin' ? {...overtimePolicies.status(),mailConfigured:mailServerConfigured(database)} : undefined,
    licenseState: !coreEnabled() && currentUser.role === 'admin' ? licenseStateForDatabase(database) : undefined,
    summaries: summariesForUsers(summaryUsers, accountingEntries, database.absences, holidays, database.requests, accountingContexts),
    clockStatus: clockStatusForUser(database.timeEntries, currentUser.id),
    clockStatuses,
    clockLocations,
    todayEntry: openEntryForUser(database.timeEntries, currentUser.id),
    dayIssues: dayIssuesForUsers(issueUsers, accountingEntries, database.absences, holidays, new Date(), accountingContexts),
    serverTime: new Date().toISOString(),
  }
}

function zeitguruState(userId: string, database = readDatabase()) {
  const status = zeitguru!.status(userId)
  if (status.enabled && !status.counts.queued && !status.counts.sending && database.timeEntries.some(entry => {
    if (entry.userId !== userId || !entry.stoppedAt) return false
    const checkpoint = zeitguru!.journal.lastConfirmedRow(userId, entry.id)
    return checkpoint && !checkpoint.endTime
  })) {
    status.requiresAttention = true
    status.message = 'DCO ended or changed a shift outside the normal clock buttons. Check and finish that shift in Zeitguru, then complete the manual review. / DCO hat einen Eintrag außerhalb der Stempeltasten beendet oder geändert. Bitte in Zeitguru prüfen und anschließend die manuelle Prüfung bestätigen.'
  }
  return status
}

function sendLiveMessage(socket: WebSocket, message: unknown) {
  if (socket.readyState !== WebSocket.OPEN) {
    return
  }

  try {
    socket.send(JSON.stringify(message))
  } catch {
    socket.close(1011, 'Could not send live update')
  }
}

async function sendStateToLiveClient(socket: WebSocket, userId: string) {
  if (coreEnabled()) {
    try {
      const coreRequest = liveCoreRequests.get(socket)
      if (!coreRequest) throw new Error('Session missing')
      const identity = await requireCoreIdentity(coreRequest, 'time', { write: false })
      const user = provisionCoreUser(identity)
      if (user.id !== userId) throw new Error('Session changed')
      coreIdentities.set(user.id, identity)
      sendLiveMessage(socket, { type: 'state', payload: stateForUser(user) })
    } catch {
      liveClients.delete(socket)
      liveCoreRequests.delete(socket)
      socket.close(1008, 'Session expired or access changed')
    }
    return
  }
  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.id === userId && candidate.active)
  if (!user) {
    liveClients.delete(socket)
    socket.close(1008, 'User no longer active')
    return
  }

  sendLiveMessage(socket, { type: 'state', payload: stateForUser(user) })
}

function broadcastLiveState() {
  for (const [socket, client] of liveClients) {
    sendStateToLiveClient(socket, client.userId)
  }
}

function scheduleLiveStateBroadcast() {
  if (liveClients.size === 0 || liveBroadcastTimer) {
    return
  }

  liveBroadcastTimer = setTimeout(() => {
    liveBroadcastTimer = undefined
    broadcastLiveState()
  }, 25)
}

function saveDatabase(database: ReturnType<typeof readDatabase>) {
  writeDatabase(database)
  scheduleLiveStateBroadcast()
}

async function authenticateLiveSocket(socket: WebSocket, token: string, incoming: IncomingMessage) {
  if (coreEnabled()) {
    const request: CoreRequest = { method: 'GET', header(name) { const value = incoming.headers[name.toLowerCase()]; return name.toLowerCase() === 'authorization' ? 'Bearer ' + token : Array.isArray(value) ? value.join('; ') : value } }
    try {
      const identity = await requireCoreIdentity(request, 'time', { write: false })
      const user = provisionCoreUser(identity)
      coreIdentities.set(user.id, identity)
      liveCoreRequests.set(socket, request)
      liveClients.set(socket, { userId: user.id })
      await sendStateToLiveClient(socket, user.id)
    } catch { socket.close(1008, 'Session expired or access changed') }
    return
  }
  const userId = userIdForToken(token)
  const database = readDatabase()
  const user = userId ? database.users.find((candidate) => candidate.id === userId && candidate.active) : undefined
  if (!user) {
    socket.close(1008, 'Session expired')
    return
  }

  liveClients.set(socket, { userId: user.id })
  sendStateToLiveClient(socket, user.id)
}

function parseLiveMessage(message: RawData) {
  try {
    return JSON.parse(message.toString()) as { type?: string; token?: string }
  } catch {
    return undefined
  }
}

function handleLiveSocket(socket: WebSocket, incoming: IncomingMessage) {
  let authenticated = false
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      socket.close(1008, 'Authentication required')
    }
  }, 5000)

  socket.on('message', (rawMessage) => {
    const message = parseLiveMessage(rawMessage)
    if (!authenticated) {
      if (message?.type !== 'auth' || !message.token) {
        socket.close(1008, 'Authentication required')
        return
      }

      authenticated = true
      clearTimeout(authTimer)
      void authenticateLiveSocket(socket, message.token, incoming)
      return
    }

    if (message?.type === 'refresh') {
      const client = liveClients.get(socket)
      if (client) {
        sendStateToLiveClient(socket, client.userId)
      }
    }
  })

  socket.on('close', () => {
    clearTimeout(authTimer)
    liveClients.delete(socket)
    liveCoreRequests.delete(socket)
  })

  socket.on('error', () => {
    clearTimeout(authTimer)
    liveClients.delete(socket)
  })
}

liveServer.on('connection', handleLiveSocket)

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const origin = normalizeOrigin(request.headers.origin)
  const allowedOrigin =
    !origin || configuredCorsOrigins().has(origin) || originMatchesRequestHost(origin, request.headers.host)
  if (!url.pathname.endsWith('/api/live') || !allowedOrigin) {
    socket.destroy()
    return
  }

  liveServer.handleUpgrade(request, socket, head, (webSocket) => {
    liveServer.emit('connection', webSocket, request)
  })
})

function parseString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseDateKeyInput(value: unknown, fallback = toDateKey(new Date())) {
  const date = parseString(value)
  return isValidDateKey(date) ? date : fallback
}

function parseRequiredDateKey(value: unknown) {
  const date = parseString(value)
  return isValidDateKey(date) ? date : ''
}

function parseSensibleDateKey(value: unknown) {
  const date = parseString(value)
  return isSensibleDateKey(date) ? date : ''
}

function sensibleDateError(field: string) {
  const bounds = sensibleDateBounds()
  return `${field} must be between ${bounds.min} and ${bounds.max}.`
}

function assertSensibleDateKey(value: string | undefined, field: string) {
  if (!value || !isSensibleDateKey(value)) {
    throw new Error(sensibleDateError(field))
  }
}

function parseTimeInput(value: unknown) {
  const time = parseString(value)
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : ''
}

function parseRole(value: unknown): Role {
  return value === 'admin' ? 'admin' : 'employee'
}

function parseMinutes(value: unknown) {
  const minutes = Number(value)
  return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0
}

function parseWorkLocation(value: unknown): WorkLocation | undefined {
  const location = parseString(value)
  const allowed: WorkLocation[] = ['office', 'homeoffice', 'remote', 'customer', 'business_trip']
  return allowed.find((item) => item === location)
}

function pendingRequestFromBody(body: Record<string, unknown>, userId: string, id: string, createdAt: string): RequestItem {
  const type = validateRequestType(body.type)
  if (!type) {
    throw new Error('Unsupported request type')
  }

  const doctorNote = type === 'sick_leave' || type === 'child_sick_leave' ? parseDoctorNoteUpload(body) : {}
  const item: RequestItem = {
    id,
    userId,
    type,
    status: 'pending',
    startDate: type === 'time_correction' ? undefined : parseString(body.startDate) || undefined,
    endDate: type === 'time_correction' ? undefined : parseString(body.endDate) || undefined,
    minutes: type === 'overtime_payout' ? parseMinutes(body.minutes) || undefined : undefined,
    correctionDate: type === 'time_correction' ? parseString(body.correctionDate) || undefined : undefined,
    proposedStartTime: type === 'time_correction' ? parseString(body.proposedStartTime) || undefined : undefined,
    proposedEndTime: type === 'time_correction' ? parseString(body.proposedEndTime) || undefined : undefined,
    proposedBreakMinutes: type === 'time_correction' ? parseMinutes(body.proposedBreakMinutes) : undefined,
    customTitle: type === 'custom' ? parseString(body.customTitle) : undefined,
    doctorNoteName: doctorNote.doctorNoteName,
    doctorNoteDataUrl: doctorNote.doctorNoteDataUrl,
    reason: parseString(body.reason),
    createdAt,
  }

  assertRequestDateRange(item)
  if (item.type === 'time_correction') validateTimeCorrection(item)
  if (item.type === 'overtime_payout' && (!Number.isSafeInteger(item.minutes) || Number(item.minutes) <= 0)) {
    throw new Error('Payout minutes must be a positive whole number')
  }
  return item
}

function parsePercent(value: unknown, fallback = 100) {
  const percent = Number(value)
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : fallback
}

function parseBoolean(value: unknown) {
  return value === true || value === 'true' || value === '1' || value === 1
}

function parseHttpsUrl(value: unknown) {
  const raw = parseString(value)
  if (!raw) {
    return ''
  }
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.toString().replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

function privateCalDavUrlsAllowed() {
  return process.env.ALLOW_PRIVATE_CALDAV_URLS === 'true'
}

function isPrivateIpAddress(address: string) {
  if (isIP(address) === 4) {
    const [first = 0, second = 0] = address.split('.').map((part) => Number(part))
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
    if (mappedIpv4) {
      return isPrivateIpAddress(mappedIpv4[1])
    }

    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80')
    )
  }

  return false
}

function isBlockedLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'metadata.google.internal' ||
    isPrivateIpAddress(normalized)
  )
}

async function assertAllowedCalDavUrl(urlString: string) {
  if (privateCalDavUrlsAllowed()) {
    return
  }

  const url = new URL(urlString)
  if (isBlockedLocalHostname(url.hostname)) {
    throw new Error('CalDAV URLs must not point to local or private network addresses.')
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('CalDAV host could not be resolved.')
  }
  if (addresses.some((address) => isPrivateIpAddress(address.address))) {
    throw new Error('CalDAV URLs must resolve to public addresses unless ALLOW_PRIVATE_CALDAV_URLS=true is set.')
  }
}

function parseExportPeriod(value: unknown): TimeExportPeriod {
  const period = parseString(value)
  return period === 'day' || period === 'week' || period === 'month' || period === 'year' || period === 'all'
    ? period
    : 'month'
}

function parseExportLanguage(value: unknown): TimeExportLanguage {
  return parseString(value) === 'de' ? 'de' : 'en'
}

function parseCalendarExportLanguage(value: unknown): CalendarExportLanguage {
  return parseString(value) === 'de' ? 'de' : 'en'
}

function parseCalendarExportMode(value: unknown): CalendarExportMode {
  const mode = parseString(value)
  return mode === 'day' || mode === 'week' || mode === 'month' ? mode : 'month'
}

function calendarExportRange(mode: CalendarExportMode, dateKey: string) {
  if (mode === 'day') {
    return [dateKey, dateKey] as const
  }
  const reference = parseDateKey(dateKey)
  if (mode === 'week') {
    return clampDateRange(startOfWeek(reference), endOfWeek(reference))
  }
  return clampDateRange(startOfMonth(reference), endOfMonth(reference))
}

function parseUserIds(value: unknown, users: StoredUser[], excludedUserId?: string) {
  const activeUserIds = new Set(users.filter((user) => user.active && user.id !== excludedUserId).map((user) => user.id))
  const ids = Array.isArray(value) ? value.filter((id: unknown): id is string => typeof id === 'string') : []
  return [...new Set(ids.filter((id) => activeUserIds.has(id)))]
}

function validateRequestType(value: unknown): RequestType | undefined {
  const allowed: RequestType[] = [
    'vacation',
    'overtime_payout',
    'overtime_time_off',
    'time_correction',
    'sick_leave',
    'child_sick_leave',
    'custom',
  ]
  return allowed.find((type) => type === value)
}

const doctorNoteMediaTypes: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function sanitizeUploadName(value: string, fallbackExtension: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return cleaned || `doctor-note.${fallbackExtension}`
}

function parseDoctorNoteUpload(body: Record<string, unknown>): { doctorNoteName?: string; doctorNoteDataUrl?: string } {
  const rawName = parseString(body.doctorNoteName)
  const dataUrl = parseString(body.doctorNoteDataUrl)
  if (!rawName && !dataUrl) {
    return {}
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) {
    throw new Error('Doctor notes must be uploaded as PDF, PNG, JPG, or WebP files.')
  }

  const mediaType = match[1].toLowerCase()
  const extension = doctorNoteMediaTypes[mediaType]
  if (!extension) {
    throw new Error('Doctor notes must be PDF, PNG, JPG, or WebP files. SVG and other active formats are not allowed.')
  }

  const bytes = Buffer.byteLength(match[2], 'base64')
  if (bytes > doctorNoteMaxBytes) {
    throw new Error(`Doctor notes must be smaller than ${Math.round(doctorNoteMaxBytes / 1024 / 1024)} MB.`)
  }

  return {
    doctorNoteName: sanitizeUploadName(rawName, extension),
    doctorNoteDataUrl: dataUrl,
  }
}

function assertRequestDateRange(request: RequestItem) {
  if (
    (request.type === 'vacation' ||
      request.type === 'overtime_time_off' ||
      request.type === 'sick_leave' ||
      request.type === 'child_sick_leave') &&
    (!request.startDate || !request.endDate)
  ) {
    throw new Error('A start and end date are required')
  }
  if (request.startDate && request.endDate && request.startDate > request.endDate) {
    throw new Error('The end date cannot be before the start date')
  }
  if (request.type === 'custom' && !request.customTitle?.trim()) {
    throw new Error('A subject is required for custom requests')
  }
  if (request.startDate) {
    assertSensibleDateKey(request.startDate, 'Start date')
  }
  if (request.endDate) {
    assertSensibleDateKey(request.endDate, 'End date')
  }
  if (request.startDate && request.endDate) {
    const rangeDays = Math.floor((parseDateKey(request.endDate).getTime() - parseDateKey(request.startDate).getTime()) / 86_400_000) + 1
    if (rangeDays > maxRequestRangeDays) {
      throw new Error(`Request range cannot be longer than ${maxRequestRangeDays} days.`)
    }
  }
  if (request.correctionDate) {
    assertSensibleDateKey(request.correctionDate, 'Correction date')
  }
}

function displayUserName(user: StoredUser) {
  const trailingRole = user.role === 'employee' ? /\s+(Employee|Mitarbeiter)$/i : /\s+(Admin|Administrator)$/i
  const cleanedName = user.name.replace(trailingRole, '').trim()
  return cleanedName || user.name
}

function requestTypeLabel(type: RequestType) {
  const labels: Record<RequestType, string> = {
    vacation: 'Vacation',
    overtime_payout: 'Overtime payout',
    overtime_time_off: 'Overtime time off',
    time_correction: 'Time correction',
    sick_leave: 'Sick leave',
    child_sick_leave: 'Child sick leave',
    custom: 'Custom request',
  }
  return labels[type]
}

function requestStatusLabel(status: RequestStatus) {
  return status[0].toUpperCase() + status.slice(1)
}

function responsibleAdminsFor(database: ReturnType<typeof readDatabase>, employee: StoredUser) {
  const assignedAdmin = employee.responsibleAdminUserId
    ? database.users.find((user) => user.id === employee.responsibleAdminUserId && user.role === 'admin' && user.active)
    : undefined

  return assignedAdmin ? [assignedAdmin] : adminUsers(database)
}

function appBaseUrlFor(request: Request) {
  const configured = process.env.APP_BASE_URL?.trim()
  if (configured) {
    return configured.replace(/\/+$/, '')
  }

  const origin = request.get('origin')
  if (origin) {
    return origin.replace(/\/+$/, '')
  }

  return `${request.protocol}://${request.get('host')}`.replace(/\/+$/, '')
}

function requestLink(baseUrl: string, requestId: string) {
  return `${baseUrl}/requests?request=${encodeURIComponent(requestId)}`
}

function invitationTokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function publicInvitation(invitation: ReturnType<typeof readDatabase>['userInvitations'][number]): UserInvitation {
  return {
    id: invitation.id,
    userId: invitation.userId,
    email: invitation.email,
    role: invitation.role,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
  }
}

function publicMailServerSettings(settings: ReturnType<typeof readDatabase>['mailServerSettings']): MailServerSettings | undefined {
  if (!settings) {
    return undefined
  }

  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    fromAddress: settings.fromAddress,
    passwordConfigured: settings.password.length > 0,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  }
}

function invitationLink(baseUrl: string, token: string) {
  return `${baseUrl}/invite/${encodeURIComponent(token)}`
}

function invitationIsUsable(invitation: ReturnType<typeof readDatabase>['userInvitations'][number] | undefined) {
  return Boolean(invitation && !invitation.acceptedAt && new Date(invitation.expiresAt).getTime() >= Date.now())
}

function passwordResetLink(baseUrl: string, token: string) {
  return `${baseUrl}/?reset=${encodeURIComponent(token)}`
}

function passwordResetIsUsable(resetToken: ReturnType<typeof readDatabase>['passwordResetTokens'][number] | undefined) {
  return Boolean(resetToken && !resetToken.usedAt && new Date(resetToken.expiresAt).getTime() >= Date.now())
}

function requestDetailLines(request: RequestItem, employee: StoredUser) {
  const lines = [
    `Employee: ${displayUserName(employee)} <${employee.email}>`,
    `Type: ${requestTypeLabel(request.type)}`,
    `Status: ${requestStatusLabel(request.status)}`,
    `Submitted: ${request.createdAt}`,
  ]

  if (request.startDate || request.endDate) {
    lines.push(`Date range: ${request.startDate ?? '-'} to ${request.endDate ?? '-'}`)
  }

  if (request.customTitle) {
    lines.push(`Subject: ${request.customTitle}`)
  }

  if (request.minutes) {
    lines.push(`Time amount: ${formatDecimalHours(request.minutes)} hours`)
  }

  if (request.correctionDate || request.proposedStartTime || request.proposedEndTime) {
    lines.push(
      `Correction: ${request.correctionDate ?? '-'}, ${request.proposedStartTime ?? '-'} to ${request.proposedEndTime ?? '-'}, break ${request.proposedBreakMinutes ?? 0} minutes`,
    )
  }

  if (request.doctorNoteName) {
    lines.push(`Doctor note: attached (${request.doctorNoteName})`)
  } else if (request.type === 'sick_leave' || request.type === 'child_sick_leave') {
    lines.push('Doctor note: not attached')
  }

  lines.push(`Reason: ${request.reason || '-'}`)
  return lines
}

function notifyAdminsForRequest(
  database: ReturnType<typeof readDatabase>,
  request: RequestItem,
  user: StoredUser,
  baseUrl: string,
  mode: 'created' | 'updated' = 'created',
) {
  const admins = responsibleAdminsFor(database, user)
  const title = mode === 'updated' ? 'Request updated' : 'New request'
  const userName = displayUserName(user)
  const typeLabel = requestTypeLabel(request.type)
  const link = requestLink(baseUrl, request.id)
  const message =
    mode === 'updated'
      ? `${userName} updated a pending ${typeLabel.toLowerCase()} request.`
      : `${userName} submitted a ${typeLabel.toLowerCase()} request.`
  for (const admin of admins) {
    addNotification(database, admin.id, title, message, 'request', request.id)
  }

  void sendEmail(
    database,
    admins,
    mode === 'updated'
      ? `Updated request: ${typeLabel} request from ${userName}`
      : `Approval needed: ${typeLabel} request from ${userName}`,
    [
      mode === 'updated' ? 'A pending request was updated and needs your review.' : 'A new request needs your review.',
      '',
      ...requestDetailLines(request, user),
      '',
      `Review link: ${link}`,
      '',
      'Open the link while logged in with an admin account. The link does not grant access by itself.',
    ].join('\n'),
  ).catch((error) => {
    console.warn(`[mail:request-admin] request ${request.id} was saved, but email delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  })
}

function notifyEmployeeForDecision(
  database: ReturnType<typeof readDatabase>,
  request: RequestItem,
  employee: StoredUser,
  admin: StoredUser,
  baseUrl: string,
) {
  const typeLabel = requestTypeLabel(request.type)
  const decision = requestStatusLabel(request.status)
  const link = requestLink(baseUrl, request.id)

  addNotification(
    database,
    employee.id,
    `Request ${request.status}`,
    `Your ${typeLabel.toLowerCase()} request was ${request.status}.`,
    'request',
    request.id,
  )

  void sendEmail(
    database,
    [employee],
    `Your ${typeLabel} request was ${request.status}`,
    [
      `Your request was ${decision.toLowerCase()}.`,
      '',
      ...requestDetailLines(request, employee),
      `Decided by: ${displayUserName(admin)} <${admin.email}>`,
      `Decided at: ${request.decidedAt ?? '-'}`,
      `Admin note: ${request.adminNote || '-'}`,
      '',
      `View link: ${link}`,
    ].join('\n'),
  ).catch((error) => {
    console.warn(`[mail:request-decision] request ${request.id} decision was saved, but email delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  })
}

function notifyEmployeeForUndo(
  database: ReturnType<typeof readDatabase>,
  request: RequestItem,
  employee: StoredUser,
  admin: StoredUser,
  baseUrl: string,
) {
  const typeLabel = requestTypeLabel(request.type)
  const link = requestLink(baseUrl, request.id)

  addNotification(
    database,
    employee.id,
    'Approval undone',
    `The approval for your ${typeLabel.toLowerCase()} request was undone.`,
    'request',
    request.id,
  )

  void sendEmail(
    database,
    [employee],
    `Approval undone: ${typeLabel} request`,
    [
      `The approval for your ${typeLabel.toLowerCase()} request was undone.`,
      '',
      ...requestDetailLines(request, employee),
      `Undone by: ${displayUserName(admin)} <${admin.email}>`,
      `Undone at: ${request.undoneAt ?? '-'}`,
      '',
      `View link: ${link}`,
    ].join('\n'),
  ).catch((error) => {
    console.warn(`[mail:request-undo] request ${request.id} undo was saved, but email delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  })
}

// Account and license ownership belongs to Core in a suite deployment.
app.use((request, response, next) => {
  if (coreEnabled() && (/^\/api\/(?:invitations(?:\/|$)|admin\/invitations(?:\/|$)|settings\/license$)/.test(request.path) || /^\/api\/password-reset\/(?!request$)/.test(request.path) || (request.method === 'DELETE' && /^\/api\/users\/[^/]+$/.test(request.path)))) {
    response.status(409).json({ message: 'Manage accounts and licenses in Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' })
    return
  }
  next()
})

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    dataFile: dataFilePath(),
    backup: backupInfo(),
  })
})

app.get('/api/sso/session', async (request, response) => {
  if (coreEnabled()) {
    const identity = await requireCoreIdentity(request, 'time', { write: false, allowPasswordChange: true })
    const user = provisionCoreUser(identity)
    coreIdentities.set(user.id, identity)
    response.json({ token: 'core-cookie-session', stayLoggedIn: false })
    return
  }
  const sso = digitalOfficeSsoForRequest(request)
  const database = readDatabase()
  const user = sso ? database.users.find((candidate) => candidate.email.toLowerCase() === sso.email && candidate.active) : undefined
  if (!sso || !user) {
    response.status(401).json({ message: 'Sign in to continue.' })
    return
  }

  response.json({ token: issueToken(user.id, sso.stayLoggedIn), stayLoggedIn: sso.stayLoggedIn })
})

app.post('/api/sso/promote', requireAuth, (request: AuthedRequest, response) => {
  if (!coreEnabled()) response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, request.user!, parseBoolean(request.body?.stayLoggedIn)))
  response.status(204).end()
})

app.post('/api/logout', async (request, response) => {
  if (coreEnabled()) {
    await logoutFromCore(request)
    response.setHeader('Set-Cookie', [coreSessionCookie(request, ''), clearDigitalOfficeSsoCookie(request)])
    response.status(204).end()
    return
  }
  response.setHeader('Set-Cookie', clearDigitalOfficeSsoCookie(request))
  response.status(204).end()
})

app.post('/api/login', async (request, response) => {
  if (coreEnabled()) {
    const stayLoggedIn = parseBoolean(request.body.stayLoggedIn)
    const login = await loginWithCore(request, request.body.email, request.body.password, stayLoggedIn)
    if (request.body.clientType === 'native' && coreCookieTokenForRequest(request) === undefined) {
      response.json({ token: login.sessionToken })
    } else {
      response.setHeader('Set-Cookie', coreSessionCookie(request, login.sessionToken, stayLoggedIn))
      response.json({ token: 'core-cookie-session' })
    }
    return
  }
  if (process.env.DISABLE_LOCAL_WEB_LOGIN === 'true') {
    response.status(409).json({
      message: 'Sign in through Digital Core Office.',
      loginUrl: process.env.DCO_CORE_LOGIN_URL || '/',
    })
    return
  }
  const email = parseString(request.body.email).toLowerCase()
  const password = parseString(request.body.password)
  const stayLoggedIn = parseBoolean(request.body.stayLoggedIn)

  const retryAfter = retrySecondsForLogin(request, email)
  if (retryAfter > 0) {
    response.setHeader('Retry-After', String(retryAfter))
    response.status(429).json({ message: 'Too many login attempts. Please try again later.' })
    return
  }

  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.email.toLowerCase() === email && candidate.active)

  if (!user || !verifyPassword(user, password)) {
    recordFailedLogin(request, email)
    response.status(401).json({ message: 'Invalid email or password' })
    return
  }

  clearFailedLogins(request, email)
  const loginDate = toDateKey(new Date())
  if (!user.trackingStartDate || user.trackingStartDate > loginDate) {
    user.trackingStartDate = loginDate
  }
  const token = issueToken(user.id, stayLoggedIn)
  addAudit(database, user.id, 'login', 'user', user.id, { stayLoggedIn })
  saveDatabase(database)
  response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, user, stayLoggedIn))
  response.json({ token })
})

app.post('/api/register', (_request, response) => {
  response.status(403).json({ message: 'Registration requires an invitation link from an admin.' })
})

app.post('/api/password-reset/request', async (request, response) => {
  if (coreEnabled()) {
    const result = await coreAccountRequest(request, 'POST', '/api/core/auth/password-reset/request', { email: request.body.email })
    response.status(202).json(result)
    return
  }
  const email = parseString(request.body.email).toLowerCase()
  const genericMessage = 'If an active account exists for this email address, a reset link was sent.'

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    response.status(202).json({ message: genericMessage })
    return
  }

  if (!passwordResetAllowed(request, email)) {
    response.status(202).json({ message: genericMessage })
    return
  }

  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.email.toLowerCase() === email && candidate.active)
  if (!user) {
    response.status(202).json({ message: genericMessage })
    return
  }

  const resetToken = randomBytes(32).toString('base64url')
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const usedAt = nowIso()
  database.passwordResetTokens.forEach((candidate) => {
    if (candidate.userId === user.id && !candidate.usedAt) {
      candidate.usedAt = usedAt
    }
  })
  database.passwordResetTokens.unshift({
    id: randomUUID(),
    userId: user.id,
    tokenHash: invitationTokenHash(resetToken),
    createdAt,
    expiresAt,
  })
  addAudit(database, user.id, 'password_reset_requested', 'user', user.id)

  const link = passwordResetLink(appBaseUrlFor(request), resetToken)
  try {
    await sendEmail(
      database,
      [user],
      'Password reset for Digital Core Office Time',
      [
        `Hello ${displayUserName(user)},`,
        '',
        'Use this link to set a new password:',
        link,
        '',
        `The link expires at: ${expiresAt}`,
        '',
        'If you did not request this, you can ignore this email.',
        '',
        'Hallo,',
        'öffne diesen Link, um ein neues Passwort festzulegen:',
        link,
        '',
        `Der Link läuft ab am: ${expiresAt}`,
      ].join('\n'),
    )
  } catch (error) {
    console.warn(`[mail:password-reset] ${error instanceof Error ? error.message : 'failed to send reset email'}`)
  }

  saveDatabase(database)
  response.status(202).json({ message: genericMessage })
})

app.get('/api/password-reset/:token', (request, response) => {
  const database = readDatabase()
  const tokenHash = invitationTokenHash(request.params.token)
  const resetToken = database.passwordResetTokens.find((candidate) => candidate.tokenHash === tokenHash)
  const user = resetToken ? database.users.find((candidate) => candidate.id === resetToken.userId && candidate.active) : undefined

  if (!passwordResetIsUsable(resetToken) || !user) {
    response.status(404).json({ message: 'Password reset link is invalid, expired, or already used.' })
    return
  }

  response.json({
    name: user.name,
    email: user.email,
    expiresAt: resetToken!.expiresAt,
  })
})

app.post('/api/password-reset/:token/complete', (request, response) => {
  const password = parseString(request.body.password)
  const passwordConfirm = parseString(request.body.passwordConfirm)
  const database = readDatabase()
  const tokenHash = invitationTokenHash(request.params.token)
  const resetToken = database.passwordResetTokens.find((candidate) => candidate.tokenHash === tokenHash)
  const user = resetToken ? database.users.find((candidate) => candidate.id === resetToken.userId && candidate.active) : undefined

  if (!passwordResetIsUsable(resetToken) || !user) {
    response.status(404).json({ message: 'Password reset link is invalid, expired, or already used.' })
    return
  }

  if (password !== passwordConfirm) {
    response.status(400).json({ message: 'Passwords do not match' })
    return
  }

  if (verifyPassword(user, password)) {
    response.status(400).json({ message: 'New password must be different from the current password' })
    return
  }

  const policyErrors = passwordPolicyErrors(password, user.email, user.name)
  if (policyErrors.length > 0) {
    response.status(400).json({ message: policyErrors.join(' ') })
    return
  }

  const passwordSalt = randomBytes(16).toString('hex')
  const usedAt = nowIso()
  user.passwordSalt = passwordSalt
  user.passwordHash = hashPassword(password, passwordSalt)
  user.mustChangePassword = false
  database.passwordResetTokens.forEach((candidate) => {
    if (candidate.userId === user.id && !candidate.usedAt) {
      candidate.usedAt = usedAt
    }
  })
  addAudit(database, user.id, 'password_reset_completed', 'user', user.id, { resetTokenId: resetToken!.id })
  saveDatabase(database)

  const authToken = issueToken(user.id)
  response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, user, false))
  response.status(201).json({ token: authToken })
})

app.get('/api/invitations/:token', (request, response) => {
  const database = readDatabase()
  const tokenHash = invitationTokenHash(request.params.token)
  const invitation = database.userInvitations.find((candidate) => candidate.tokenHash === tokenHash)
  const user = invitation ? database.users.find((candidate) => candidate.id === invitation.userId && candidate.active) : undefined

  if (!invitation || !invitationIsUsable(invitation) || !user) {
    response.status(404).json({ message: 'Invitation is invalid, expired, or already used.' })
    return
  }

  response.json({
    name: user.name,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  })
})

app.post('/api/invitations/:token/accept', (request, response) => {
  const password = parseString(request.body.password)
  const passwordConfirm = parseString(request.body.passwordConfirm)
  const database = readDatabase()
  const tokenHash = invitationTokenHash(request.params.token)
  const invitation = database.userInvitations.find((candidate) => candidate.tokenHash === tokenHash)
  const user = invitation ? database.users.find((candidate) => candidate.id === invitation.userId && candidate.active) : undefined

  if (!invitation || !invitationIsUsable(invitation) || !user) {
    response.status(404).json({ message: 'Invitation is invalid, expired, or already used.' })
    return
  }

  if (password !== passwordConfirm) {
    response.status(400).json({ message: 'Passwords do not match' })
    return
  }

  const policyErrors = passwordPolicyErrors(password, user.email, user.name)
  if (policyErrors.length > 0) {
    response.status(400).json({ message: policyErrors.join(' ') })
    return
  }

  const passwordSalt = randomBytes(16).toString('hex')
  user.passwordSalt = passwordSalt
  user.passwordHash = hashPassword(password, passwordSalt)
  user.mustChangePassword = false
  const acceptedDate = toDateKey(new Date())
  if (!user.trackingStartDate || user.trackingStartDate > acceptedDate) {
    user.trackingStartDate = acceptedDate
  }
  invitation.acceptedAt = nowIso()
  addAudit(database, user.id, 'invitation_accepted', 'user', user.id, { invitationId: invitation.id })
  saveDatabase(database)

  const authToken = issueToken(user.id)
  response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, user, false))
  response.status(201).json({ token: authToken })
})

app.post('/api/account/password', requireAuth, async (request: AuthedRequest, response) => {
  if (coreEnabled()) {
    if (request.body.password !== request.body.passwordConfirm) { response.status(400).json({ message: 'Passwords do not match' }); return }
    await coreAccountRequest(request, 'POST', '/api/core/auth/change-password', { currentPassword: request.body.currentPassword, password: request.body.password })
    response.setHeader('Set-Cookie', [coreSessionCookie(request, ''), clearDigitalOfficeSsoCookie(request)])
    response.json({ coreManaged: true, requiresSignIn: true })
    return
  }
  const currentPassword = parseString(request.body.currentPassword)
  const password = parseString(request.body.password)
  const passwordConfirm = parseString(request.body.passwordConfirm)
  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.id === request.user!.id && candidate.active)

  if (!user) {
    response.status(401).json({ message: 'Authentication required' })
    return
  }

  if (!verifyPassword(user, currentPassword)) {
    response.status(400).json({ message: 'Current password is incorrect' })
    return
  }

  if (password !== passwordConfirm) {
    response.status(400).json({ message: 'Passwords do not match' })
    return
  }

  if (verifyPassword(user, password)) {
    response.status(400).json({ message: 'New password must be different from the current password' })
    return
  }

  const policyErrors = passwordPolicyErrors(password, user.email, user.name)
  if (policyErrors.length > 0) {
    response.status(400).json({ message: policyErrors.join(' ') })
    return
  }

  const passwordSalt = randomBytes(16).toString('hex')
  user.passwordSalt = passwordSalt
  user.passwordHash = hashPassword(password, passwordSalt)
  user.mustChangePassword = false
  addAudit(database, user.id, 'password_changed', 'user', user.id, { forced: Boolean(request.user!.mustChangePassword) })
  saveDatabase(database)
  response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, user, true))
  response.json(stateForUser(user))
})

app.post('/api/admin/invitations', requireAuth, requireAdmin, async (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
    const name = parseString(request.body.name)
    const email = parseString(request.body.email).toLowerCase()
    const role = parseRole(request.body.role)
    const weeklyHours = Number(request.body.expectedWeeklyHours)
    const vacationDays = Number(request.body.yearlyVacationDays)
    const targetBalanceHours = Number(request.body.targetBalanceHours)
    const targetRemainingVacationDays = Number(request.body.targetRemainingVacationDays)
    const responsibleAdminUserId = parseString(request.body.responsibleAdminUserId)
    const expectedWeeklyMinutes = Number.isFinite(weeklyHours) && weeklyHours > 0 ? Math.round(weeklyHours * 60) : 40 * 60
    const yearlyVacationDays = Number.isFinite(vacationDays) && vacationDays >= 0 ? Math.round(vacationDays) : 30

    if (name.length < 2) {
      response.status(400).json({ message: 'Name is required' })
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      response.status(400).json({ message: 'A valid email address is required' })
      return
    }

    if (database.users.some((user) => user.email.toLowerCase() === email)) {
      response.status(409).json({ message: 'Email is already registered' })
      return
    }

    const licenseAfterInvite = licenseStateForDatabase(database, 1)
    if (!licenseAfterInvite.valid) {
      response.status(402).json({ message: licenseAfterInvite.message })
      return
    }

    const user = makeStoredUser(name, email, role, randomBytes(48).toString('hex'), expectedWeeklyMinutes, yearlyVacationDays)
    user.trackingStartDate = inactiveTrackingStartDate
    if (role === 'employee') {
      const responsibleAdmin = responsibleAdminUserId
        ? database.users.find((candidate) => candidate.id === responsibleAdminUserId && candidate.role === 'admin' && candidate.active)
        : admin
      user.responsibleAdminUserId = responsibleAdmin?.id
    }
    if (Number.isFinite(targetBalanceHours)) {
      user.balanceAdjustmentMinutes = Math.round(targetBalanceHours * 60)
    }
    if (Number.isFinite(targetRemainingVacationDays)) {
      user.vacationAdjustmentDays = targetRemainingVacationDays - yearlyVacationDays
    }

    const inviteToken = randomBytes(32).toString('base64url')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    const invitation = {
      id: randomUUID(),
      userId: user.id,
      email: user.email,
      role,
      tokenHash: invitationTokenHash(inviteToken),
      createdBy: admin.id,
      createdAt,
      expiresAt,
    }

    database.users.push(user)
    database.userInvitations.unshift(invitation)
    addAudit(database, admin.id, 'user_invited', 'user', user.id, { invitationId: invitation.id, email: user.email, role })
    saveDatabase(database)

    const link = invitationLink(appBaseUrlFor(request), inviteToken)
    void sendEmail(
      database,
      [user],
      'Invitation to Digital Core Office Time',
      [
        `Hello ${displayUserName(user)},`,
        '',
        'An admin created an account for you in Digital Core Office Time.',
        'Please use this invitation link to set your password:',
        link,
        '',
        `This invitation is only valid for: ${user.email}`,
        `It expires at: ${expiresAt}`,
        '',
        'Hallo,',
        'ein Admin hat ein Konto für dich in Digital Core Office Time erstellt.',
        'Bitte öffne den Link, um dein Passwort festzulegen:',
        link,
      ].join('\n'),
    ).catch((error) => {
      console.warn(`[mail:invite] invitation ${invitation.id} for ${user.email} was saved, but email delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    })
    response.status(201).json(stateForUser(admin))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Invitation failed' })
  }
})

app.delete('/api/admin/invitations/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const invitation = database.userInvitations.find((candidate) => candidate.id === request.params.id)

  if (!invitation) {
    response.status(404).json({ message: 'Invitation not found' })
    return
  }

  if (invitation.acceptedAt) {
    response.status(409).json({ message: 'Accepted invitations cannot be canceled' })
    return
  }

  const targetUser = database.users.find((user) => user.id === invitation.userId)
  const hasOperationalData = Boolean(
    targetUser &&
      (database.timeEntries.some((entry) => entry.userId === targetUser.id) ||
        database.absences.some((absence) => absence.userId === targetUser.id) ||
        database.requests.some((item) => item.userId === targetUser.id) ||
        database.importBatches.some((batch) => batch.userId === targetUser.id)),
  )

  if (hasOperationalData) {
    response.status(409).json({ message: 'Invitation cannot be canceled because this user already has time or request data.' })
    return
  }

  database.userInvitations = database.userInvitations.filter((item) => item.id !== invitation.id)
  database.users = database.users.filter((user) => user.id !== invitation.userId)
  database.notifications = database.notifications.filter((notification) => notification.userId !== invitation.userId)
  database.calendarGroups = database.calendarGroups.map((group) => ({
    ...group,
    memberUserIds: group.memberUserIds.filter((userId) => userId !== invitation.userId),
  }))
  database.users = database.users.map((user) => ({
    ...user,
    calendarAccessUserIds: user.calendarAccessUserIds.filter((userId) => userId !== invitation.userId),
  }))

  addAudit(database, admin.id, 'invitation_canceled', 'user_invitation', invitation.id, {
    userId: invitation.userId,
    email: invitation.email,
  })
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.get('/api/state', requireAuth, (request: AuthedRequest, response) => {
  if (!coreEnabled() && !digitalOfficeSsoForRequest(request)) {
    response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, request.user!, false))
  }
  response.json(stateForUser(request.user!))
})

app.get('/api/exports/time-csv', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const currentUser = database.users.find((candidate) => candidate.id === request.user!.id)!
  const requestedUserId = parseString(request.query.userId) || currentUser.id

  if (currentUser.role !== 'admin' && requestedUserId !== currentUser.id) {
    response.status(403).json({ message: 'You can only export your own time data' })
    return
  }

  const targetUser = database.users.find((user) => user.id === requestedUserId && user.active)
  if (!targetUser) {
    response.status(404).json({ message: 'User not found' })
    return
  }

  const period = parseExportPeriod(request.query.period)
  const referenceDate = period === 'all' ? toDateKey(new Date()) : parseSensibleDateKey(request.query.date)
  if (!referenceDate) {
    response.status(400).json({ message: sensibleDateError('Reference date') })
    return
  }
  const language = parseExportLanguage(request.query.language)
  const projection = zeitguruAccounting?.projection(targetUser.id, database.timeEntries)
  const exportFile = buildTimeCsvExport({ ...database, timeEntries: [...database.timeEntries, ...(projection?.entries ?? [])] }, publicUser(targetUser), period, referenceDate, language, projection?.accounting)

  addAudit(database, currentUser.id, 'time_csv_exported', 'user', targetUser.id, {
    period,
    startDate: exportFile.startDate,
    endDate: exportFile.endDate,
  })
  saveDatabase(database)

  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="${exportFile.filename}"`)
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
  response.send(exportFile.csv)
})

app.get('/api/exports/calendar-ics', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const currentUser = database.users.find((candidate) => candidate.id === request.user!.id)!
  const visibleUsers = visibleUsersFor(currentUser, database.users, database.calendarGroups)
  const allowedIds = new Set(visibleUsers.map((user) => user.id))
  const requestedIds = parseString(request.query.userIds)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const selectedIds = requestedIds.filter((id) => allowedIds.has(id))
  const exportUserIds = new Set(selectedIds.length > 0 ? selectedIds : visibleUsers.map((user) => user.id))
  const exportUsers = visibleUsers.filter((user) => exportUserIds.has(user.id))
  const mode = parseCalendarExportMode(request.query.mode)
  const referenceDate = parseSensibleDateKey(request.query.date)
  if (!referenceDate) {
    response.status(400).json({ message: sensibleDateError('Reference date') })
    return
  }
  const [startDate, endDate] = calendarExportRange(mode, referenceDate)
  const language = parseCalendarExportLanguage(request.query.language)
  const holidays = holidaysForYears(yearsForDateRange(startDate, endDate), database.holidayOverrides, database.holidaySettings)
  const selectedVisibleIds = new Set(exportUsers.map((user) => user.id))
  const externalEvents = visibleExternalCalendarEventsFor(
    currentUser,
    database.externalCalendarEvents,
    database.calDavAccounts,
    selectedVisibleIds,
  )
  const customEvents = visibleCustomCalendarEventsFor(currentUser, database.customCalendarEvents, selectedVisibleIds)
  const accounting: ZeitguruAccountingContexts = {}
  for (const user of exportUsers) {
    if (user.id === currentUser.id || currentUser.role === 'admin') accounting[user.id] = zeitguruAccounting?.projection(user.id, database.timeEntries).accounting
  }
  const exportFile = buildCalendarIcsExport({
    accounting,
    users: exportUsers,
    holidays,
    absences: visibleAbsencesFor(currentUser, database.absences, selectedVisibleIds),
    externalEvents,
    customEvents,
    startDate,
    endDate,
    mode,
    language,
  })

  addAudit(database, currentUser.id, 'calendar_ics_exported', 'calendar', currentUser.id, {
    mode,
    startDate: exportFile.startDate,
    endDate: exportFile.endDate,
    userIds: [...selectedVisibleIds],
  })
  saveDatabase(database)

  response.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="${exportFile.filename}"`)
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
  response.send(exportFile.ics)
})

app.use('/api/zeitguru', requireAuth, (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store')
  if (!zeitguru) { response.status(404).json({ message: 'Zeitguru evaluation is not enabled on this installation.' }); return }
  next()
})
app.get('/api/zeitguru', (request: AuthedRequest, response) => response.json(zeitguruState(request.user!.id)))
app.post('/api/zeitguru/sync', async (request: AuthedRequest, response) => {
  try { response.json(await zeitguru!.synchronize(request.user!.id)) }
  catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body) }
})
app.get('/api/zeitguru/operations/:clientOperationId', (request: AuthedRequest, response) => {
  response.json({ operation: zeitguru!.journal.operation(request.user!.id, String(request.params.clientOperationId)) })
})
app.post('/api/zeitguru/login', async (request: AuthedRequest, response) => {
  try { response.json(await zeitguru!.login(request.user!.id, request.body)) }
  catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body) }
  finally { if (request.body && typeof request.body === 'object') delete request.body.password }
})
app.post('/api/zeitguru/connect', async (request: AuthedRequest, response) => {
  try {
    const status = await zeitguru!.connect(request.user!.id, request.body)
    const database = readDatabase()
    addAudit(database, request.user!.id, 'zeitguru_evaluation_connected', 'user', request.user!.id, { generation: status.generation })
    saveDatabase(database); response.json(status)
  } catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body) }
})
app.post('/api/zeitguru/disconnect', (request: AuthedRequest, response) => {
  const status = zeitguru!.disconnect(request.user!.id, request.body.expectedGeneration)
  const database = readDatabase()
  addAudit(database, request.user!.id, 'zeitguru_evaluation_disconnected', 'user', request.user!.id, { generation: status.generation })
  saveDatabase(database); response.json(status)
})
app.post('/api/zeitguru/reconcile', async (request: AuthedRequest, response) => {
  try { response.json(await zeitguru!.reconcile(request.user!.id, request.body.operationId)) }
  catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body) }
})
app.post('/api/zeitguru/review', async (request: AuthedRequest, response) => {
  try {
    const status = await zeitguru!.acknowledgeReview(request.user!.id, request.body.expectedGeneration, request.body.reviewed)
    const database = readDatabase()
    addAudit(database, request.user!.id, 'zeitguru_manual_review_acknowledged', 'user', request.user!.id, { generation: status.generation })
    saveDatabase(database); response.json(status)
  } catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body) }
})
app.get('/api/zeitguru/history', (request: AuthedRequest, response) => {
  response.json(zeitguruHistory!.page(request.user!.id, {
    ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {}),
    ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
    ...(typeof request.query.fromDate === 'string' ? { fromDate: request.query.fromDate } : {}),
    ...(typeof request.query.toDate === 'string' ? { toDate: request.query.toDate } : {}),
  }))
})
app.post('/api/zeitguru/history/import', async (request: AuthedRequest, response) => {
  try {
    const result = await zeitguruHistory!.importHistory(request.user!.id, request.body)
    // The history store keeps the durable batch audit in its own atomic transaction.
    // No native clock action or provider write is triggered by an import.
    scheduleLiveStateBroadcast()
    response.json(result)
  } catch (error) {
    if (error instanceof ZeitguruHistoryStoreError || error instanceof ZeitguruAccountingError) { response.status(error.status).json({ message: error.message, code: error.code }); return }
    const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body)
  }
})
app.post('/api/zeitguru/history/undo', (request: AuthedRequest, response) => {
  response.json(zeitguruHistory!.undo(request.user!.id, request.body))
  scheduleLiveStateBroadcast()
})

app.post('/api/clock', requireAuth, async (request: AuthedRequest, response) => {
  const action = parseString(request.body.action) as ClockAction
  // A fresh read happens before the local mutation. Changed clock revisions make stale clicks retry safely.
  if (zeitguru?.journal.status(request.user!.id).enabled && !zeitguru.journal.operation(request.user!.id, String(request.body.clientOperationId ?? 'missing-operation'))) {
    try { await zeitguru.synchronize(request.user!.id) }
    catch (error) { const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body); return }
  }
  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.id === request.user!.id)!
  const workLocation = parseWorkLocation(request.body.workLocation)
  if (!['start_work', 'start_break', 'stop_break', 'stop_work'].includes(action)) {
    response.status(400).json({ message: 'Unsupported clock action' }); return
  }
  const bridge = zeitguru?.journal.status(user.id)
  const clockInput = {
    userId: user.id, action, clientOperationId: request.body.clientOperationId,
    expectedRevision: request.body.expectedRevision, expectedGeneration: request.body.expectedGeneration,
    request: { workLocation: workLocation ?? null },
  }
  if (zeitguru && typeof clockInput.clientOperationId === 'string' && zeitguru.journal.operation(user.id, clockInput.clientOperationId)) {
    writeDatabaseAtomically(database, (sql) => zeitguru.journal.withClockOperation(sql, clockInput, () => { throw new Error('Expected an existing clock operation') }))
    response.json(stateForUser(user)); return
  }
  if (bridge?.enabled && (typeof clockInput.clientOperationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(clockInput.clientOperationId)
    || !Number.isSafeInteger(clockInput.expectedRevision) || !Number.isSafeInteger(clockInput.expectedGeneration))) {
    response.status(409).json({ message: 'Reload the time clock before continuing with Zeitguru connected.' }); return
  }
  const timestamp = nowIso()
  const autoClosedEntries = autoClockOutOverlongEntries(database, timestamp)
  const autoClosedCurrentUser = autoClosedEntries.some((entry) => entry.userId === user.id)
  const currentEntry = openEntryForUser(database.timeEntries, user.id)

  if (autoClosedCurrentUser && action !== 'start_work') {
    saveDatabase(database)
    response.json(stateForUser(user))
    return
  }

  let affectedEntry = currentEntry
  const applyClockAction = () => {
  if (action === 'start_work') {
    if (currentEntry) {
      throw new ZeitguruBridgeError('clock_conflict', 'Work is already running')
    }

    affectedEntry = {
      id: randomUUID(),
      userId: user.id,
      date: toDateKey(new Date()),
      startedAt: timestamp,
      breaks: [],
      workLocation,
      source: 'clock',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    database.timeEntries.push(affectedEntry)
    const date = toDateKey(new Date())
    if (!user.trackingStartDate || user.trackingStartDate > date) {
      user.trackingStartDate = date
    }
  } else if (action === 'start_break') {
    if (!currentEntry || currentEntry.breaks.some((segment) => !segment.stoppedAt)) {
      throw new ZeitguruBridgeError('clock_conflict', 'No active work entry or break already running')
    }

    currentEntry.breaks.push({ id: randomUUID(), startedAt: timestamp })
    currentEntry.updatedAt = timestamp
  } else if (action === 'stop_break') {
    const openBreak = currentEntry?.breaks.find((segment) => !segment.stoppedAt)
    if (!openBreak || !currentEntry) {
      throw new ZeitguruBridgeError('clock_conflict', 'No break is running')
    }

    openBreak.stoppedAt = timestamp
    currentEntry.updatedAt = timestamp
  } else if (action === 'stop_work') {
    if (!currentEntry) {
      throw new ZeitguruBridgeError('clock_conflict', 'No work entry is running')
    }

    const openBreak = currentEntry.breaks.find((segment) => !segment.stoppedAt)
    if (openBreak) {
      openBreak.stoppedAt = timestamp
    }
    currentEntry.stoppedAt = timestamp
    currentEntry.updatedAt = timestamp
  }
  addAudit(database, user.id, action, 'time_entry', affectedEntry!.id)
  }
  if (zeitguru && bridge?.enabled) {
    writeDatabaseAtomically(database, (sql, persist) => zeitguru.journal.withClockOperation(sql, clockInput, () => {
      applyClockAction(); persist()
      return { action, occurredAt: timestamp, localEntryId: affectedEntry!.id }
    }))
    scheduleLiveStateBroadcast()
    zeitguru.kick()
  } else { applyClockAction(); saveDatabase(database) }
  response.json(stateForUser(user))
})

app.patch('/api/clock/location', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.id === request.user!.id)!
  const autoClosedEntries = autoClockOutOverlongEntries(database)
  const autoClosedCurrentUser = autoClosedEntries.some((entry) => entry.userId === user.id)
  const currentEntry = openEntryForUser(database.timeEntries, user.id)
  const workLocation = parseWorkLocation(request.body.workLocation)

  if (!currentEntry) {
    if (autoClosedCurrentUser) {
      saveDatabase(database)
      response.json(stateForUser(user))
      return
    }
    response.status(409).json({ message: 'No work entry is running' })
    return
  }

  if (!workLocation) {
    response.status(400).json({ message: 'Unsupported work location' })
    return
  }

  currentEntry.workLocation = workLocation
  currentEntry.updatedAt = nowIso()
  addAudit(database, user.id, 'work_location_updated', 'time_entry', currentEntry.id, { workLocation })
  saveDatabase(database)
  response.json(stateForUser(user))
})

app.post('/api/requests', requireAuth, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
    const targetUserId=parseString(request.body.targetUserId)||actor.id
    if(targetUserId!==actor.id&&actor.role!=='admin'){response.status(403).json({message:'Only administrators may create a request for another employee.'});return}
    const user=database.users.find(candidate=>candidate.id===targetUserId&&candidate.active)
    if(!user){response.status(404).json({message:'Active employee not found.'});return}
    if(request.body.reviewProposal===true&&request.body.proposalConfirmed!==true){response.status(400).json({message:'Review the proposal and confirm the actual times.'});return}
    const createdAt = nowIso()
    const item = pendingRequestFromBody(request.body, user.id, randomUUID(), createdAt)

    database.requests.unshift(item)
    addAudit(database, actor.id, 'request_created', 'request', item.id, { type: item.type,userId:user.id,reviewProposal:request.body.reviewProposal===true,proposalConfirmed:request.body.proposalConfirmed===true })
    notifyAdminsForRequest(database, item, user, appBaseUrlFor(request))
    saveDatabase(database)
    response.status(201).json(stateForUser(actor))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Request failed' })
  }
})

app.patch('/api/requests/:id', requireAuth, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const user = database.users.find((candidate) => candidate.id === request.user!.id)!
    const item = database.requests.find((candidate) => candidate.id === request.params.id && candidate.userId === user.id)

    if (!item || item.status !== 'pending') {
      response.status(404).json({ message: 'Pending request not found' })
      return
    }

    const previousType = item.type
    const updated = pendingRequestFromBody(request.body, user.id, item.id, item.createdAt)
    Object.assign(item, updated)

    addAudit(database, user.id, 'request_updated', 'request', item.id, { previousType, type: item.type })
    notifyAdminsForRequest(database, item, user, appBaseUrlFor(request), 'updated')
    saveDatabase(database)
    response.json(stateForUser(user))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Request could not be updated' })
  }
})

app.post('/api/requests/:id/cancel', requireAuth, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const user = database.users.find((candidate) => candidate.id === request.user!.id)!
    const item = database.requests.find((candidate) => candidate.id === request.params.id && candidate.userId === user.id)

    if (!item || item.status !== 'pending') {
      response.status(404).json({ message: 'Pending request not found' })
      return
    }

    item.status = 'undone'
    item.undoneAt = nowIso()
    item.undoneBy = user.id

    addAudit(database, user.id, 'request_withdrawn', 'request', item.id, { type: item.type })
    saveDatabase(database)
    response.json(stateForUser(user))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Request could not be withdrawn' })
  }
})

app.post('/api/requests/:id/decision', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
    const item = database.requests.find((candidate) => candidate.id === request.params.id)
    const decision = parseString(request.body.decision)

    if (!item || item.status !== 'pending') {
      response.status(404).json({ message: 'Pending request not found' })
      return
    }

    if (decision !== 'approved' && decision !== 'rejected') {
      response.status(400).json({ message: 'Decision must be approved or rejected' })
      return
    }

    if (decision === 'approved') {
      assertRequestDateRange(item)
    }

    item.status = decision
    item.decidedAt = nowIso()
    item.decidedBy = admin.id
    item.adminNote = parseString(request.body.adminNote)

    if (decision === 'approved') {
      applyApprovedRequestEffects(database, item, admin.id)
    }

    const employee = database.users.find((user) => user.id === item.userId)
    if (employee) {
      notifyEmployeeForDecision(database, item, employee, admin, appBaseUrlFor(request))
    }

    addAudit(database, admin.id, `request_${decision}`, 'request', item.id, { type: item.type })
    saveDatabase(database)
    response.json(stateForUser(admin))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Decision failed' })
  }
})

app.post('/api/requests/:id/undo', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
    const item = database.requests.find((candidate) => candidate.id === request.params.id)

    if (!item || item.status !== 'approved') {
      response.status(404).json({ message: 'Approved request not found' })
      return
    }

    undoApprovedRequestEffects(database, item)
    item.status = 'undone'
    item.undoneAt = nowIso()
    item.undoneBy = admin.id

    const employee = database.users.find((user) => user.id === item.userId)
    if (employee) {
      notifyEmployeeForUndo(database, item, employee, admin, appBaseUrlFor(request))
    }

    addAudit(database, admin.id, 'request_approval_undone', 'request', item.id, { type: item.type })
    saveDatabase(database)
    response.json(stateForUser(admin))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Undo failed' })
  }
})

app.patch('/api/users/:id/settings', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const user = database.users.find((candidate) => candidate.id === request.params.id)

  if (!user) {
    response.status(404).json({ message: 'User not found' })
    return
  }

  const weeklyHours = Number(request.body.expectedWeeklyHours)
  const vacationDays = Number(request.body.yearlyVacationDays)
  const effectiveFrom = parseDateKeyInput(request.body.effectiveFrom)
  const targetBalanceHours = Number(request.body.targetBalanceHours)
  const targetRemainingVacationDays = Number(request.body.targetRemainingVacationDays)
  const responsibleAdminUserId = parseString(request.body.responsibleAdminUserId)
  const requestedRole = 'role' in request.body ? parseRole(request.body.role) : undefined
  const updates: Record<string, unknown> = {}

  if (coreEnabled() && requestedRole && requestedRole !== user.role) {
    response.status(409).json({ message: 'Manage account permissions in Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' })
    return
  }
  if (requestedRole && requestedRole !== user.role) {
    if (user.id === admin.id && requestedRole !== 'admin') {
      response.status(400).json({ message: 'You cannot remove your own admin permission.' })
      return
    }

    const activeAdmins = database.users.filter((candidate) => candidate.active && candidate.role === 'admin')
    if (user.role === 'admin' && requestedRole !== 'admin' && activeAdmins.length <= 1) {
      response.status(400).json({ message: 'At least one active admin is required.' })
      return
    }

    user.role = requestedRole
    updates.role = requestedRole

    if (requestedRole === 'admin') {
      user.responsibleAdminUserId = undefined
      updates.responsibleAdminUserId = null
    } else {
      const responsibleAdmin = responsibleAdminUserId
        ? database.users.find((candidate) => candidate.id === responsibleAdminUserId && candidate.role === 'admin' && candidate.active)
        : admin
      user.responsibleAdminUserId = responsibleAdmin?.id
      updates.responsibleAdminUserId = responsibleAdmin?.id ?? null
    }
  }

  if ((Number.isFinite(weeklyHours) && weeklyHours > 0) || (Number.isFinite(vacationDays) && vacationDays >= 0)) {
    const terms = employmentTermsFor(user)
    const activeTerm = termForDate({ ...user, employmentTerms: terms }, effectiveFrom)
    const nextTerm = {
      id: terms.find((term) => term.effectiveFrom === effectiveFrom)?.id ?? randomUUID(),
      effectiveFrom,
      expectedWeeklyMinutes: Number.isFinite(weeklyHours) && weeklyHours > 0
        ? Math.round(weeklyHours * 60)
        : activeTerm.expectedWeeklyMinutes,
      yearlyVacationDays: Number.isFinite(vacationDays) && vacationDays >= 0
        ? Math.round(vacationDays)
        : activeTerm.yearlyVacationDays,
      createdAt: terms.find((term) => term.effectiveFrom === effectiveFrom)?.createdAt ?? nowIso(),
    }
    user.employmentTerms = [...terms.filter((term) => term.effectiveFrom !== effectiveFrom), nextTerm].sort((left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom),
    )
    const currentTerm = currentEmploymentTerm(user)
    user.expectedWeeklyMinutes = currentTerm.expectedWeeklyMinutes
    user.yearlyVacationDays = currentTerm.yearlyVacationDays
    updates.employmentTerm = {
      effectiveFrom,
      expectedWeeklyMinutes: nextTerm.expectedWeeklyMinutes,
      yearlyVacationDays: nextTerm.yearlyVacationDays,
    }
  }

  if (Number.isFinite(targetBalanceHours)) {
    const holidays = holidaysForYears(currentHolidayYears(), database.holidayOverrides, database.holidaySettings)
    const rawUser = { ...publicUser(user), balanceAdjustmentMinutes: 0 }
    const projection = zeitguruAccounting?.projection(user.id, database.timeEntries)
    const rawSummary = summaryForUser(rawUser, [...database.timeEntries, ...(projection?.entries ?? [])], database.absences, holidays, new Date(), database.requests, projection?.accounting)
    user.balanceAdjustmentMinutes = Math.round(targetBalanceHours * 60 - rawSummary.year.plusMinusMinutes)
    updates.targetBalanceHours = targetBalanceHours
  }
  if (Number.isFinite(targetRemainingVacationDays)) {
    const holidays = holidaysForYears(currentHolidayYears(), database.holidayOverrides, database.holidaySettings)
    const usedDays = vacationUsedDays(publicUser(user), database.absences, holidays, new Date().getFullYear())
    user.vacationAdjustmentDays = targetRemainingVacationDays + usedDays - user.yearlyVacationDays
    updates.targetRemainingVacationDays = targetRemainingVacationDays
  }
  if (user.role === 'employee' && 'responsibleAdminUserId' in request.body) {
    const responsibleAdmin = responsibleAdminUserId
      ? database.users.find((candidate) => candidate.id === responsibleAdminUserId && candidate.role === 'admin' && candidate.active)
      : undefined
    user.responsibleAdminUserId = responsibleAdmin?.id
    updates.responsibleAdminUserId = responsibleAdmin?.id ?? null
  }

  addAudit(database, admin.id, 'user_settings_updated', 'user', user.id, updates)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.delete('/api/users/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const user = database.users.find((candidate) => candidate.id === request.params.id)

  if (!user || !user.active) {
    response.status(404).json({ message: 'Active user not found' })
    return
  }

  if (user.id === admin.id) {
    response.status(400).json({ message: 'You cannot remove your own account.' })
    return
  }

  const activeAdmins = database.users.filter((candidate) => candidate.active && candidate.role === 'admin')
  if (user.role === 'admin' && activeAdmins.length <= 1) {
    response.status(400).json({ message: 'At least one active admin is required.' })
    return
  }

  user.active = false
  user.calendarAccessUserIds = []
  user.responsibleAdminUserId = undefined
  database.users.forEach((candidate) => {
    candidate.calendarAccessUserIds = candidate.calendarAccessUserIds.filter((id) => id !== user.id)
    if (candidate.responsibleAdminUserId === user.id) {
      candidate.responsibleAdminUserId = undefined
    }
  })
  database.calendarGroups.forEach((group) => {
    group.memberUserIds = group.memberUserIds.filter((id) => id !== user.id)
  })
  database.userInvitations = database.userInvitations.filter((invitation) => invitation.userId !== user.id || invitation.acceptedAt)
  for (const [token, session] of tokens.entries()) {
    if (session.userId === user.id) {
      tokens.delete(token)
    }
  }

  addAudit(database, admin.id, 'user_removed', 'user', user.id, { email: user.email, role: user.role })
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.post('/api/imports/time-csv', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
    const userId = parseString(request.body.userId)
    const csv = typeof request.body.csv === 'string' ? request.body.csv : ''
    const fileName = parseString(request.body.fileName) || 'zeitguru-export.csv'
    const targetUser = database.users.find((user) => user.id === userId && user.active)

    if (!targetUser) {
      response.status(404).json({ message: 'Employee not found' })
      return
    }

    if (csv.trim().length === 0) {
      response.status(400).json({ message: 'CSV content is required' })
      return
    }

    const batch = importTimeCsv(database, { userId: targetUser.id, importedBy: admin.id, csv, fileName })
    addAudit(database, admin.id, 'time_csv_imported', 'import_batch', batch.id, {
      userId: targetUser.id,
      importedRows: batch.importedRows,
      skippedRows: batch.skippedRows,
    })
    saveDatabase(database)
    response.status(201).json(stateForUser(admin))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'CSV import failed' })
  }
})

app.post('/api/backups/weekly', requireAuth, requireAdmin, async (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const backupPath = await ensureWeeklyBackup()
  addAudit(database, admin.id, 'weekly_backup_created', 'backup', backupPath)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.get('/api/holidays/template-options', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const settings = normalizeHolidaySettings({
    country: parseString(request.query.country),
    state: parseString(request.query.state) || undefined,
    region: parseString(request.query.region) || undefined,
    language: parseString(request.query.language) || undefined,
  })

  response.json(holidayTemplateOptions(settings))
})

app.patch('/api/holidays/settings', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const nextSettings = normalizeHolidaySettings({
    country: parseString(request.body.country),
    state: parseString(request.body.state) || undefined,
    region: parseString(request.body.region) || undefined,
    language: parseString(request.body.language) || undefined,
    updatedAt: nowIso(),
    updatedBy: admin.id,
  })

  if (!holidaySettingsSupported(nextSettings)) {
    response.status(400).json({ message: 'Unsupported holiday country, state, or region' })
    return
  }

  database.holidaySettings = nextSettings
  addAudit(database, admin.id, 'holiday_settings_updated', 'settings', 'holidays', { ...nextSettings })
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.patch('/api/settings/overtime-policy', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database=readDatabase()
  overtimePolicies.save(request.body,request.user!.id,new Set(database.users.filter(user=>user.active&&user.role==='admin'&&!user.mustChangePassword).map(user=>user.id)),mailServerConfigured(database))
  scheduleLiveStateBroadcast()
  response.json(stateForUser(request.user!))
  void overtimeMonitor.check().catch(()=>console.error('Overtime policy check failed'))
})
app.post('/api/settings/overtime-policy/retry-failed', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  if(!mailServerConfigured(readDatabase())) {response.status(400).json({message:'Configure SMTP before retrying alerts.'});return}
  overtimePolicies.retryFailed()
  response.json(stateForUser(request.user!))
  void overtimeMonitor.check().catch(()=>console.error('Overtime policy check failed'))
})

app.patch('/api/settings/mail-server', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const existing = database.mailServerSettings
  const host = parseString(request.body.host)
  const port = Number(request.body.port)
  const secure = parseBoolean(request.body.secure)
  const user = parseString(request.body.user)
  const passwordInput = typeof request.body.password === 'string' ? request.body.password : ''
  const password = passwordInput.length > 0 ? passwordInput : existing?.password ?? ''
  const fromAddress = parseString(request.body.fromAddress)

  if (!host) {
    response.status(400).json({ message: 'SMTP host is required' })
    return
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    response.status(400).json({ message: 'SMTP port must be between 1 and 65535' })
    return
  }

  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(fromAddress) && !/^.+<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(fromAddress)) {
    response.status(400).json({ message: 'A valid from address is required' })
    return
  }

  database.mailServerSettings = {
    host,
    port,
    secure,
    user,
    password,
    fromAddress,
    passwordConfigured: password.length > 0,
    updatedAt: nowIso(),
    updatedBy: admin.id,
  }

  addAudit(database, admin.id, 'mail_server_settings_updated', 'settings', 'mail_server', {
    host,
    port,
    secure,
    userConfigured: user.length > 0,
    passwordConfigured: password.length > 0,
    fromAddress,
  })
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.post('/api/settings/mail-server/test', requireAuth, requireAdmin, async (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const admin = database.users.find((candidate) => candidate.id === request.user!.id)!

    if (!mailServerConfigured(database)) {
      response.status(400).json({ message: 'No mail server is configured' })
      return
    }

    await sendEmail(
      database,
      [admin],
      'Digital Core Office Time: SMTP test',
      [
        'This is a test email from Digital Core Office Time.',
        '',
        'Dies ist eine Test-E-Mail aus Digital Core Office Time.',
        `Sent at: ${nowIso()}`,
      ].join('\n'),
    )

    addAudit(database, admin.id, 'mail_server_test_sent', 'settings', 'mail_server')
    saveDatabase(database)
    response.json(stateForUser(admin))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Mail server test failed' })
  }
})

app.delete('/api/settings/mail-server', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!

  if (!database.mailServerSettings) {
    response.status(404).json({ message: 'No mail server is configured' })
    return
  }

  database.mailServerSettings = undefined
  addAudit(database, admin.id, 'mail_server_settings_deleted', 'settings', 'mail_server')
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.patch('/api/settings/license', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const licenseKey = parseString(request.body.licenseKey)

  if (!licenseKey) {
    response.status(400).json({ message: 'License key is required' })
    return
  }

  const verification = verifyLicenseKey(licenseKey)
  if (!verification.details) {
    response.status(400).json({ message: verification.error ?? 'License key is invalid' })
    return
  }

  database.licenseSettings = {
    licenseKey,
    updatedAt: nowIso(),
    updatedBy: admin.id,
  }

  addAudit(database, admin.id, 'license_settings_updated', 'settings', 'license', {
    licenseId: verification.details.licenseId,
    holderName: verification.details.holderName,
    plan: verification.details.plan,
    activeUserLimit: verification.details.activeUserLimit,
    validUntil: verification.details.validUntil ?? null,
  })
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.delete('/api/settings/license', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!

  if (!database.licenseSettings) {
    response.status(404).json({ message: 'No license is configured' })
    return
  }

  database.licenseSettings = undefined
  addAudit(database, admin.id, 'license_settings_deleted', 'settings', 'license')
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.patch('/api/users/:id/calendar-access', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const user = database.users.find((candidate) => candidate.id === request.params.id)

  if (!user || (actor.role !== 'admin' && actor.id !== user.id)) {
    response.status(403).json({ message: 'You can only change your own calendar sharing' })
    return
  }

  const allowedIds = new Set(calendarAccessTargetsFor(user, database.users, database.calendarGroups).map((target) => target.id))
  const ids = parseUserIds(request.body.calendarAccessUserIds, database.users, user.id)
  user.calendarAccessUserIds = ids.filter((id) => allowedIds.has(id))

  addAudit(database, actor.id, 'calendar_access_updated', 'user', user.id)
  saveDatabase(database)
  response.json(stateForUser(actor))
})

function customCalendarEventInput(body: Record<string, unknown>) {
  const title = parseString(body.title).slice(0, 140)
  const description = parseString(body.description).slice(0, 1000)
  const date = parseRequiredDateKey(body.date)
  const isAllDay = parseBoolean(body.isAllDay)
  const startTime = isAllDay ? '' : parseTimeInput(body.startTime)
  const endTime = isAllDay ? '' : parseTimeInput(body.endTime)

  if (!title) {
    throw new Error('Event title is required')
  }
  if (!date) {
    throw new Error('A valid event date is required')
  }
  if (!isAllDay && (!startTime || !endTime)) {
    throw new Error('Start and end time are required for timed events')
  }
  if (!isAllDay && startTime >= endTime) {
    throw new Error('The end time must be after the start time')
  }

  return {
    title,
    description: description || undefined,
    date,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
    isAllDay,
    shareWithCalendarUsers: parseBoolean(body.shareWithCalendarUsers),
  }
}

app.post('/api/calendar-events', requireAuth, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
    const input = customCalendarEventInput(request.body)
    const now = nowIso()
    const event: CustomCalendarEvent = {
      id: randomUUID(),
      userId: actor.id,
      ...input,
      createdAt: now,
      updatedAt: now,
    }

    database.customCalendarEvents.push(event)
    addAudit(database, actor.id, 'custom_calendar_event_created', 'calendar_event', event.id, {
      shared: event.shareWithCalendarUsers,
    })
    saveDatabase(database)
    response.status(201).json(stateForUser(actor))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Calendar event could not be created' })
  }
})

app.patch('/api/calendar-events/:id', requireAuth, (request: AuthedRequest, response) => {
  try {
    const database = readDatabase()
    const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
    const event = database.customCalendarEvents.find((candidate) => candidate.id === request.params.id && candidate.userId === actor.id)

    if (!event) {
      response.status(404).json({ message: 'Calendar event not found' })
      return
    }

    const input = customCalendarEventInput(request.body)
    event.title = input.title
    event.description = input.description
    event.date = input.date
    event.startTime = input.startTime
    event.endTime = input.endTime
    event.isAllDay = input.isAllDay
    event.shareWithCalendarUsers = input.shareWithCalendarUsers
    event.updatedAt = nowIso()

    addAudit(database, actor.id, 'custom_calendar_event_updated', 'calendar_event', event.id, {
      shared: event.shareWithCalendarUsers,
    })
    saveDatabase(database)
    response.json(stateForUser(actor))
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'Calendar event could not be updated' })
  }
})

app.delete('/api/calendar-events/:id', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const event = database.customCalendarEvents.find((candidate) => candidate.id === request.params.id && candidate.userId === actor.id)

  if (!event) {
    response.status(404).json({ message: 'Calendar event not found' })
    return
  }

  database.customCalendarEvents = database.customCalendarEvents.filter((candidate) => candidate.id !== event.id)
  addAudit(database, actor.id, 'custom_calendar_event_deleted', 'calendar_event', event.id)
  saveDatabase(database)
  response.json(stateForUser(actor))
})

async function syncCalDavAccountAndRememberStatus(database: ReturnType<typeof readDatabase>, account: StoredCalDavAccount) {
  try {
    await assertAllowedCalDavUrl(account.serverUrl)
    if (account.calendarUrl) {
      await assertAllowedCalDavUrl(account.calendarUrl)
    }
    const syncedEvents = await syncCalDavAccount(database, account)
    return { syncedEvents }
  } catch (error) {
    account.lastSyncAt = nowIso()
    account.lastSyncStatus = 'error'
    account.lastSyncError = error instanceof Error ? error.message : 'CalDAV sync failed'
    account.updatedAt = nowIso()
    return { syncedEvents: 0 }
  }
}

app.post('/api/caldav/accounts', requireAuth, async (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const name = parseString(request.body.name) || 'CalDAV'
  const serverUrl = parseHttpsUrl(request.body.serverUrl)
  const username = parseString(request.body.username)
  const password = typeof request.body.password === 'string' ? request.body.password : ''
  const calendarUrlInput = parseString(request.body.calendarUrl)
  const calendarUrl = calendarUrlInput ? parseHttpsUrl(calendarUrlInput) : undefined

  if (!serverUrl) {
    response.status(400).json({ message: 'A valid HTTPS CalDAV server URL is required' })
    return
  }
  if (!username || !password) {
    response.status(400).json({ message: 'CalDAV username and password are required' })
    return
  }
  if (calendarUrlInput && !calendarUrl) {
    response.status(400).json({ message: 'The calendar URL must be HTTPS when provided' })
    return
  }
  try {
    await assertAllowedCalDavUrl(serverUrl)
    if (calendarUrl) {
      await assertAllowedCalDavUrl(calendarUrl)
    }
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'CalDAV URL is not allowed' })
    return
  }

  const now = nowIso()
  const account: StoredCalDavAccount = {
    id: randomUUID(),
    userId: actor.id,
    name,
    serverUrl,
    username,
    password,
    calendarUrl,
    calendarName: undefined,
    shareEventTitles: parseBoolean(request.body.shareEventTitles),
    syncEnabled: true,
    passwordConfigured: true,
    lastSyncStatus: 'never',
    createdAt: now,
    updatedAt: now,
  }

  database.calDavAccounts.unshift(account)
  const { syncedEvents } = await syncCalDavAccountAndRememberStatus(database, account)
  addAudit(database, actor.id, 'caldav_account_created', 'caldav_account', account.id, { syncedEvents })
  saveDatabase(database)
  response.status(201).json(stateForUser(actor))
})

app.patch('/api/caldav/accounts/:id', requireAuth, async (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const account = database.calDavAccounts.find((candidate) => candidate.id === request.params.id && candidate.userId === actor.id)

  if (!account) {
    response.status(404).json({ message: 'CalDAV account not found' })
    return
  }

  const serverUrl = parseHttpsUrl(request.body.serverUrl)
  const username = parseString(request.body.username)
  const passwordInput = typeof request.body.password === 'string' ? request.body.password : ''
  const calendarUrlInput = parseString(request.body.calendarUrl)
  const calendarUrl = calendarUrlInput ? parseHttpsUrl(calendarUrlInput) : undefined

  if (!serverUrl) {
    response.status(400).json({ message: 'A valid HTTPS CalDAV server URL is required' })
    return
  }
  if (!username) {
    response.status(400).json({ message: 'CalDAV username is required' })
    return
  }
  if (calendarUrlInput && !calendarUrl) {
    response.status(400).json({ message: 'The calendar URL must be HTTPS when provided' })
    return
  }
  try {
    await assertAllowedCalDavUrl(serverUrl)
    if (calendarUrl) {
      await assertAllowedCalDavUrl(calendarUrl)
    }
  } catch (error) {
    response.status(error instanceof DatabaseConflictError ? 409 : 400).json({ message: error instanceof Error ? error.message : 'CalDAV URL is not allowed' })
    return
  }

  account.name = parseString(request.body.name) || account.name
  account.serverUrl = serverUrl
  account.username = username
  account.calendarUrl = calendarUrl
  account.shareEventTitles = parseBoolean(request.body.shareEventTitles)
  account.syncEnabled = parseBoolean(request.body.syncEnabled)
  if (passwordInput.length > 0) {
    account.password = passwordInput
  }
  account.updatedAt = nowIso()

  const shouldSync = parseBoolean(request.body.syncNow)
  const { syncedEvents } = shouldSync ? await syncCalDavAccountAndRememberStatus(database, account) : { syncedEvents: undefined }
  addAudit(database, actor.id, 'caldav_account_updated', 'caldav_account', account.id, { syncedEvents })
  saveDatabase(database)
  response.json(stateForUser(actor))
})

app.post('/api/caldav/accounts/:id/sync', requireAuth, async (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const account = database.calDavAccounts.find((candidate) => candidate.id === request.params.id && candidate.userId === actor.id)

  if (!account) {
    response.status(404).json({ message: 'CalDAV account not found' })
    return
  }

  const { syncedEvents } = await syncCalDavAccountAndRememberStatus(database, account)
  addAudit(database, actor.id, 'caldav_account_synced', 'caldav_account', account.id, { syncedEvents })
  saveDatabase(database)
  response.json(stateForUser(actor))
})

app.delete('/api/caldav/accounts/:id', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const actor = database.users.find((candidate) => candidate.id === request.user!.id)!
  const account = database.calDavAccounts.find((candidate) => candidate.id === request.params.id && candidate.userId === actor.id)

  if (!account) {
    response.status(404).json({ message: 'CalDAV account not found' })
    return
  }

  database.calDavAccounts = database.calDavAccounts.filter((candidate) => candidate.id !== account.id)
  database.externalCalendarEvents = database.externalCalendarEvents.filter((event) => event.accountId !== account.id)
  addAudit(database, actor.id, 'caldav_account_deleted', 'caldav_account', account.id)
  saveDatabase(database)
  response.json(stateForUser(actor))
})

app.post('/api/calendar-groups', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const name = parseString(request.body.name)

  if (!name) {
    response.status(400).json({ message: 'Group name is required' })
    return
  }

  const group: CalendarGroup = {
    id: randomUUID(),
    name,
    memberUserIds: parseUserIds(request.body.memberUserIds, database.users),
    createdAt: nowIso(),
  }

  database.calendarGroups.unshift(group)
  addAudit(database, admin.id, 'calendar_group_created', 'calendar_group', group.id)
  saveDatabase(database)
  response.status(201).json(stateForUser(admin))
})

app.patch('/api/calendar-groups/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const group = database.calendarGroups.find((candidate) => candidate.id === request.params.id)
  const name = parseString(request.body.name)

  if (!group) {
    response.status(404).json({ message: 'Group not found' })
    return
  }

  if (!name) {
    response.status(400).json({ message: 'Group name is required' })
    return
  }

  group.name = name
  group.memberUserIds = parseUserIds(request.body.memberUserIds, database.users)
  addAudit(database, admin.id, 'calendar_group_updated', 'calendar_group', group.id)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.delete('/api/calendar-groups/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const groupId = parseString(request.params.id)
  const before = database.calendarGroups.length
  database.calendarGroups = database.calendarGroups.filter((group) => group.id !== groupId)

  if (database.calendarGroups.length === before) {
    response.status(404).json({ message: 'Group not found' })
    return
  }

  addAudit(database, admin.id, 'calendar_group_deleted', 'calendar_group', groupId)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.post('/api/holidays/overrides', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const date = parseString(request.body.date)
  const name = parseString(request.body.name)
  const type = parseString(request.body.type)
  const freePercent = parsePercent(request.body.freePercent)

  if (!date || !name || (type !== 'custom' && type !== 'disabled')) {
    response.status(400).json({ message: 'Date, name, and override type are required' })
    return
  }

  const override = makeHolidayOverride(date, name, type, freePercent, admin.id)
  database.holidayOverrides = database.holidayOverrides.filter((item) => item.date !== date)
  database.holidayOverrides.unshift(override)
  addAudit(database, admin.id, 'holiday_override_created', 'holiday', override.id)
  saveDatabase(database)
  response.status(201).json(stateForUser(admin))
})

app.patch('/api/holidays/overrides/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const overrideId = parseString(request.params.id)
  const override = database.holidayOverrides.find((item) => item.id === overrideId)
  const date = parseString(request.body.date)
  const name = parseString(request.body.name)
  const type = parseString(request.body.type)
  const freePercent = parsePercent(request.body.freePercent)

  if (!override) {
    response.status(404).json({ message: 'Holiday override not found' })
    return
  }

  if (!date || !name || (type !== 'custom' && type !== 'disabled')) {
    response.status(400).json({ message: 'Date, name, and override type are required' })
    return
  }

  override.date = date
  override.name = name
  override.type = type
  override.freePercent = freePercent
  database.holidayOverrides = [
    override,
    ...database.holidayOverrides.filter((item) => item.id !== override.id && item.date !== date),
  ]

  addAudit(database, admin.id, 'holiday_override_updated', 'holiday', override.id)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.delete('/api/holidays/overrides/:id', requireAuth, requireAdmin, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const admin = database.users.find((candidate) => candidate.id === request.user!.id)!
  const overrideId = parseString(request.params.id)
  const before = database.holidayOverrides.length
  database.holidayOverrides = database.holidayOverrides.filter((override) => override.id !== overrideId)

  if (database.holidayOverrides.length === before) {
    response.status(404).json({ message: 'Holiday override not found' })
    return
  }

  addAudit(database, admin.id, 'holiday_override_deleted', 'holiday', overrideId)
  saveDatabase(database)
  response.json(stateForUser(admin))
})

app.patch('/api/notifications/:id/read', requireAuth, (request: AuthedRequest, response) => {
  const database = readDatabase()
  const user = database.users.find((candidate) => candidate.id === request.user!.id)!
  const notification = database.notifications.find(
    (candidate) => candidate.id === request.params.id && candidate.userId === user.id,
  )

  if (!notification) {
    response.status(404).json({ message: 'Notification not found' })
    return
  }

  notification.read = true
  saveDatabase(database)
  response.json(stateForUser(user))
})

void ensureWeeklyBackup().catch((error) => console.error('Initial weekly backup failed', error))
void overtimeMonitor.check().catch(()=>console.error('Overtime policy check failed'))
setInterval(()=>{void overtimeMonitor.check().catch(()=>console.error('Overtime policy check failed'))},60_000).unref()
try {
  enforceAutomaticClockOuts()
} catch (error) {
  console.error('Automatic clock-out check failed', error)
}

setInterval(() => {
  void ensureWeeklyBackup().catch((error) => console.error('Weekly backup check failed', error))
}, 24 * 60 * 60 * 1000)

setInterval(() => {
  try {
    enforceAutomaticClockOuts()
  } catch (error) {
    console.error('Automatic clock-out check failed', error)
  }
}, automaticClockOutCheckMs)

setInterval(() => {
  for (const socket of liveClients.keys()) {
    sendLiveMessage(socket, { type: 'heartbeat', sentAt: nowIso() })
  }
}, 25_000)

app.use(handleJsonParseError)
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if(error instanceof OvertimePolicyError) { response.status(error.status).json({message:error.message});return }
  if (error instanceof ZeitguruHistoryStoreError || error instanceof ZeitguruAccountingError) {
    response.status(error.status).json({ message: error.message, code: error.code }); return
  }
  if (error instanceof ZeitguruBridgeError || error instanceof ZeitguruStoreError) {
    const failure = zeitguruPublicError(error); response.status(failure.status).json(failure.body); return
  }
  if (error instanceof CoreAuthError || error instanceof DatabaseConflictError) {
    response.status(error instanceof CoreAuthError ? error.status : 409).json({ message: error.message })
    return
  }
  console.error('Time request failed', error)
  response.status(500).json({ message: 'The operation could not be completed. Please try again.' })
})

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/.*/, (_request, response) => response.sendFile(indexHtmlPath))
}

httpServer.listen(port, host, () => {
  console.info(`Digital Core Office Time listening on http://${host}:${port}`)
})
