import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readDatabase } from '../server/store.ts'

const outputPath = resolve(process.cwd(), process.argv[2] ?? process.env.SHARED_USERBASE_FILE ?? '../shared-userbase.json')
const database = readDatabase()
const payload = {
  version: 1,
  source: 'time-tracking-system',
  exportedAt: new Date().toISOString(),
  passwordAlgorithm: 'time-pbkdf2-sha256',
  users: database.users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    passwordSalt: user.passwordSalt,
    passwordHash: user.passwordHash,
    passwordAlgorithm: 'time-pbkdf2-sha256',
  })),
}

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`Exported ${payload.users.length} shared userbase account(s) to ${outputPath}. Treat this file as secret.`)
