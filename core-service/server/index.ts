import express, { type NextFunction, type Request, type Response } from 'express'
import nodemailer from 'nodemailer'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operatorPage } from './operatorPages.ts'
import {
  authenticate,
  approveQrLoginChallenge,
  changePassword,
  claimQrLoginChallenge,
  completePasswordReset,
  createQrLoginChallenge,
  createPasswordReset,
  createSession,
  databasePath,
  deleteSession,
  enabledModules,
  licenseState,
  moduleAccess,
  moduleIdentity,
  moduleIds,
  normalizedEmail,
  listUsers,
  saveUser,
  setLicenseKey,
  userForSession,
  type CoreUser,
} from './core.ts'

interface AuthedRequest extends Request { coreUser?: CoreUser; coreToken?: string }

export const app = express()
const port = Number(process.env.PORT ?? 4167)
const host = process.env.HOST ?? '0.0.0.0'
const coreCookieName = process.env.DCO_CORE_COOKIE_NAME?.trim() || 'dco_core_session'
const ssoCookieName = process.env.DIGITAL_OFFICE_SSO_COOKIE_NAME?.trim() || 'digital_office_sso'
const cookieDomain = process.env.DIGITAL_OFFICE_COOKIE_DOMAIN?.trim()
const baseUrl = (process.env.DCO_PUBLIC_BASE_URL ?? 'http://localhost:4167').replace(/\/+$/, '')
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const qrChallengeBuckets = new Map<string, { count: number; resetAt: number }>()
const resetAttempts = new Map<string, { count: number; resetAt: number }>()
const moduleDir = dirname(fileURLToPath(import.meta.url))
const clientDist = join(moduleDir, '..', 'dist')
const clientIndex = join(clientDist, 'index.html')

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(securityHeaders)
app.use(express.json({ limit: '1mb' }))
app.use((request, response, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.header('origin')
    if ((origin && origin !== new URL(baseUrl).origin) || request.header('sec-fetch-site') === 'cross-site') {
      response.status(403).json({ message: 'Request origin is not allowed.' })
      return
    }
  }
  if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store')
  next()
})

app.get('/.well-known/assetlinks.json', (_request, response) => {
  response.type('application/json').sendFile(join(clientDist, '.well-known', 'assetlinks.json'), { dotfiles: 'allow' })
})
for (const page of ['imprint', 'privacy', 'support'] as const) {
  app.get(`/${page}.html`, (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.type('html').send(operatorPage(page))
  })
}
app.get('/api/health', (_request, response) => response.json({
  ok: true,
  service: 'digital-core-office-core',
  apiVersion: 1,
  dataFile: databasePath(),
  modules: enabledModules().map((item) => item.id),
}))
app.get('/api/core/modules', (_request, response) => response.json({ modules: accessibleModules() }))

app.get('/api/core/session', requireCoreAuth, (request: AuthedRequest, response) => {
  response.json({ user: request.coreUser, modules: accessibleModules(request.coreUser), license: request.coreUser?.role === 'admin' ? licenseState() : undefined })
})

app.post('/api/core/auth/login', (request, response) => {
  const keys = loginKeys(request.ip || 'unknown', request.body?.email)
  if (!keys.every((key) => loginAllowed(key))) {
    response.status(429).json({ message: 'Too many sign-in attempts. Try again later.' })
    return
  }
  const user = authenticate(request.body?.email, request.body?.password)
  if (!user) {
    keys.forEach(registerFailedLogin)
    response.status(401).json({ message: 'Email or password is incorrect.' })
    return
  }
  loginAttempts.delete(keys[0]!)
  const previousSessionToken = cookieValue(request, coreCookieName)
  if (previousSessionToken) deleteSession(previousSessionToken)
  const persistent = request.body?.stayLoggedIn === true
  const session = createSession(user.id, persistent)
  response.setHeader('Set-Cookie', [
    cookie(coreCookieName, session.token, request, persistent ? 30 * 24 * 60 * 60 : undefined),
    clearCookie(ssoCookieName, request),
  ])
  response.json({ user, modules: accessibleModules(user), license: user.role === 'admin' ? licenseState() : undefined, mustChangePassword: user.mustChangePassword })
})

