import { importInventoryUsers } from '../server/core.ts'

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('Usage: npm run userbase:import-inventory -- /path/to/inventory-system.sqlite')
  process.exit(2)
}

const result = importInventoryUsers(sourcePath)
console.log(`Imported Inventory-only accounts: ${result.inserted} inserted, ${result.existing} already represented, ${result.skipped} skipped.`)
console.log(`Verification checksum: ${result.checksum}`)
