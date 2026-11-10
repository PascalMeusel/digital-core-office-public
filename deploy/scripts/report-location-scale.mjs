import { DatabaseSync } from 'node:sqlite'

const dataFileArgument = process.argv.find((argument) => argument.startsWith('--data-file='))
const dataFile = dataFileArgument?.slice('--data-file='.length) || '/var/lib/digital-core-office/inventory/inventory-system.sqlite'
const database = new DatabaseSync(dataFile, { readOnly: true })

try {
  const totals = database.prepare(`
    SELECT kind, COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active
    FROM inventory_locations
    GROUP BY kind
    ORDER BY kind
  `).all()
  const hierarchy = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN parentId IS NULL OR parentId = '' THEN 1 ELSE 0 END) AS roots,
      COUNT(DISTINCT NULLIF(roomCode, '')) AS roomCodes
    FROM inventory_locations
  `).get()
  const rooms = database.prepare(`
    SELECT
      COALESCE(NULLIF(roomCode, ''), '(unassigned)') AS roomCode,
      MAX(NULLIF(roomName, '')) AS roomName,
      COUNT(*) AS locations,
      SUM(CASE WHEN kind = 'fixture' THEN 1 ELSE 0 END) AS fixtures,
      SUM(CASE WHEN kind = 'container' THEN 1 ELSE 0 END) AS containers
    FROM inventory_locations
    GROUP BY COALESCE(NULLIF(roomCode, ''), '(unassigned)')
    ORDER BY locations DESC, roomCode
    LIMIT 20
  `).all()
  const occupied = database.prepare(`
    SELECT COUNT(DISTINCT locationId) AS occupiedLocations, COUNT(*) AS stockPositions
    FROM inventory_records
    WHERE state IN ('delivered', 'in_stock', 'reserved', 'in_use', 'maintenance', 'damaged')
  `).get()
  console.log(JSON.stringify({ totals, hierarchy, occupied, largestRooms: rooms }, null, 2))
} finally {
  database.close()
}
