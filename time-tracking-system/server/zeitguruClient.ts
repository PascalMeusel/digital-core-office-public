import { createHash } from 'node:crypto'
import {
  zeitguruAddDays, zeitguruIdentifier, zeitguruRecord, zeitguruWallTime,
  type ZeitguruBinding, type ZeitguruClockRow, type ZeitguruObject, type ZeitguruSnapshot,
} from './zeitguruProtocol.ts'

/** Public web application configuration; this is not an employee credential. */
const firebaseApiKey = 'configure-provider-public-api-key'
const projectId = 'aplano-production'
const apiOrigin = 'https://web.aplano.de'
const databaseOrigin = 'https://aplano-production.firebaseio.com'
// Synthetic tenant pin for this source snapshot; configure for an authorized evaluation.
export const zeitguruCompanyTenantSha256 = '222f121391f101282f2a83c239990327b16aea9b60ad39801db9116e793e6590'

/** Server-only secrets. Never serialize to public state, logs, errors or audit details. */
export interface ZeitguruTokens { idToken: string; refreshToken: string; expiresAt: number }
export interface ZeitguruRead<T> { value: T; etag?: string }
export class ZeitguruClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status = 502) {
    super(code === 'authentication_required' ? 'Zeitguru sign-in is required.' : 'Zeitguru could not safely complete the requested read.')
    this.name = 'ZeitguruClientError'; this.code = code; this.status = status
  }
}
const fail = (code: string, status?: number): never => { throw new ZeitguruClientError(code, status) }
function tokenString(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32_768 || /[\r\n]/.test(value)) return fail('invalid_provider_response')
  return value
}
function providerObject(value: unknown) {
  try { return zeitguruRecord(value) } catch { return fail('invalid_provider_response') }
}
function identifier(value: unknown) {
  try { return zeitguruIdentifier(value) } catch { return fail('invalid_provider_identity', 409) }
}
function sameIdentity(actual: ZeitguruBinding, expected: ZeitguruBinding) {
  if (actual.tenantId !== expected.tenantId || actual.userId !== expected.userId || actual.accountId !== expected.accountId || actual.role !== expected.role) fail('identity_mismatch', 409)
}
function collection(value: unknown) {
  return value === null ? [] : Object.values(providerObject(value)).map(providerObject)
}
function identityText(value: unknown) {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.length > 4096) return fail('invalid_provider_response')
  if (!value.startsWith('-cryp-')) return value
  const encoded = value.slice(6)
  if (!encoded || encoded.length % 2 || !/^[a-fA-F0-9]+$/.test(encoded)) return fail('invalid_provider_response')
  // Legacy public-client obfuscation, not encryption. Normalize exactly the identity fields
  // Zeitguru itself decodes; authentication remains the Firebase account/tenant/user binding.
  const mask = [...'wayTooSalty'].reduce((result, character) => result ^ character.charCodeAt(0), 0)
  return encoded.match(/.{2}/g)!.map((pair) => String.fromCharCode(Number.parseInt(pair, 16) ^ mask)).join('')
}

