import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const kind = process.argv[2]
const databasePath = process.argv[3]
const confirmed = process.argv.includes('--confirm-after-verified-core-import')

if (!['time', 'inventory', 'agile'].includes(kind ?? '') || !databasePath || !confirmed) {
  console.error('Usage: npm run userbase:disable-module-passwords -- <time|inventory|agile> database.sqlite --confirm-after-verified-core-import')
  console.error('Run only after backup, Core import checksum verification, and representative login tests.')
  process.exit(2)
}

const sql = new DatabaseSync(resolve(databasePath))
const salt = randomBytes(24).toString('base64url')
const unusableHash = randomBytes(32).toString('hex')
let changed = 0

if (kind === 'time') {
  changed = Number(sql.prepare(`UPDATE users SET passwordSalt = ?, passwordHash = ?`).run(salt, unusableHash).changes)
} else if (kind === 'inventory') {
  changed = Number(sql.prepare(`UPDATE inventory_user_credentials SET passwordSalt = ?, passwordHash = ?, passwordAlgorithm = 'core-managed-disabled'`).run(salt, unusableHash).changes)
} else {
  changed = Number(sql.prepare(`UPDATE agile_users SET passwordSalt = ?, passwordHash = ?, passwordAlgorithm = 'core-managed-disabled'`).run(salt, unusableHash).changes)
}

sql.close()
console.log(`Disabled ${changed} local ${kind} password credential(s). Core SSO must remain enabled.`)
