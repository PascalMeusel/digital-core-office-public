import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ReferenceLocation {
  id: string
  code: string
  fixtureCode?: string
  rowCode?: string
}

interface ReferenceRow {
  record: {
    locationId: string
    label?: string
  }
}

interface ReferenceInventory {
  locations: ReferenceLocation[]
  rows: ReferenceRow[]
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const sourcePath = resolve(process.argv[2] ?? process.env.INVENTORY_REFERENCE_DATA_FILE ?? join(moduleDir, '..', 'server', 'reference', 'inventorySource.json'))
const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as ReferenceInventory
const locationsById = new Map(source.locations.map((location) => [location.id, location]))
let normalized = 0

for (const row of source.rows) {
  const location = locationsById.get(row.record.locationId)
  const label = row.record.label?.trim().toLowerCase()
  const locationLabels = [location?.fixtureCode, location?.rowCode ? `${location?.fixtureCode}-${location.rowCode}` : undefined]
    .filter(Boolean)
    .map((value) => value!.toLowerCase())

  if (label && locationLabels.includes(label)) {
    delete row.record.label
    normalized += 1
  }
}

writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8')
console.log(`Removed ${normalized} location codes from imported record labels.`)
