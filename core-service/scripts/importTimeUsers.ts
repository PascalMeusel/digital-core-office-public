import { importTimeUsers } from '../server/core.ts'

const sourcePath = process.argv[2] ?? process.env.DCO_TIME_DATABASE_SOURCE
if (!sourcePath) {
  console.error('Usage: npm run userbase:import-time -- /path/to/shared-userbase.json')
  process.exit(2)
}

const result = importTimeUsers(sourcePath)
console.log(`Imported ${result.count} Time Tracking account(s): ${result.inserted} inserted, ${result.updated} updated.`)
console.log(`Verification checksum: ${result.checksum}`)
