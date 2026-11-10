import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'node:http'
import express from 'express'
import type { InventoryStatePayload } from '../shared/inventory.ts'
import { projectPartIds } from '../shared/workflows.ts'

const directory = mkdtempSync(join(tmpdir(), 'dco-catalog-'))
Object.assign(process.env, { INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_MEDIA_DIR: join(directory, 'media'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'absent.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'admin@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: 'L7!nRf4*Kw9#pUv8', DISABLE_LOCAL_WEB_LOGIN: 'false' })
delete process.env.DCO_CORE_URL
const { inventorySystemRouter, closeInventorySystemDatabase } = await import('../server/inventorySystem.ts')
const app = express(); app.use(express.json()); app.use('/api', inventorySystemRouter)
const server = createServer(app)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address(); assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}/api`
type Session = { cookie: string; csrf: string; id: string }
async function call(path: string, body?: unknown, session?: Session, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(session ? { cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() as InventoryStatePayload & { message?: string }, headers: response.headers }
}
async function login(email: string) {
  const r = await call('/auth/login', { email, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD }); assert.equal(r.status, 200, r.data.message)
  return { cookie: r.headers.getSetCookie().find(c => c.startsWith('inventory_session='))!.split(';')[0], csrf: r.data.csrfToken, id: r.data.currentUser.id }
}
const admin = await login('admin@example.test')
async function ok(path: string, body?: unknown, session = admin, method?: string) { const r = await call(path, body, session, method); assert.ok(r.status >= 200 && r.status < 300, `${path}: ${r.status} ${r.data.message}`); return r.data }
const sessions: Record<string, Session> = { admin }
for (const role of ['hardware_developer', 'software_developer', 'buyer', 'receiver', 'buyer_receiver', 'viewer']) {
  await ok('/users', { name: role, email: `${role}@example.test`, role, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD, mustChangePassword: false })
  sessions[role] = await login(`${role}@example.test`)
}
const sw = sessions.software_developer, buyer = sessions.buyer, receiver = sessions.receiver
const state = () => ok('/state')
const room = (await ok('/locations', { name: 'Workshop', code: 'WORK', kind: 'room' })).locations.find(l => l.code === 'WORK')!
const item = (await ok('/items', { name: 'Controller board', sku: 'CTRL', unit: 'pcs' })).items.find(i => i.sku === 'CTRL')!
async function approve(id: string, session = buyer) {
  const r = (await state()).workflows!.requests.find(r => r.id === id)!
  return (await ok(`/workflows/requests/${id}/review`, { expectedVersion: r.version, decision: 'approve' }, session)).workflows!.requests.find(r => r.id === id)!
}
async function order(requestId: string, session = buyer, shipping = 1) {
  const r = await approve(requestId, session)
  const s = await ok('/workflows/orders', { supplier: 'Parts supplier', reference: crypto.randomUUID(), shipping, lines: [{ requestId, expectedVersion: r.version, unitCost: r.estimatedUnitCost ?? 0 }] }, session)
  return s.workflows!.orders[0]
}
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeInventorySystemDatabase(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) })

test('article units, EUR prices and links are validated; photo save is atomic and survives restart', async () => {
  const photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkqMhjIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEA8lQBBv9ZpNAAAAAASUVORK5CYII='
  for (const body of [{ unit: '()' }, { estimatedUnitCost: '$12' }, { estimatedUnitCost: '1.234,50' }, { supplierUrl: 'javascript:alert(1)' }, { photoData: 'data:image/svg+xml;base64,PHN2Zy8+' }, { projectIds: ['missing'] }]) {
    const before = (await state()).items.length
    assert.equal((await call('/items', { name: 'Invalid', ...body }, admin)).status, 400)
    assert.equal((await state()).items.length, before)
  }
  const saved = (await ok('/items', { name: 'Photo resistor', sku: 'PHOTO', unit: 'Stück', value: '10 kΩ', estimatedUnitCost: '0,0125', supplierUrl: 'https://example.com/r', photoData })).items.find(i => i.sku === 'PHOTO')!
  assert.equal(saved.unit, 'pcs'); assert.equal(saved.estimatedUnitCost, 0.0125); assert.equal(saved.value, '10 kΩ')
  const path = new URL(saved.photoPath!, 'https://example.test').pathname.replace('/api/inventorySystem', '')
  assert.equal((await fetch(base + path)).status, 401)
  const readPhoto = () => fetch(base + path, { headers: { cookie: sw.cookie } })
  assert.equal((await readPhoto()).headers.get('content-type'), 'image/png')
  closeInventorySystemDatabase()
  assert.equal(Buffer.from(await (await readPhoto()).arrayBuffer()).toString('base64'), photoData.split(',')[1])
  await ok('/items/' + saved.id, { name: 'Renamed resistor' }, admin, 'PATCH')
  assert.equal((await state()).items.find(i => i.id === saved.id)?.photoPath, saved.photoPath)
  assert.equal((await call('/items/' + saved.id, { photoData: 'invalid', name: 'Must roll back' }, admin, 'PATCH')).status, 400)
  assert.equal((await state()).items.find(i => i.id === saved.id)?.name, 'Renamed resistor')
})

test('catalog imports validate every row, skip existing entries, and retry without duplicates', async () => {
  const raw = await call('/catalog/import/preview', { text: 'Name;SKU;Einheit;Preis EUR;Link\nImported screw;IMP-S;pcs;0,15;https://example.com/s\nMat material;IMP-M;m2;12.50;' }, admin)
  const preview = raw.data as unknown as { rows: Array<{ input: Record<string, unknown>; errors: string[] }> }
  assert.equal(raw.status, 200); assert(preview.rows.every(r => !r.errors.length))
  const body = { rows: preview.rows.map(r => r.input), idempotencyKey: crypto.randomUUID() }
  const first = await ok('/catalog/import', body); const second = await ok('/catalog/import', body)
  assert.equal(second.items.length, first.items.length)
  assert.equal(second.items.find(i => i.sku === 'IMP-M')?.unit, 'm²')
  await ok('/catalog/import', { ...body, idempotencyKey: crypto.randomUUID() })
  assert.equal((await state()).items.length, first.items.length, 'existing rows are skipped')
  assert.equal((await call('/catalog/import', { rows: [{ name: 'Must not exist', sku: 'ROLLBACK' }, { name: 'Invalid unit', unit: '()' }], idempotencyKey: crypto.randomUUID() }, admin)).status, 400)
  assert(!(await state()).items.some(i => i.sku === 'ROLLBACK'))
  assert.equal((await call('/catalog/import', body, sw)).status, 403)
  assert.equal((await call('/catalog/import/preview', { text: 'Name\nSneak' }, receiver)).status, 403)
})

test('XLSX imports preserve German prices, part numbers, multiline descriptions and row numbers', async () => {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.default.Workbook(), sheet = workbook.addWorksheet('Parts')
  sheet.addRow(['Name', 'SKU', 'Einheit', 'Preis EUR', 'Beschreibung', 'MPN'])
  sheet.addRow(['Capacitor', 'XLS-CAP', 'pcs', '0,0012', 'First line\nSecond line', 'CAP-010'])
  sheet.addRow([])
  sheet.addRow(['Mat', 'XLS-MAT', 'm²', 2.75])
  const response = await call('/catalog/import/preview', { fileName: 'parts.xlsx', contentBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') }, admin)
  assert.equal(response.status, 200)
  const rows = (response.data as unknown as { rows: Array<{ rowNumber: number; item: { estimatedUnitCost: number; manufacturerPartNumber: string; description: string }; errors: string[] }> }).rows
  assert.equal(rows[0].item.estimatedUnitCost, 0.0012); assert.equal(rows[0].item.manufacturerPartNumber, 'CAP-010'); assert.equal(rows[0].item.description, 'First line\nSecond line'); assert.equal(rows[1].rowNumber, 4)
  assert(rows.every(row => row.errors.length === 0))
})

test('non-exclusive project lists preserve stock and other projects, with audited changes', async () => {
  const p1 = (await ok('/projects', { name: 'DemoStorage', code: 'CEM' })).projects.find(p => p.code === 'CEM')!
  const p2 = (await ok('/projects', { name: 'DemoAccess', code: 'DOR' })).projects.find(p => p.code === 'DOR')!
  const before = await state()
  const body = { itemIds: [item.id], projectIds: [p1.id, p2.id], mode: 'add', idempotencyKey: crypto.randomUUID() }
  let changed = await ok('/catalog/projects', body)
  assert(projectPartIds(changed, p1.id).has(item.id)); assert(projectPartIds(changed, p2.id).has(item.id))
  assert.deepEqual(changed.records, before.records); assert.deepEqual(changed.assignments, before.assignments)
  changed = await ok('/catalog/projects', { ...body, projectIds: [p1.id], mode: 'remove', idempotencyKey: crypto.randomUUID() })
  assert(!projectPartIds(changed, p1.id).has(item.id)); assert(projectPartIds(changed, p2.id).has(item.id))
  assert.equal((await call('/catalog/projects', body, sw)).status, 403)
  const history = (await ok('/catalog/history?projectId=' + p2.id, undefined, sw)) as unknown as { activity: Array<{ action: string; actorName: string }> }
  assert(history.activity.some(e => e.action === 'project_created')); assert(history.activity.some(e => e.action === 'item_projects_updated'))
})

test('new purchase requests retain supplier links through approval, delivery and article history', async () => {
  const submitted = (await ok('/workflows/requests/batch', { lines: [{ itemName: 'New sensor from request', quantity: 2, unit: 'pcs', supplierUrl: 'https://example.com/sensor', estimatedUnitCost: 4.5 }] }, sw)).workflows!.requests[0]
  const placed = await order(submitted.id)
  const received = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines[0].id, quantity: 2, locationId: room.id }] }, receiver)
  const article = received.items.find(i => i.name === submitted.itemName)!
  assert(article); assert.equal(article.supplierUrl, submitted.supplierUrl); assert.equal(article.estimatedUnitCost, 4.5)
  const history = (await ok('/catalog/history?itemId=' + article.id, undefined, sw)) as unknown as { activity: Array<{ action: string; actorName: string }> }
  for (const action of ['request_submitted', 'request_reviewed', 'supplier_order_placed', 'workflow_delivery_received', 'item_created']) assert(history.activity.some(e => e.action === action), action)
  assert(history.activity.some(e => e.actorName === 'software_developer'))
})

test('article histories exclude other lines in partial deliveries and include unordered receipts', async () => {
  const other = (await ok('/items', { name: 'Separate article', sku: 'OTHER' })).items.find(i => i.sku === 'OTHER')!
  const requested = (await ok('/workflows/requests/batch', { lines: [{ itemId: item.id, quantity: 1 }, { itemId: other.id, quantity: 1 }] }, sw)).workflows!.requests.filter(r => r.status === 'pending')
  const approved = []
  for (const r of requested) approved.push(await approve(r.id))
  const placed = (await ok('/workflows/orders', { supplier: 'Supplier', reference: 'PARTIAL-HISTORY', shipping: 0, lines: approved.map(r => ({ requestId: r.id, expectedVersion: r.version, unitCost: 1 })) }, buyer)).workflows!.orders[0]
  const received = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines.find(l => l.itemId === item.id)!.id, quantity: 1, locationId: room.id }] }, receiver)
  type History = { activity: Array<{ action: string }> }
  const first = (await ok('/catalog/history?itemId=' + item.id, undefined, sw)) as unknown as History
  const second = (await ok('/catalog/history?itemId=' + other.id, undefined, sw)) as unknown as History
  assert(first.activity.some(e => e.action === 'workflow_delivery_received')); assert(!second.activity.some(e => e.action === 'workflow_delivery_received'))
  await ok('/workflows/receive', { lines: [{ itemId: other.id, quantity: 2, locationId: room.id }] }, receiver)
  const unordered = (await ok('/catalog/history?itemId=' + other.id, undefined, sw)) as unknown as History
  assert(unordered.activity.some(e => e.action === 'workflow_delivery_received'))
  assert(received.records.some(r => r.itemId === item.id))
})

