import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { InventoryStatePayload } from '../shared/inventory.ts'

const directory = mkdtempSync(join(tmpdir(), 'dco-reference-rooms-'))
const dbPath = join(directory, 'inventory.sqlite')
const rooms = [
  { code: '001', name: 'Soldering Room', planImagePath: '/inventory-media/plans/room-001.png' },
  { code: '002', name: 'Production Room', planImagePath: '/inventory-media/plans/room-002.png' },
  { code: '004', name: 'Inventory Room', planImagePath: '/inventory-media/plans/room-004.png' },
]
writeFileSync(join(directory, 'reference.json'), JSON.stringify({ rooms, locations: [], rows: [] }))
Object.assign(process.env, {
  INVENTORY_SYSTEM_DATA: dbPath, INVENTORY_MEDIA_DIR: join(directory, 'media'),
  INVENTORY_REFERENCE_DATA_FILE: join(directory, 'reference.json'),
  INVENTORY_SYSTEM_ADMIN_EMAIL: 'rooms@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: 'L7!nRf4*Kw9#pUv8',
  DISABLE_LOCAL_WEB_LOGIN: 'false',
})
delete process.env.DCO_CORE_URL
const { inventorySystemRouter, closeInventorySystemDatabase, inventorySystemHealth } = await import('../server/inventorySystem.ts')
const app = express(); app.use(express.json()); app.use('/api', inventorySystemRouter)
const server = createServer(app)
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const address = server.address(); assert(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}/api`
let headers: Record<string, string> = { 'Content-Type': 'application/json' }
async function call(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json() as InventoryStatePayload & { message?: string }
  assert(response.ok, `${path}: ${response.status} ${data.message}`)
  return { data, response }
}
function withDatabase<T>(callback: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(dbPath)
  try { return callback(db) } finally { db.close() }
}
function snapshot() {
  return withDatabase(db => Object.fromEntries(['inventory_locations', 'inventory_items', 'inventory_records'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])))
}
after(async () => {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  closeInventorySystemDatabase()
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  rmSync(directory, { recursive: true, force: true })
})

test('reference room plans become real, usable places without changing existing inventory', async t => {
  const login = await call('/auth/login', { email: process.env.INVENTORY_SYSTEM_ADMIN_EMAIL, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD })
  headers = { ...headers, cookie: login.response.headers.getSetCookie().find(value => value.startsWith('inventory_session='))!.split(';')[0], 'x-inventory-csrf': login.data.csrfToken }
  await t.test('all three rooms exist even with no stock or imported locations', () => {
    assert.equal(login.data.locations.length, 3)
    assert.equal(login.data.records.length, 0)
    for (const room of rooms) {
      const place = login.data.locations.find(place => place.roomCode === room.code)!
      assert.equal(place.name, room.name); assert.equal(place.kind, 'room')
      assert.equal(place.planImagePath, room.planImagePath); assert.equal(place.active, true)
      assert.equal(place.parentId, undefined)
    }
  })
  const soldering = login.data.locations.find(place => place.roomCode === '001')!
  const shelf = (await call('/locations', { name: 'Soldering table', code: '001-ST101', kind: 'fixture', parentId: soldering.id })).data.locations.find(place => place.code === '001-ST101')!
  const item = (await call('/items', { name: 'Existing PCB', sku: 'DEMO-EXISTING', unit: 'pcs' })).data.items[0]
  await call('/records', { itemId: item.id, locationId: shelf.id, quantity: 12, state: 'in_stock', condition: 'new' })

  await t.test('repair adds only missing rooms and preserves legacy hierarchy, IDs and stock', () => {
    closeInventorySystemDatabase()
    withDatabase(db => {
      db.prepare("DELETE FROM inventory_locations WHERE roomCode IN ('002', '004')").run()
      db.prepare('UPDATE inventory_locations SET code = NULL WHERE id = ?').run(soldering.id)
    })
    const before = snapshot()
    inventorySystemHealth()
    const after = snapshot()
    assert.equal(after.inventory_locations.length, before.inventory_locations.length + 2)
    const existingIds = new Set(before.inventory_locations.map(row => row.id))
    assert.deepEqual(after.inventory_locations.filter(row => existingIds.has(row.id)), before.inventory_locations)
    assert.deepEqual(after.inventory_items, before.inventory_items)
    assert.deepEqual(after.inventory_records, before.inventory_records)
  })
  await t.test('restarts do not duplicate rooms or alter their timestamps', () => {
    const before = snapshot()
    for (let i = 0; i < 2; i++) { closeInventorySystemDatabase(); inventorySystemHealth(); assert.deepEqual(snapshot(), before) }
  })
  await t.test('existing renamed or inactive rooms are reused by code with their own ID', () => {
    closeInventorySystemDatabase()
    withDatabase(db => db.prepare("UPDATE inventory_locations SET id = 'custom-room-id', name = 'Renamed storage', roomCode = NULL, active = 0, planImagePath = '/custom-plan.png' WHERE code = '004'").run())
    const before = snapshot()
    inventorySystemHealth()
    assert.deepEqual(snapshot(), before)
  })
  await t.test('a code already used by a fixture is kept and does not prevent the room from appearing', () => {
    closeInventorySystemDatabase()
    withDatabase(db => {
      db.prepare("DELETE FROM inventory_locations WHERE roomCode = '002'").run()
      db.prepare("UPDATE inventory_locations SET code = '002' WHERE id = ?").run(shelf.id)
    })
    const before = snapshot()
    inventorySystemHealth()
    const after = snapshot()
    assert.deepEqual(after.inventory_records, before.inventory_records)
    assert.deepEqual(after.inventory_locations.find(row => row.id === shelf.id), before.inventory_locations.find(row => row.id === shelf.id))
    const production = after.inventory_locations.find(row => row.kind === 'room' && row.roomCode === '002')!
    assert(production); assert.equal(production.code, null); assert.equal(production.planImagePath, rooms[1].planImagePath)
    closeInventorySystemDatabase(); inventorySystemHealth(); assert.deepEqual(snapshot(), after)
  })
  await t.test('new rooms accept shelves and received stock through the regular API', async () => {
    const state = (await call('/state')).data
    const production = state.locations.find(place => place.kind === 'room' && place.roomCode === '002')!
    const place = (await call('/locations', { name: 'Incoming parts', code: '002-INCOMING', kind: 'fixture', parentId: production.id })).data.locations.find(place => place.code === '002-INCOMING')!
    assert.equal(place.roomCode, '002')
    const received = (await call('/records', { itemId: item.id, locationId: place.id, quantity: 2, state: 'in_stock', condition: 'new' })).data.records.find(record => record.locationId === place.id)!
    assert.equal(received.quantity, 2)
    withDatabase(db => { assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []) })
  })
})
