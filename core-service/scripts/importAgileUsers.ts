import { importAgileUsers } from '../server/core.ts'

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('Usage: npm run userbase:import-agile -- /path/to/agile-project.sqlite')
  process.exit(2)
}

const result = importAgileUsers(sourcePath)
console.log(`Imported Agile-only accounts: ${result.inserted} inserted, ${result.existing} already represented, ${result.skipped} skipped.`)
console.log(`Verification checksum: ${result.checksum}`)
