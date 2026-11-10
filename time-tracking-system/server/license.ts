import { createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './store.ts'
import type { LicenseDetails, LicensePlan, LicenseState } from '../shared/domain.ts'

export const freeUserLimit = 10
const moduleDir = dirname(fileURLToPath(import.meta.url))

interface LicensePayload {
  version: 1
  licenseId: string
  holderName: string
  contactEmail: string
  plan: LicensePlan
  activeUserLimit: number
  issuedAt: string
  validUntil?: string
  notes?: string
}

interface LicenseEnvelope {
  payload: LicensePayload
  signature: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

function licensePublicKey() {
  const configuredKey = process.env.LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n').trim()
  if (configuredKey) {
    return configuredKey
  }

  const configuredPath = process.env.LICENSE_PUBLIC_KEY_FILE
  const fallbackPath = join(moduleDir, '..', 'licenses', 'license-public.pem')
  const keyPath = configuredPath && configuredPath.length > 0 ? configuredPath : fallbackPath
  return existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : undefined
}

function decodeLicenseKey(licenseKey: string): LicenseEnvelope {
  const normalized = licenseKey.trim().replace(/^NRWTT-/i, '').replace(/\s+/g, '')
  return JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8')) as LicenseEnvelope
}

function validatePayload(payload: LicensePayload) {
  if (payload.version !== 1) {
    return 'Unsupported license version.'
  }
  if (!payload.licenseId || !payload.holderName || !payload.contactEmail) {
    return 'License holder details are incomplete.'
  }
  if (payload.plan !== 'paid' && payload.plan !== 'free_grant') {
    return 'License plan is unsupported.'
  }
  if (!Number.isInteger(payload.activeUserLimit) || payload.activeUserLimit < 1) {
    return 'License active-user limit is invalid.'
  }
  if (Number.isNaN(new Date(payload.issuedAt).getTime())) {
    return 'License issue date is invalid.'
  }
  if (payload.validUntil && Number.isNaN(new Date(payload.validUntil).getTime())) {
    return 'License expiry date is invalid.'
  }
  return ''
}

export function verifyLicenseKey(licenseKey: string): { details?: LicenseDetails; error?: string } {
  const publicKey = licensePublicKey()
  if (!publicKey) {
    return { error: 'No license public key is configured on the server.' }
  }

  try {
    const envelope = decodeLicenseKey(licenseKey)
    const validationError = validatePayload(envelope.payload)
    if (validationError) {
      return { error: validationError }
    }

    const isValid = verify(
      null,
      Buffer.from(canonicalJson(envelope.payload), 'utf8'),
      createPublicKey(publicKey),
      Buffer.from(envelope.signature, 'base64url'),
    )
    if (!isValid) {
      return { error: 'License signature is invalid.' }
    }

    return { details: envelope.payload }
  } catch {
    return { error: 'License key could not be parsed.' }
  }
}

export function licenseStateForDatabase(database: Database, additionalActiveUsers = 0): LicenseState {
  const activeUsers = database.users.filter((user) => user.active).length + additionalActiveUsers
  const configuredKey = database.licenseSettings?.licenseKey

  if (!configuredKey) {
    const canAddUsers = activeUsers < freeUserLimit
    return {
      status: activeUsers <= freeUserLimit ? 'community' : 'over_limit',
      valid: activeUsers <= freeUserLimit,
      canAddUsers,
      licenseConfigured: false,
      activeUsers,
      freeUserLimit,
      effectiveUserLimit: freeUserLimit,
      message:
        activeUsers <= freeUserLimit
          ? `Community use is free up to ${freeUserLimit} active users.`
          : `A paid or free-grant license is required above ${freeUserLimit} active users.`,
    }
  }

  const result = verifyLicenseKey(configuredKey)
  if (!result.details) {
    const canAddUsers = activeUsers < freeUserLimit
    const isWithinFreeLimit = activeUsers <= freeUserLimit
    return {
      status: result.error?.includes('public key') ? 'missing_public_key' : 'invalid',
      valid: isWithinFreeLimit,
      canAddUsers,
      licenseConfigured: true,
      activeUsers,
      freeUserLimit,
      effectiveUserLimit: freeUserLimit,
      message: result.error ?? 'The configured license is invalid.',
    }
  }

  const expiresAt = result.details.validUntil ? new Date(result.details.validUntil).getTime() : undefined
  const isExpired = expiresAt !== undefined && expiresAt < Date.now()
  const isWithinLimit = activeUsers <= result.details.activeUserLimit
  const details = {
    ...result.details,
    updatedAt: database.licenseSettings?.updatedAt,
    updatedBy: database.licenseSettings?.updatedBy,
  }

  if (isExpired) {
    const isWithinFreeLimit = activeUsers <= freeUserLimit
    return {
      status: 'expired',
      valid: isWithinFreeLimit,
      canAddUsers: activeUsers < freeUserLimit,
      licenseConfigured: true,
      activeUsers,
      freeUserLimit,
      effectiveUserLimit: freeUserLimit,
      message: 'The configured license has expired.',
      details,
    }
  }

  return {
    status: isWithinLimit ? 'licensed' : 'over_limit',
    valid: isWithinLimit,
    canAddUsers: activeUsers < result.details.activeUserLimit,
    licenseConfigured: true,
    activeUsers,
    freeUserLimit,
    effectiveUserLimit: result.details.activeUserLimit,
    message: isWithinLimit
      ? 'A valid license is configured.'
      : `This license allows ${result.details.activeUserLimit} active users. Add or renew a license for more users.`,
    details,
  }
}
