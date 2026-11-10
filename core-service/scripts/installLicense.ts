import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { closeConnection, setLicenseKey } from '../server/core.ts'

const licensePath = process.argv[2]
if (!licensePath) {
  console.error('Usage: npm run license:install -- /path/to/private.license')
  process.exit(2)
}

try {
  const state = setLicenseKey(readFileSync(resolve(licensePath), 'utf8'), 'operator-cli')
  console.log(`Installed license with status ${state.status}; ${state.activeUsers} active user(s), limit ${state.effectiveUserLimit}.`)
} finally {
  closeConnection()
}
