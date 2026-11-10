/** Server-only adapter. In suite mode Core is the sole credential/session authority. */
export type CoreModuleId = 'time' | 'inventory' | 'agile'
export interface CoreIdentity {
  id: string
  name: string
  email: string
  role: 'admin' | 'employee'
  active: boolean
  mustChangePassword: boolean
  moduleRole: string
  readOnly: boolean
}
export interface CoreRequest {
  header(name: string): string | undefined
  method: string
  ip?: string
  secure?: boolean
}
export class CoreAuthError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function coreEnabled() { return Boolean(process.env.DCO_CORE_URL?.trim()) }

export function coreCookieTokenForRequest(request: CoreRequest) {
  const name = process.env.DCO_CORE_COOKIE_NAME?.trim() || 'dco_core_session'
  const cookies = (request.header('cookie') || '').split(';')
  for (const part of cookies) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

export function coreTokenForRequest(request: CoreRequest) {
  return coreCookieTokenForRequest(request) ?? request.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
}

function checkOrigin(request: CoreRequest, explicitLogin = false) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return
  const cookieName = process.env.DCO_CORE_COOKIE_NAME?.trim() || 'dco_core_session'
  const hasCoreCookie = (request.header('cookie') || '').split(';').some((part) => part.trim().startsWith(`${cookieName}=`))
  // Bearer clients do not use ambient credentials; never let a client flag bypass cookie CSRF checks.
  if (!explicitLogin && !hasCoreCookie && /^Bearer\s+\S/i.test(request.header('authorization') || '')) return
  const origin = request.header('origin')
  if (!hasCoreCookie && explicitLogin && ['https://localhost', 'http://localhost', 'capacitor://localhost'].includes(origin || '')) return
  const configured = process.env.DCO_CORE_LOGIN_URL || process.env.DCO_PUBLIC_BASE_URL
  const expected = configured && /^https?:\/\//.test(configured) ? new URL(configured).origin
    : `${request.header('x-forwarded-proto')?.split(',')[0]?.trim() || (request.secure ? 'https' : 'http')}://${request.header('host') || 'localhost'}`
  if (origin && origin !== expected) throw new CoreAuthError(403, 'Request origin is not allowed.')
  if (request.header('sec-fetch-site') === 'cross-site') throw new CoreAuthError(403, 'Cross-site requests are not allowed.')
}

async function callCore<T>(path: string, body?: unknown, token?: string, method = 'POST'): Promise<T> {
  const base = process.env.DCO_CORE_URL?.trim().replace(/\/+$/, '')
  const secret = process.env.DCO_INTERNAL_AUTH_SECRET?.trim()
  if (!base || !secret) throw new CoreAuthError(503, 'Core authentication is not configured.')
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-DCO-Internal-Secret': secret, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    })
  } catch {
    throw new CoreAuthError(503, 'Core is temporarily unavailable. Please try again.')
  }
  const result = (response.status === 204 ? undefined : await response.json().catch(() => undefined)) as { message?: string } | undefined
  if (!response.ok) throw new CoreAuthError(response.status, result?.message || 'Core authentication failed.')
  return result as T
}

export async function requireCoreIdentity(
  request: CoreRequest,
  moduleId: CoreModuleId,
  options: { write?: boolean; allowPasswordChange?: boolean } = {},
): Promise<CoreIdentity> {
  checkOrigin(request)
  const token = coreTokenForRequest(request)
  if (!token) throw new CoreAuthError(401, 'Sign in to Digital Core Office.')
  const result = await callCore<{ user: CoreIdentity }>('/api/core/internal/introspect', {
    token, moduleId,
    write: options.write ?? !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()),
    allowPasswordChange: options.allowPasswordChange === true,
  })
  return result.user
}

export async function loginWithCore(request: CoreRequest, email: unknown, password: unknown, stayLoggedIn = false) {
  checkOrigin(request, true)
  return callCore<{ user: CoreIdentity; sessionToken: string; expiresAt: string }>('/api/core/internal/login', {
    email, password, stayLoggedIn, clientIp: request.ip || 'unknown', previousSessionToken: coreCookieTokenForRequest(request),
  })
}

export async function coreTimeAlertRecipients(userIds: string[]) {
  return (await callCore<{recipients:{id:string;email:string}[]}>('/api/core/internal/time-alert-recipients',{userIds})).recipients
}

export async function coreInventoryIntegrationUsers(userIds: string[]) {
  return (await callCore<{ userIds: string[] }>('/api/core/internal/inventory-integration-users', { userIds })).userIds
}

export async function logoutFromCore(request: CoreRequest) {
  checkOrigin(request)
  const token = coreTokenForRequest(request)
  if (token) await callCore('/api/core/auth/logout', {}, token)
}

export async function approveCoreQr(request: CoreRequest, challengeToken: string) {
  checkOrigin(request)
  return callCore('/api/core/internal/qr-login/challenges/approve', { token: challengeToken, sessionToken: coreTokenForRequest(request) })
}

export async function coreUserRequest<T = unknown>(request: CoreRequest, method: string, path: string, body?: unknown): Promise<T> {
  checkOrigin(request)
  if (!/^\/api\/core\/users(?:\/[A-Za-z0-9_-]+)?$/.test(path)) throw new CoreAuthError(400, 'Unsupported Core user operation.')
  return callCore<T>(path, body, coreTokenForRequest(request), method)
}

export async function coreAccountRequest<T = unknown>(request: CoreRequest, method: string, path: string, body?: unknown): Promise<T> {
  checkOrigin(request)
  if (method !== 'POST' || !['/api/core/auth/change-password', '/api/core/auth/password-reset/request', '/api/core/auth/password-reset/complete'].includes(path)) throw new CoreAuthError(400, 'Unsupported Core account operation.')
  return callCore<T>(path, body, coreTokenForRequest(request), method)
}

export function coreSessionCookie(request: CoreRequest, token: string, persistent = false) {
  const domain = process.env.DIGITAL_OFFICE_COOKIE_DOMAIN?.trim()
  const secure = request.secure || request.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  return [
    `${process.env.DCO_CORE_COOKIE_NAME || 'dco_core_session'}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    ...(domain ? [`Domain=${domain}`] : []), ...(secure ? ['Secure'] : []),
    ...(persistent ? ['Max-Age=2592000'] : []), ...(!token ? ['Max-Age=0'] : []),
  ].join('; ')
}
