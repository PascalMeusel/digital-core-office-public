import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const path = resolve(process.argv[2] ?? '.env')
const values = new Map(Object.entries(parseEnv(readFileSync(path, 'utf8'))))
for (const key of values.keys()) {
  if (process.env[key] !== undefined) values.set(key, process.env[key])
}

const allowed = ['time', 'inventory', 'agile']
const modules = [...new Set((values.get('DCO_ENABLED_MODULES') ?? '').split(',').map((value) => value.trim()).filter(Boolean))]
const profiles = [...new Set((values.get('COMPOSE_PROFILES') ?? '').split(',').map((value) => value.trim()).filter(Boolean))]
const errors = []

if (modules.length === 0) errors.push('DCO_ENABLED_MODULES must contain at least one module.')
for (const module of modules) if (!allowed.includes(module)) errors.push(`Unsupported module: ${module}.`)
if (JSON.stringify(modules) !== JSON.stringify(profiles)) errors.push('COMPOSE_PROFILES must exactly match DCO_ENABLED_MODULES, including canonical order.')
if (modules.join(',') !== allowed.filter((module) => modules.includes(module)).join(',')) errors.push('Use canonical module order: time,inventory,agile.')

for (const secret of ['DCO_INTERNAL_AUTH_SECRET', 'DIGITAL_OFFICE_SSO_SECRET']) {
  if ((values.get(secret) ?? '').length < 24) errors.push(`${secret} must be an independently generated secret of at least 24 characters.`)
}
if (values.get('DCO_INTERNAL_AUTH_SECRET') && values.get('DCO_INTERNAL_AUTH_SECRET') === values.get('DIGITAL_OFFICE_SSO_SECRET')) errors.push('Internal and legacy SSO secrets must be different.')
if (modules.includes('time') && (values.get('TIME_DATA_ENCRYPTION_KEY') ?? '').length < 24) {
  errors.push('TIME_DATA_ENCRYPTION_KEY must contain at least 24 characters when Time is enabled.')
}
const publicUrl = values.get('DCO_PUBLIC_BASE_URL') ?? ''
if (!/^https:\/\//i.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(publicUrl)) {
  errors.push('DCO_PUBLIC_BASE_URL must use HTTPS except for localhost testing.')
}
if (!(values.get('DCO_APP_HOST') ?? '').trim()) errors.push('DCO_APP_HOST is required.')
try {
  const parsed = new URL(publicUrl)
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') errors.push('DCO_PUBLIC_BASE_URL must be a clean origin without a path, credentials, query or fragment.')
  if (values.get('DCO_APP_HOST') !== parsed.host) errors.push('DCO_APP_HOST must match the public URL host, including its port when present.')
} catch { errors.push('DCO_PUBLIC_BASE_URL is not a valid URL.') }
try { new Intl.DateTimeFormat('en', { timeZone: values.get('DCO_TIMEZONE') || 'Europe/Berlin' }).format() } catch { errors.push('DCO_TIMEZONE must be a valid IANA timezone.') }
const adminEmail = values.get('DCO_INITIAL_ADMIN_EMAIL') || ''
const adminPassword = values.get('DCO_INITIAL_ADMIN_PASSWORD') || ''
if (Boolean(adminEmail) !== Boolean(adminPassword)) errors.push('Set both initial Core administrator email and password, or leave both blank for an existing/imported userbase.')
if (adminPassword && adminPassword.length < 14) errors.push('The initial Core administrator password must contain at least 14 characters.')
for (const key of ['DCO_OPERATOR_NAME', 'DCO_OPERATOR_ADDRESS', 'DCO_SUPPORT_EMAIL', 'DCO_PRIVACY_EMAIL', 'DCO_PRIVACY_DETAILS']) {
  if (!(values.get(key) || '').trim()) errors.push(`${key} is required for the installation-specific public contact/privacy pages.`)
}
for (const key of ['DCO_SUPPORT_EMAIL', 'DCO_PRIVACY_EMAIL']) if (values.get(key) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.get(key))) errors.push(`${key} must be an email address.`)

if (errors.length > 0) {
  console.error(`Digital Core Office configuration is invalid:\n- ${errors.join('\n- ')}`)
  process.exit(1)
}

console.log(`Configuration valid: one suite with ${modules.length} module(s): ${modules.join(', ')}.`)