app.post('/api/core/internal/login', requireInternalSecret, (request, response) => {
  const keys = loginKeys(String(request.body?.clientIp || request.ip || 'unknown'), request.body?.email)
  if (!keys.every((key) => loginAllowed(key))) { response.status(429).json({ message: 'Too many sign-in attempts. Try again later.' }); return }
  const user = authenticate(request.body?.email, request.body?.password)
  if (!user) { keys.forEach(registerFailedLogin); response.status(401).json({ message: 'Email or password is incorrect.' }); return }
  loginAttempts.delete(keys[0]!)
  if (typeof request.body?.previousSessionToken === 'string') deleteSession(request.body.previousSessionToken)
  const session = createSession(user.id, request.body?.stayLoggedIn === true)
  response.json({ user, sessionToken: session.token, expiresAt: session.expiresAt })
})

app.post('/api/core/auth/qr-login/challenges', (request, response) => {
  if (!qrChallengeAllowed(request.ip ?? 'unknown')) {
    response.status(429).json({ message: 'Too many QR sign-in requests. Try again shortly.' })
    return
  }
  response.status(201).json(createQrLoginChallenge())
})

app.post('/api/core/auth/qr-login/challenges/approve', requireCoreAuth, (request: AuthedRequest, response) => {
  const user = request.coreUser!
  if (user.mustChangePassword) {
    response.status(403).json({ message: 'Change your password before approving another sign-in.' })
    return
  }
  if (request.body?.expectedUserId !== user.id) {
    response.status(409).json({ message: 'Your account has changed. Sign in again before approving another device.' })
    return
  }
  try {
    response.json(approveQrLoginChallenge(request.body?.token, user.email))
  } catch {
    response.status(400).json({ message: 'QR sign-in is invalid, expired or already used.' })
  }
})

app.post('/api/core/auth/qr-login/challenges/claim', (request, response) => {
  const result = claimQrLoginChallenge(request.body?.token)
  if (result.status === 'invalid') {
    response.status(401).json({ message: 'QR sign-in is invalid or expired.' })
    return
  }
  if (result.status === 'pending') {
    response.status(202).json({ pending: true, expiresAt: result.expiresAt })
    return
  }
  const previousSessionToken = cookieValue(request, coreCookieName)
  if (previousSessionToken) deleteSession(previousSessionToken)
  const session = createSession(result.user.id, false)
  response.setHeader('Set-Cookie', [
    cookie(coreCookieName, session.token, request),
    clearCookie(ssoCookieName, request),
  ])
  response.json({
    user: result.user,
    modules: accessibleModules(result.user),
    license: result.user.role === 'admin' ? licenseState() : undefined,
  })
})

app.post('/api/core/auth/logout', (request, response) => {
  const token = cookieValue(request, coreCookieName) ?? request.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (token) deleteSession(token)
  response.setHeader('Set-Cookie', [coreCookieName, ssoCookieName, 'inventory_session'].map((name) => clearCookie(name, request)))
  response.status(204).end()
})

app.post('/api/core/auth/change-password', requireCoreAuth, (request: AuthedRequest, response) => {
  try {
    changePassword(request.coreUser!.id, request.body?.currentPassword, request.body?.password)
    response.setHeader('Set-Cookie', [clearCookie(coreCookieName, request), clearCookie(ssoCookieName, request)])
    response.status(204).end()
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'Password could not be changed.' })
  }
})

app.post('/api/core/auth/password-reset/request', async (request, response) => {
  if (!resetAllowed(`ip:${request.ip}`, 10) || !resetAllowed(`email:${normalizedEmail(request.body?.email)}`, 3)) {
    response.status(429).json({ message: 'Too many reset requests. Please try again later.' })
    return
  }
  const reset = createPasswordReset(request.body?.email)
  if (reset) {
    const link = `${baseUrl}/?reset=${encodeURIComponent(reset.token)}`
    try {
      await sendResetMail(reset.user.email, reset.user.name, link)
    } catch (error) {
      console.error('Core password-reset email failed', error)
    }
    if (process.env.NODE_ENV !== 'production' && process.env.DCO_DEV_EXPOSE_RESET_TOKEN === 'true') {
      response.json({ accepted: true, resetToken: reset.token, expiresAt: reset.expiresAt })
      return
    }
  }
  response.json({ accepted: true })
})

app.post('/api/core/auth/password-reset/complete', (request, response) => {
  try {
    const user = completePasswordReset(String(request.body?.token ?? ''), request.body?.password)
    response.json({ completed: true, user })
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'Password reset failed.' })
  }
})

