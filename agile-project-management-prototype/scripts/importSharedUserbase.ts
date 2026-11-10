import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { importSharedUserbase, type SharedUserbaseUser } from '../server/userbase.ts'

interface SharedUserbasePayload {
  users?: SharedUserbaseUser[]
}

const inputPath = resolve(process.cwd(), process.argv[2] ?? process.env.SHARED_USERBASE_FILE ?? '../shared-userbase.json')
const payload = JSON.parse(readFileSync(inputPath, 'utf8')) as SharedUserbasePayload | SharedUserbaseUser[]
const users = Array.isArray(payload) ? payload : payload.users ?? []
const result = importSharedUserbase(users)

console.log(
  `Imported shared userbase into Agile Project Management from ${inputPath}: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped.`,
)
