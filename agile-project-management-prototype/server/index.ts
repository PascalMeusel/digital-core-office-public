import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreEnabled, requireCoreIdentity, loginWithCore, logoutFromCore, coreTokenForRequest, coreSessionCookie } from '../../packages/core-client/index.ts'
import { mutateWorkspace, readWorkspace, readWorkspaceAudit, WorkspaceError } from './workspace.ts'
import {
  agileDataFilePath,
  authenticate,
  createSession,
  deleteSession,
  userFromSessionToken,
  userByEmailAddress,
  connection,
  upsertCoreProfile,
  type AgileUser,
} from './userbase.ts'

interface AuthedRequest extends Request {
  user?: AgileUser
  token?: string
  readOnly?: boolean
}

export const app = express()
const port = Number(process.env.PORT ?? 4197)
const host = process.env.HOST ?? '0.0.0.0'
const moduleDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(moduleDir, '..', 'dist')
const indexHtmlPath = join(distDir, 'index.html')
const digitalOfficeSsoCookieName = process.env.DIGITAL_OFFICE_SSO_COOKIE_NAME?.trim() || 'digital_office_sso'
const digitalOfficeSsoSecret = process.env.DIGITAL_OFFICE_SSO_SECRET ?? process.env.AGILE_PROJECT_SSO_SECRET ?? randomBytes(32).toString('hex')
const digitalOfficeCookieDomain = process.env.DIGITAL_OFFICE_COOKIE_DOMAIN?.trim()
const sessionDurationMs = 12 * 60 * 60 * 1000
const persistentSessionDurationMs = 30 * 24 * 60 * 60 * 1000

app.disable('x-powered-by')
app.use(securityHeaders)
app.use(cors({ origin: normalizeOrigin(process.env.CORS_ORIGIN), credentials: true }))
app.use(express.json({ limit: '8mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, dataFile: agileDataFilePath() })
})

app.post('/api/agile/auth/login', async (request, response) => {
  if (coreEnabled()) {
    try {
      const result = await loginWithCore(request, request.body?.email, request.body?.password, request.body?.stayLoggedIn === true)
      response.setHeader('Set-Cookie', coreSessionCookie(request, result.sessionToken, request.body?.stayLoggedIn === true))
      response.json({ user: result.user, token: '', expiresAt: result.expiresAt })
    } catch (error) { sendError(response, error) }
    return
  }
  if (process.env.DISABLE_LOCAL_WEB_LOGIN === 'true') {
    response.status(409).json({
      message: 'Sign in through Digital Core Office.',
      loginUrl: process.env.DCO_CORE_LOGIN_URL || '/',
    })
    return
  }
  const body = request.body as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const stayLoggedIn = body.stayLoggedIn === true
  const user = authenticate(email, password)
  if (!user) {
    response.status(401).json({ message: 'Email or password is incorrect.' })
    return
  }

  const session = createSession(user.id, stayLoggedIn)
  response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, user, stayLoggedIn))
  response.json({ user, token: session.token, expiresAt: session.expiresAt })
})

app.get('/api/agile/auth/sso-session', async (request, response) => {
  if (coreEnabled()) {
    try {
      const identity = await requireCoreIdentity(request, 'agile', { write: false })
      response.json({ user: upsertCoreProfile(identity), token: '', stayLoggedIn: false })
    } catch (error) { sendError(response, error) }
    return
  }
  const sso = digitalOfficeSsoForRequest(request)
  const user = sso ? userByEmailAddress(sso.email) : undefined
  if (!sso || !user) {
    response.status(401).json({ message: 'Sign in to continue.' })
    return
  }

  const session = createSession(user.id, sso.stayLoggedIn)
  response.json({ user, token: session.token, expiresAt: session.expiresAt, stayLoggedIn: sso.stayLoggedIn })
})

app.get('/api/agile/auth/session', requireAuth, (request: AuthedRequest, response) => {
  response.json({ user: request.user })
})

app.post('/api/agile/auth/logout', async (request: AuthedRequest, response) => {
  if (coreEnabled()) {
    try { await logoutFromCore(request); response.setHeader('Set-Cookie', coreSessionCookie(request, '')); response.status(204).end() } catch (error) { sendError(response, error) }
    return
  }
  request.token = bearerToken(request)
  deleteSession(request.token ?? '')
  response.setHeader('Set-Cookie', clearDigitalOfficeSsoCookie(request))
  response.status(204).end()
})