app.post('/api/core/internal/introspect', requireInternalSecret, (request, response) => {
  const token = String(request.body?.token ?? cookieValue(request, coreCookieName) ?? '')
  const user = userForSession(token)
  if (!user) {
    response.status(401).json({ active: false, message: 'Sign in to Digital Core Office.' })
    return
  }
  if (user.mustChangePassword && request.body?.allowPasswordChange !== true) {
    response.status(403).json({ message: 'Change your password in Digital Core Office before opening a system.' }); return
  }
  const moduleId = request.body?.moduleId
  if (!moduleIds.includes(moduleId)) { response.status(400).json({ message: 'A valid module is required.' }); return }
  const identity = moduleIdentity(user, moduleId)
  if (!identity) { response.status(403).json({ message: 'You do not have access to this system.' }); return }
  if (request.body?.write === true && identity.readOnly) { response.status(403).json({ message: 'This system is read-only. You can still view and export your data.' }); return }
  response.json({ active: true, user: identity, modules: accessibleModules(user) })
})

// Background Time alerts recheck recipient authority without retaining an administrator session.
app.post('/api/core/internal/time-alert-recipients', requireInternalSecret, (request, response) => {
  const ids=request.body?.userIds
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>128)){response.status(400).json({message:'Invalid recipient selection.'});return}
  const selected=new Set(ids)
  const recipients=listUsers().filter(user=>selected.has(user.id)&&user.active&&!user.mustChangePassword)
    .flatMap(user=>{const identity=moduleIdentity(user,'time');return identity?.moduleRole==='admin'&&!identity.readOnly?[{id:user.id,email:user.email}]:[]})
  response.json({recipients})
})

// Background inventory integrations recheck account/module authority without storing a Core session.
app.post('/api/core/internal/inventory-integration-users', requireInternalSecret, (request, response) => {
  const ids = request.body?.userIds
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || id.length > 128)) {
    response.status(400).json({ message: 'Invalid user selection.' }); return
  }
  const selected = new Set(ids)
  const userIds = listUsers().filter(user => selected.has(user.id) && user.active && !user.mustChangePassword)
    .filter(user => { const identity = moduleIdentity(user, 'inventory'); return identity && !identity.readOnly })
    .map(user => user.id)
  response.json({ userIds })
})

app.post('/api/core/internal/qr-login/challenges/approve', requireInternalSecret, (request, response) => {
  try {
    const user = userForSession(String(request.body?.sessionToken || ''))
    if (!user || user.mustChangePassword) { response.status(401).json({ message: 'A current Core session is required to approve sign-in.' }); return }
    response.json(approveQrLoginChallenge(request.body?.token, user.email))
  } catch (error) {
    response.status(401).json({ message: error instanceof Error ? error.message : 'QR sign-in could not be approved.' })
  }
})

app.get('/api/core/internal/route-check', requireInternalSecret, (request, response) => {
  const requested = String(request.query.module ?? '')
  // Modules enforce authoritative identity and read-only licensing for each API request.
  // Keep their read/export UI available when a license needs attention.
  const access = moduleAccess(requested, 'read')
  if (!access.allowed) {
    response.status(access.reason === 'disabled' || access.reason === 'unknown_module' ? 404 : 402).json({
      message: access.reason === 'disabled' || access.reason === 'unknown_module'
        ? 'This Digital Core Office module is not enabled.'
        : 'The suite license does not currently permit this module.',
      reason: access.reason,
    })
    return
  }
  response.status(204).end()
})

app.get('/api/core/license', requireAdmin, (_request, response) => response.json(licenseState()))
app.get('/api/core/users', requireAdmin, (_request, response) => response.json({ users: listUsers() }))
app.post('/api/core/users', requireAdmin, (request: AuthedRequest, response) => {
  try { response.status(201).json({ user: saveUser(request.coreUser!.id, request.body) }) }
  catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : 'User could not be created.' }) }
})
app.patch('/api/core/users/:id', requireAdmin, (request: AuthedRequest, response) => {
  try { response.json({ user: saveUser(request.coreUser!.id, request.body, String(request.params.id)) }) }
  catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : 'User could not be updated.' }) }
})
app.delete('/api/core/users/:id', requireAdmin, (request: AuthedRequest, response) => {
  try { response.json({ user: saveUser(request.coreUser!.id, { active: false }, String(request.params.id)) }) }
  catch (error) { response.status(400).json({ message: error instanceof Error ? error.message : 'User could not be deactivated.' }) }
})
app.put('/api/core/license', requireAdmin, (request: AuthedRequest, response) => {
  try {
    response.json(setLicenseKey(String(request.body?.licenseKey ?? ''), request.coreUser!.id))
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'License could not be saved.' })
  }
})

