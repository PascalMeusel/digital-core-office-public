import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ReferenceLocation {
  id: string
  name: string
  code: string
  kind?: 'room' | 'fixture' | 'container'
  parentId?: string
  area?: string
  rack?: string
  roomCode?: string
  roomName?: string
  fixtureCode?: string
  fixtureType?: string
  planImagePath?: string
  active: boolean
  createdAt: string
  updatedAt: string
}

interface ReferenceRow {
  sourceRow: number
  item: {
    id: string
    name: string
    [key: string]: unknown
  }
  record: {
    id: string
    itemId: string
    locationId: string
    quantity: number
    quantityLabel?: string
    photoPath?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface ReferenceInventory {
  version: number
  locations: ReferenceLocation[]
  rows: ReferenceRow[]
  removedInventoryRows?: Array<{ itemId: string; recordId: string; reason: string }>
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const sourcePath = resolve(process.argv[2] ?? process.env.INVENTORY_REFERENCE_DATA_FILE ?? join(moduleDir, '..', 'server', 'reference', 'inventorySource.json'))
const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as ReferenceInventory
const locationsById = new Map(source.locations.map((location) => [location.id, location]))
const removedInventoryRows = source.removedInventoryRows ?? []
let createdLocations = 0
let movedRecords = 0
let removedEmptyRows = 0

for (const location of source.locations) {
  if (!location.id.startsWith('reference-location-container-row-')) continue
  const parent = source.locations.find((candidate) =>
    !candidate.id.startsWith('reference-location-container-row-')
    && candidate.fixtureCode === location.fixtureCode,
  )
  if (!parent) throw new Error(`Missing fixture parent for ${location.id}.`)
  location.kind = 'container'
  location.parentId = parent.id
}

function isContainerDescription(name: string) {
  return /\bbin label(?:ed)?\b/i.test(name)
}

function quotedContainerLabel(name: string) {
  return name.match(/\bbin label(?:ed)?[^"“”]*["“]([^"”]+)["”]/i)?.[1]?.trim()
}

function cleanedItemName(name: string) {
  const leadingLabel = name.match(/^bin labeled\s*["“]([^"”]+)["”]/i)?.[1]?.trim()
  if (leadingLabel) return leadingLabel
  return name
    .replace(/,?\s*bin labeled\s*["“][^"”]+["”].*$/i, '')
    .replace(/\s*\(bin label[^)]*\)\s*$/i, '')
    .replace(/\s+bin label(?:\s*["“][^"”]+["”])?\s*$/i, '')
    .replace(/\s+bin label.*$/i, '')
    .trim()
}

function normalizedLabel(value: string) {
  return value.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
}

const nextRows: ReferenceRow[] = []
for (const row of source.rows) {
  if (!isContainerDescription(row.item.name)) {
    nextRows.push(row)
    continue
  }

  const parent = locationsById.get(row.record.locationId)
  if (!parent) {
    throw new Error(`Missing parent location ${row.record.locationId} for source row ${row.sourceRow}.`)
  }

  const itemName = cleanedItemName(row.item.name)
  const label = normalizedLabel(quotedContainerLabel(row.item.name) || itemName || `Fach ${row.sourceRow}`)
  const locationId = `reference-location-container-row-${String(row.sourceRow).padStart(3, '0')}`
  const photoPath = row.record.photoPath
  const location: ReferenceLocation & Record<string, unknown> = {
    id: locationId,
    name: `Fach ${label}`,
    code: '',
    kind: 'container',
    parentId: parent.id,
    area: parent.area,
    rack: parent.name,
    bin: label,
    description: `Physisches Fach aus der Bestandsaufnahme, Quelle Components!A${row.sourceRow}:I${row.sourceRow}. Beschriftung: ${label}.`,
    roomCode: parent.roomCode,
    roomName: parent.roomName,
    fixtureCode: parent.fixtureCode || parent.code,
    fixtureType: parent.fixtureType || parent.name,
    rowCode: label,
    planImagePath: parent.planImagePath,
    photoPath,
    active: true,
    createdAt: row.item.createdAt as string,
    updatedAt: row.item.updatedAt as string,
  }
  const existingLocation = locationsById.get(locationId)
  if (!existingLocation) {
    source.locations.push(location)
    locationsById.set(locationId, location)
    createdLocations += 1
  } else {
    Object.assign(existingLocation, location)
  }

  const explicitlyEmpty = /appears empty|\bempty\b/i.test(row.item.name) && row.record.quantity === 0
  if (explicitlyEmpty) {
    removedInventoryRows.push({
      itemId: row.item.id,
      recordId: row.record.id,
      reason: `Leeres Fach ohne Artikelbestand; migriert zu ${locationId}.`,
    })
    removedEmptyRows += 1
    continue
  }

  row.item.name = itemName
  row.record.locationId = locationId
  delete row.record.photoPath
  nextRows.push(row)
  movedRecords += 1
}

source.version = Math.max(source.version, 2)
source.rows = nextRows
source.removedInventoryRows = Array.from(new Map(removedInventoryRows.map((row) => [row.recordId, row])).values())
writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8')
console.log(`Created ${createdLocations} container locations, moved ${movedRecords} records, removed ${removedEmptyRows} empty inventory rows.`)
