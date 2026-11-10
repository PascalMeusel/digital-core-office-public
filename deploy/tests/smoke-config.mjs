import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export const combinations = ['time', 'inventory', 'agile', 'time,inventory', 'time,agile', 'inventory,agile', 'time,inventory,agile']

export function smokeEnvironment(modules, port = 48080) {
  return {
    DCO_APP_HOST: `127.0.0.1:${port}`, DCO_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, DCO_TIMEZONE: 'Europe/Berlin',
    DCO_ENABLED_MODULES: modules, COMPOSE_PROFILES: modules, DCO_INTERNAL_AUTH_SECRET: randomBytes(32).toString('hex'), DIGITAL_OFFICE_SSO_SECRET: randomBytes(32).toString('hex'),
    TIME_DATA_ENCRYPTION_KEY: modules.split(',').includes('time') ? randomBytes(32).toString('hex') : '', TIME_REQUIRE_DATA_ENCRYPTION: 'true',
    DCO_INITIAL_ADMIN_NAME: 'Smoke Administrator', DCO_INITIAL_ADMIN_EMAIL: 'launch-admin@example.invalid', DCO_INITIAL_ADMIN_PASSWORD: 'Initial!SmokePassword2026',
    DCO_OPERATOR_NAME: 'Synthetic CI Operator', DCO_OPERATOR_ADDRESS: 'Test Street 1, Test City', DCO_SUPPORT_EMAIL: 'support@example.invalid', DCO_PRIVACY_EMAIL: 'privacy@example.invalid', DCO_PRIVACY_DETAILS: 'Synthetic local test data only; volumes are destroyed after this isolated test.',
    DCO_DISABLE_LOCAL_WEB_LOGIN: 'true', DIGITAL_OFFICE_COOKIE_DOMAIN: '', INVENTORY_REFERENCE_DATA_FILE: '',
  }
}

export function writeEnvironment(path, values) {
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n')
}