app.use(express.static(clientDist, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1y' : 0 }))
app.get(/.*/, (_request, response) => {
  if (!existsSync(clientIndex)) {
    response.status(503).type('text/plain').send('Digital Core Office client is not built.')
    return
  }
  response.sendFile(clientIndex)
})

function parseCookies(header: string | undefined) {
  const result = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0) result.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  return result
}

function accessibleModules(user?: CoreUser) {
  return enabledModules().filter((module) => user ? Boolean(moduleIdentity(user, module.id)) : moduleAccess(module.id, 'read').allowed)
    .map((module) => ({ ...module, readOnly: user ? moduleIdentity(user, module.id)?.readOnly : false }))
}

function cookieValue(request: Request, name: string) {
  return parseCookies(request.header('cookie')).get(name)
}

function secureRequest(request: Request) {
  return request.secure || request.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
}

function cookie(name: string, value: string, request: Request, maxAge?: number) {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    cookieDomain ? `Domain=${cookieDomain}` : '',
    maxAge ? `Max-Age=${maxAge}` : '',
    secureRequest(request) ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}

function clearCookie(name: string, request: Request) {
  return [cookie(name, '', request), 'Max-Age=0'].join('; ')
}

function requireCoreAuth(request: AuthedRequest, response: Response, next: NextFunction) {
  const token = cookieValue(request, coreCookieName) ?? request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const user = userForSession(token)
  if (!user) {
    response.status(401).json({ message: 'Sign in to Digital Core Office.' })
    return
  }
  request.coreUser = user
  request.coreToken = token
  next()
}

function requireAdmin(request: AuthedRequest, response: Response, next: NextFunction) {
  requireCoreAuth(request, response, () => {
    if (request.coreUser?.role !== 'admin' || request.coreUser.mustChangePassword) {
      response.status(403).json({ message: 'Administrator access is required.' })
      return
    }
    next()
  })
}

function requireInternalSecret(request: Request, response: Response, next: NextFunction) {
  const expected = process.env.DCO_INTERNAL_AUTH_SECRET
  if (!expected || request.header('x-dco-internal-secret') !== expected) {
    response.status(403).json({ message: 'Internal authentication failed.' })
    return
  }
  next()
}

function loginAllowed(key: string) {
  const current = loginAttempts.get(key)
  if (!current || current.resetAt <= Date.now()) return true
  return current.count < (key.startsWith('ip:') ? 40 : 8)
}

function loginKeys(ip: string, email: unknown) { return [`account:${normalizedEmail(email)}`, `ip:${ip}`] }

function resetAllowed(key: string, limit: number) {
  const now = Date.now()
  if (resetAttempts.size > 5_000) for (const [item, value] of resetAttempts) if (value.resetAt <= now) resetAttempts.delete(item)
  const current = resetAttempts.get(key)
  if (current && current.resetAt > now) { if (current.count >= limit) return false; current.count += 1; return true }
  resetAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 })
  return true
}

function registerFailedLogin(key: string) {
  if (loginAttempts.size > 5_000) for (const [item, value] of loginAttempts) if (value.resetAt <= Date.now()) loginAttempts.delete(item)
  const current = loginAttempts.get(key)
  loginAttempts.set(key, current && current.resetAt > Date.now()
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: Date.now() + 15 * 60 * 1000 })
}

function qrChallengeAllowed(key: string) {
  const now = Date.now()
  const current = qrChallengeBuckets.get(key)
  if (!current || current.resetAt <= now) {
    qrChallengeBuckets.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (current.count >= 20) return false
  current.count += 1
  return true
}

async function sendResetMail(email: string, name: string, link: string) {
  if (!process.env.SMTP_HOST) {
    console.warn('Password reset delivery is unavailable. Configure SMTP_HOST.')
    return
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  })
  await transport.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: email,
    subject: 'Digital Core Office password reset',
    text: `Hello ${name},\n\nUse this link within one hour to reset your password:\n${link}\n`,
  })
}

function securityHeaders(request: Request, response: Response, next: NextFunction) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // Firefox checks embedded module Blob downloads against the parent frame-src policy.
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
  if (secureRequest(request)) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(app).listen(port, host, () => {
    console.log(`Digital Core Office Core listening on http://${host}:${port} with modules ${enabledModules().map((item) => item.id).join(', ')}`)
  })
}