app.get('/api/agile/workspace', requireAuth, (request: AuthedRequest, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try { response.json(readWorkspace(connection(), { ...request.user!, readOnly: request.readOnly })) } catch (error) { sendError(response, error) }
})
app.post('/api/agile/workspace/commands', requireAuth, (request: AuthedRequest, response) => {
  try { response.json(mutateWorkspace(connection(), { ...request.user!, readOnly: request.readOnly }, request.body)) }
  catch (error) { sendError(response, error) }
})
app.get('/api/agile/workspace/audit', requireAuth, (request: AuthedRequest, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try { response.json({ entries: readWorkspaceAudit(connection(), request.user!) }) } catch (error) { sendError(response, error) }
})
app.get('/api/agile/workspace/export', requireAuth, (request: AuthedRequest, response) => {
  try {
    const snapshot = readWorkspace(connection(), request.user!)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Disposition', 'attachment; filename="digital-core-office-agile.json"')
    response.json({ format: 'digital-core-office-agile', version: 1, exportedAt: new Date().toISOString(), ...snapshot, audit: readWorkspaceAudit(connection(), request.user!) })
  } catch (error) { sendError(response, error) }
})

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/.*/, (_request, response) => {
    response.sendFile(indexHtmlPath)
  })
}

function securityHeaders(request: Request, response: Response, next: NextFunction) {
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'SAMEORIGIN')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'sha256-7DIDcFh49/rstBlTF4u+4Eei3oKsEUyHrAh99b7eGrA='",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
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

function normalizeOrigin(value: string | undefined) {
  return value?.trim().replace(/\/+$/, '')
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

function safeStringCompare(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

function signDigitalOfficeSsoPayload(encodedPayload: string) {
  return createHmac('sha256', digitalOfficeSsoSecret).update(encodedPayload).digest('base64url')
}

function digitalOfficeSsoCookieValue(user: AgileUser, stayLoggedIn: boolean) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      email: user.email.toLowerCase(),
      stayLoggedIn,
      expiresAt: Date.now() + (stayLoggedIn ? persistentSessionDurationMs : sessionDurationMs),
    }),
  ).toString('base64url')
  return `v1.${encodedPayload}.${signDigitalOfficeSsoPayload(encodedPayload)}`
}

function digitalOfficeSsoCookie(request: Request, user: AgileUser, stayLoggedIn: boolean) {
  return [
    `${digitalOfficeSsoCookieName}=${digitalOfficeSsoCookieValue(user, stayLoggedIn)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    digitalOfficeCookieDomain ? `Domain=${digitalOfficeCookieDomain}` : '',
    stayLoggedIn ? `Max-Age=${Math.floor(persistentSessionDurationMs / 1000)}` : '',
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
  if (!safeStringCompare(signDigitalOfficeSsoPayload(encodedPayload), signature)) {
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

function bearerToken(request: Request) {
  return (request.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

async function requireAuth(request: AuthedRequest, response: Response, next: NextFunction) {
  if (coreEnabled()) {
    try {
      const identity = await requireCoreIdentity(request, 'agile')
      request.user = upsertCoreProfile(identity)
      request.readOnly = identity.readOnly || identity.moduleRole === 'viewer'
      request.token = coreTokenForRequest(request)
      next()
    } catch (error) { sendError(response, error) }
    return
  }
  const token = bearerToken(request)
  const user = userFromSessionToken(token)
  if (!user) {
    response.status(401).json({ message: 'Sign in to continue.' })
    return
  }

  request.user = user
  request.token = token
  next()
}

function sendError(response: Response, error: unknown) {
  const status = error instanceof WorkspaceError ? error.status : typeof (error as {status?: unknown})?.status === 'number' ? (error as {status: number}).status : 500
  response.status(status).json({ message: error instanceof Error ? error.message : 'Agile request failed.' })
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  createServer(app).listen(port, host, () => {
    console.log(`Agile project management listening on http://${host}:${port}`)
  })
}