/** Authentication and narrow reads only. This class deliberately has no database write operation. */
export class ZeitguruClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  constructor(options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch; this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 15_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) fail('invalid_configuration', 500)
  }
  private async request(url: URL | string, init: RequestInit = {}): Promise<ZeitguruRead<unknown>> {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' })
      // A URL may contain the Firebase token. Never propagate URL, status text or provider error body.
      if (!response.ok) {
        if (response.status === 401) fail('authentication_required', 401)
        if (response.status === 403) fail('permission_denied', 403)
        if (response.status === 429) fail('rate_limited', 429)
        fail('provider_request_failed')
      }
      if (Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) fail('invalid_provider_response')
      // Enforce the same limit for chunked responses, before buffering an unbounded body.
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > 2 * 1024 * 1024) { await reader.cancel(); return fail('invalid_provider_response') }
            chunks.push(next.value)
          }
        } finally { reader.releaseLock() }
      }
      const body = Buffer.concat(chunks, size).toString('utf8')
      let value: unknown
      try { value = JSON.parse(body) } catch { return fail('invalid_provider_response') }
      const etag = response.headers.get('etag')
      return { value, ...(etag ? { etag } : {}) }
    } catch (error) {
      if (error instanceof ZeitguruClientError) throw error
      return fail(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable')
    } finally { clearTimeout(timeout) }
  }
  private async post(url: string, value: ZeitguruObject, bearer?: string) {
    return (await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(value) })).value
  }
  private bindingFromToken(idToken: string): ZeitguruBinding {
    let claims: ZeitguruObject
    try {
      const parts = tokenString(idToken).split('.')
      if (parts.length !== 3) return fail('authentication_required', 401)
      claims = providerObject(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
    } catch { return fail('authentication_required', 401) }
    // Tokens only enter through Google's TLS token exchange/refresh. Database reads additionally
    // authenticate the token remotely; decoding by itself is never proof of a browser-supplied identity.
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) return fail('authentication_required', 401)
    const binding = { accountId: identifier(claims.sub), tenantId: identifier(claims.tenantId), userId: identifier(claims.userId), role: String(claims.role) }
    if (createHash('sha256').update(binding.tenantId).digest('hex') !== zeitguruCompanyTenantSha256) return fail('tenant_mismatch', 403)
    if (!['employee', 'manager', 'admin'].includes(binding.role) || claims.isDeleted || (typeof claims.lastWorkDay === 'string' && claims.lastWorkDay < zeitguruWallTime(this.now()).date)) return fail('permission_denied', 403)
    return binding
  }
  private tokens(value: ZeitguruObject, refreshing = false): ZeitguruTokens {
    const seconds = Number(value[refreshing ? 'expires_in' : 'expiresIn'])
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) return fail('invalid_provider_response')
    return { idToken: tokenString(value[refreshing ? 'id_token' : 'idToken']), refreshToken: tokenString(value[refreshing ? 'refresh_token' : 'refreshToken']), expiresAt: this.now() + seconds * 1000 }
  }
  async login(email: string, password: string): Promise<{ tokens: ZeitguruTokens; binding: ZeitguruBinding; snapshot: ZeitguruSnapshot }> {
    if (typeof email !== 'string' || !email.trim() || email.length > 320 || typeof password !== 'string' || !password || password.length > 4096) return fail('invalid_login_input', 400)
    const login = providerObject(await this.post(`${apiOrigin}/api/login`, { data: { email: email.trim(), password, timezone: 'Europe/Berlin', language: 'de' } }))
    if (login.isV2 !== true) return fail('wrong_product', 409)
    const exchanged = providerObject(await this.post(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`, { token: tokenString(login.firebaseToken), returnSecureToken: true }))
    const tokens = this.tokens(exchanged), binding = this.bindingFromToken(tokens.idToken)
    const snapshot = await this.readSnapshot(tokens, binding)
    return { tokens, binding, snapshot }
  }
  async refresh(refreshToken: string, expectedBinding: ZeitguruBinding): Promise<{ tokens: ZeitguruTokens; binding: ZeitguruBinding }> {
    const response = providerObject((await this.request(`https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenString(refreshToken) }).toString(),
    })).value)
    const tokens = this.tokens(response, true), binding = this.bindingFromToken(tokens.idToken)
    sameIdentity(binding, expectedBinding)
    if (response.user_id !== binding.accountId || ![projectId, '502691546834'].includes(String(response.project_id))) return fail('identity_mismatch', 409)
    return { tokens, binding }
  }
  private async read(tokens: ZeitguruTokens, binding: ZeitguruBinding, path: string, query: Record<string, string> = {}) {
    sameIdentity(this.bindingFromToken(tokens.idToken), binding)
    const url = new URL(`${databaseOrigin}/${path}.json`)
    url.searchParams.set('auth', tokens.idToken)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    // Query reads cannot request an ETag. Exact path reads do so for reconciliation only;
    // an ETag on one row does not make the multi-path accounting update conditional.
    return this.request(url, { method: 'GET', headers: Object.keys(query).length ? {} : { 'X-Firebase-ETag': 'true' } })
  }
  async readOwnRow(tokens: ZeitguruTokens, binding: ZeitguruBinding, rowId: string): Promise<ZeitguruRead<ZeitguruClockRow | null>> {
    const id = identifier(rowId), result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/timeClockings/${id}`)
    if (result.value === null) return { ...result, value: null }
    const row = providerObject(result.value)
    if (row.id !== id || row.userId !== binding.userId) return fail('identity_mismatch', 409)
    return { ...result, value: row as ZeitguruClockRow }
  }
  async readOwnCredits(tokens: ZeitguruTokens, binding: ZeitguruBinding, date: string): Promise<ZeitguruRead<ZeitguruObject>> {
    try { zeitguruAddDays(date, 0) } catch { return fail('invalid_read_input', 400) }
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/credits/${identifier(binding.userId)}_${date}`)
    return { ...result, value: result.value === null ? {} : providerObject(result.value) }
  }
  private historyDates(fromDate: string, throughDate: string, bounded = true) {
    try {
      zeitguruAddDays(fromDate, 0); zeitguruAddDays(throughDate, 0)
      if (fromDate > throughDate || (bounded && zeitguruAddDays(fromDate, 30) < throughDate)) return fail('invalid_read_input', 400)
    } catch { return fail('invalid_read_input', 400) }
  }
  private historyRows(value: unknown, binding: ZeitguruBinding, fromDate: string | null, throughDate: string) {
    if (value === null) return []
    return Object.entries(providerObject(value)).map(([key, raw]) => {
      const row = providerObject(raw)
      if (row.id !== key || row.userId !== binding.userId || typeof row.date !== 'string' || row.userId_date !== `${binding.userId}_${row.date}`) return fail('identity_mismatch', 409)
      identifier(row.id)
      try { zeitguruAddDays(row.date, 0) } catch { return fail('invalid_provider_response') }
      if ((fromDate && row.date < fromDate) || row.date > throughDate) return fail('identity_mismatch', 409)
      return row as ZeitguruClockRow
    })
  }
  /** Indexed own-user lookup. No arbitrary lower date or tenant-wide history enumeration. */
  async readOwnHistoryStart(tokens: ZeitguruTokens, binding: ZeitguruBinding, throughDate: string): Promise<string | null> {
    this.historyDates(throughDate, throughDate)
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/timeClockings`, {
      orderBy: JSON.stringify('userId_date'), startAt: JSON.stringify(`${identifier(binding.userId)}_`),
      endAt: JSON.stringify(`${binding.userId}_${throughDate}`), limitToFirst: '1',
    })
    const rows = this.historyRows(result.value, binding, null, throughDate)
    if (rows.length > 1) return fail('invalid_provider_response')
    return rows[0]?.date ?? null
  }
  /** At most 31 calendar days. The extra result detects an over-limit range, never truncates it. */
  async readOwnHistoryRange(tokens: ZeitguruTokens, binding: ZeitguruBinding, fromDate: string, throughDate: string): Promise<ZeitguruClockRow[]> {
    this.historyDates(fromDate, throughDate)
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/timeClockings`, {
      orderBy: JSON.stringify('userId_date'), startAt: JSON.stringify(`${identifier(binding.userId)}_${fromDate}`),
      endAt: JSON.stringify(`${binding.userId}_${throughDate}`), limitToFirst: '10001',
    })
    const rows = this.historyRows(result.value, binding, fromDate, throughDate)
    if (rows.length > 10_000) return fail('history_limit_exceeded', 409)
    return rows
  }
  /** Raw accounting leaves, keyed by date; own-account filtering is validated before returning. */
  async readOwnCreditRange(tokens: ZeitguruTokens, binding: ZeitguruBinding, fromDate: string, throughDate: string): Promise<Record<string, ZeitguruObject>> {
    this.historyDates(fromDate, throughDate)
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/credits`, {
      orderBy: JSON.stringify('$key'), startAt: JSON.stringify(`${identifier(binding.userId)}_${fromDate}`),
      endAt: JSON.stringify(`${binding.userId}_${throughDate}`),
    })
    if (result.value === null) return {}
    const entries = Object.entries(providerObject(result.value)).map(([key, raw]) => {
      const date = key.slice(binding.userId.length + 1)
      if (key !== `${binding.userId}_${date}` || date < fromDate || date > throughDate) return fail('identity_mismatch', 409)
      try { zeitguruAddDays(date, 0) } catch { return fail('invalid_provider_response') }
      return [date, providerObject(raw)] as const
    })
    if (entries.length > 31) return fail('invalid_provider_response')
    return Object.fromEntries(entries)
  }
  private async ownAccountingRecords(tokens: ZeitguruTokens, binding: ZeitguruBinding, table: 'contracts' | 'creditCorrections' | 'absences') {
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/${table}`, {
      orderBy: JSON.stringify('userId'), equalTo: JSON.stringify(identifier(binding.userId)),
    })
    if (result.value === null) return []
    const entries = Object.entries(providerObject(result.value))
    if (entries.length > 10_000) return fail('accounting_limit_exceeded', 409)
    return entries.map(([key, value]) => {
      const row = providerObject(value)
      if (row.id !== key || row.userId !== binding.userId) return fail('identity_mismatch', 409)
      identifier(row.id)
      return row
    })
  }
  async readOwnContracts(tokens: ZeitguruTokens, binding: ZeitguruBinding): Promise<ZeitguruObject[]> {
    return this.ownAccountingRecords(tokens, binding, 'contracts')
  }
  async readOwnCreditCorrections(tokens: ZeitguruTokens, binding: ZeitguruBinding): Promise<ZeitguruObject[]> {
    return this.ownAccountingRecords(tokens, binding, 'creditCorrections')
  }
  async readOwnAbsences(tokens: ZeitguruTokens, binding: ZeitguruBinding): Promise<ZeitguruObject[]> {
    return this.ownAccountingRecords(tokens, binding, 'absences')
  }
  /** Shared configuration, restricted to the absence types referenced by this employee. */
  async readAccountingAbsenceTypes(tokens: ZeitguruTokens, binding: ZeitguruBinding, typeIds: string[]): Promise<ZeitguruObject[]> {
    if (!Array.isArray(typeIds) || typeIds.length > 100) return fail('accounting_limit_exceeded', 409)
    const rows: ZeitguruObject[] = []
    let totalBytes = 0
    for (const id of new Set(typeIds.map(identifier))) {
      const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/absenceTypes/${id}`)
      const row = providerObject(result.value)
      if (row.id !== id) return fail('identity_mismatch', 409)
      totalBytes += Buffer.byteLength(JSON.stringify(row))
      if (totalBytes > 2 * 1024 * 1024) return fail('accounting_limit_exceeded', 409)
      rows.push(row)
    }
    return rows
  }
  /** The official app loads holidays as shared organization configuration. Return only
   * the requested dates and global/own-contract locations; never enumerate other users. */
  async readAccountingHolidays(tokens: ZeitguruTokens, binding: ZeitguruBinding, fromDate: string, throughDate: string, branchIds: string[]): Promise<ZeitguruObject[]> {
    this.historyDates(fromDate, throughDate, false)
    if (!Array.isArray(branchIds) || branchIds.length > 100) return fail('accounting_limit_exceeded', 409)
    const branches = new Set(branchIds.map(identifier))
    const result = await this.read(tokens, binding, `tenants/${identifier(binding.tenantId)}/holidays`)
    if (result.value === null) return []
    const entries = Object.entries(providerObject(result.value))
    if (entries.length > 10_000) return fail('accounting_limit_exceeded', 409)
    return entries.map(([key, raw]) => {
      const row = providerObject(raw)
      if (row.id !== key || typeof row.date !== 'string') return fail('invalid_provider_response')
      identifier(row.id)
      try { zeitguruAddDays(row.date, 0) } catch { return fail('invalid_provider_response') }
      if (row.branchId !== undefined && row.branchId !== null && row.branchId !== '') identifier(row.branchId)
      return row
    }).filter((row) => String(row.date) >= fromDate && String(row.date) <= throughDate && (!row.branchId || branches.has(String(row.branchId))))
  }
  async readServerTime(tokens: ZeitguruTokens, binding: ZeitguruBinding): Promise<number> {
    sameIdentity(this.bindingFromToken(tokens.idToken), binding)
    const response = providerObject(await this.post(`${apiOrigin}/api/current-server-time-v2`, { data: { timezone: 'Europe/Berlin', language: 'de', isV2: true } }, tokens.idToken))
    if (!Number.isSafeInteger(response.unixTime) || typeof response.dateTime !== 'string') return fail('invalid_provider_response')
    const epoch = Number(response.unixTime) * 1000, now = this.now(), wall = zeitguruWallTime(epoch)
    if (response.dateTime !== `${wall.date} ${wall.time}` || Math.abs(epoch - now) > 120_000) return fail('clock_drift', 409)
    const local = zeitguruWallTime(now)
    const localMinutes = Date.parse(`${local.date}T${local.time}:00Z`), remoteMinutes = Date.parse(`${wall.date}T${wall.time}:00Z`)
    if (Math.abs(localMinutes - remoteMinutes) > 120_000) return fail('clock_drift', 409)
    return epoch
  }
  async readSnapshot(tokens: ZeitguruTokens, expectedBinding: ZeitguruBinding): Promise<ZeitguruSnapshot> {
    const binding = this.bindingFromToken(tokens.idToken); sameIdentity(binding, expectedBinding)
    const prefix = `tenants/${binding.tenantId}`, today = zeitguruWallTime(this.now()).date, fromDate = zeitguruAddDays(today, -1)
    const paths = { tenant: `tenantInfos/${binding.tenantId}`, profile: `${prefix}/users/${binding.userId}`, clock: `${prefix}/timeClockSettings`, roster: `${prefix}/rosterSettings` }
    const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await this.read(tokens, binding, path)] as const))
    const values = Object.fromEntries(entries), tenant = providerObject(values.tenant.value), profile = providerObject(values.profile.value)
    if (tenant.id !== binding.tenantId || tenant.isV2 !== true || profile.id !== binding.userId || profile.accountId !== binding.accountId || profile.role !== binding.role) return fail('identity_mismatch', 409)
    if (profile.isDeleted || profile.isInactive || (typeof profile.lastWorkDay === 'string' && profile.lastWorkDay < today) || tenant.state === 'deactivated') return fail('permission_denied', 403)
    for (const field of ['name', 'email']) if (Object.hasOwn(profile, field)) profile[field] = identityText(profile[field])
    if (!Array.isArray(profile.branchIds) || profile.branchIds.length > 100) return fail('invalid_provider_response')
    const clocks = collection(values.clock.value), rosters = collection(values.roster.value)
    if (clocks.length !== 1 || rosters.length !== 1) return fail('unsupported_settings', 409)
    const branches = await Promise.all(profile.branchIds.map(async (id) => {
      const safeId = identifier(id), result = providerObject((await this.read(tokens, binding, `${prefix}/branches/${safeId}`)).value)
      if (result.id !== safeId) return fail('identity_mismatch', 409)
      return result
    }))
    const ownRows = await this.read(tokens, binding, `${prefix}/timeClockings`, {
      orderBy: JSON.stringify('userId_date'), startAt: JSON.stringify(`${binding.userId}_${fromDate}`), endAt: JSON.stringify(`${binding.userId}_${today}`),
    })
    const clockings = collection(ownRows.value).map((row) => {
      if (row.userId !== binding.userId || typeof row.date !== 'string' || row.date < fromDate || row.date > today || row.userId_date !== `${binding.userId}_${row.date}`) return fail('identity_mismatch', 409)
      identifier(row.id); identifier(row.branchId)
      return row as ZeitguruClockRow
    })
    const creditEntries = await Promise.all([fromDate, today].map(async (date) => [date, await this.readOwnCredits(tokens, binding, date)] as const))
    const etags = Object.fromEntries(entries.filter(([, result]) => result.etag).map(([name, result]) => [paths[name as keyof typeof paths], result.etag!]))
    for (const [date, result] of creditEntries) if (result.etag) etags[`${prefix}/credits/${binding.userId}_${date}`] = result.etag
    return { binding, tenant, profile, clockSettings: clocks[0], rosterSettings: rosters[0], branches, clockings, credits: Object.fromEntries(creditEntries.map(([date, result]) => [date, result.value])), observedAt: new Date(this.now()).toISOString(), fromDate, toDate: today, etags }
  }
}
