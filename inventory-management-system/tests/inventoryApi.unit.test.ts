import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import type { InventoryRecord, InventoryStatePayload } from '../shared/inventory.ts'
import { parseCsv } from '../server/receivingImport.ts'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'dco-inventory-api-'))
process.env.INVENTORY_SYSTEM_DATA = join(temporaryDirectory, 'inventory.sqlite')
process.env.INVENTORY_MEDIA_DIR = join(temporaryDirectory, 'media')
process.env.INVENTORY_REFERENCE_DATA_FILE = join(temporaryDirectory, 'reference.json')
const privateReferenceRoom = { code: 'PRIVATE-ROOM', name: 'Restricted reference room', planImagePath: '/inventory-media/private-plan.png' }
writeFileSync(process.env.INVENTORY_REFERENCE_DATA_FILE, JSON.stringify({ rooms: [privateReferenceRoom], locations: [], rows: [] }))
process.env.INVENTORY_SYSTEM_ADMIN_EMAIL = 'test-admin@example.test'
process.env.INVENTORY_SYSTEM_ADMIN_NAME = 'Test Administrator'
process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD = 'L7!nRf4*Kw9#pUv8'
process.env.DISABLE_LOCAL_WEB_LOGIN = 'false'
delete process.env.DCO_CORE_URL

const { inventorySystemRouter, closeInventorySystemDatabase } = await import('../server/inventorySystem.ts')
const app = express()
app.use(express.json({ limit: '8mb' }))
app.use('/api/inventorySystem', inventorySystemRouter)
const server = createServer(app)
async function listen(target: Server) {
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done))
  const address = target.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
const base = `${await listen(server)}/api/inventorySystem`
interface Session { cookie: string; csrf: string; userId: string }
async function request(path: string, method = 'GET', body?: unknown, session?: Session, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: await response.json() as InventoryStatePayload & { message?: string }, cookies: response.headers.getSetCookie() }
}
async function login(email: string): Promise<Session> {
  const result = await request('/auth/login', 'POST', { email, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD })
  assert.equal(result.status, 200, result.data.message)
  const cookie = result.cookies.find((value) => value.startsWith('inventory_session='))
  assert.ok(cookie)
  return { cookie: cookie.split(';')[0], csrf: result.data.csrfToken, userId: result.data.currentUser.id }
}
const admin = await login('test-admin@example.test')
for (const role of ['buyer', 'receiver']) {
  const result = await request('/users', 'POST', { name: `${role} Test Person`, email: `${role}@example.test`, role, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD, mustChangePassword: false }, admin)
  assert.equal(result.status, 201, result.data.message)
}
const buyer = await login('buyer@example.test')
const receiver = await login('receiver@example.test')
let result = await request('/locations', 'POST', { name: 'Test Room', code: 'TEST-ROOM', kind: 'room' }, admin)
assert.equal(result.status, 201, result.data.message)
const locationId = result.data.locations.find((location) => location.code === 'TEST-ROOM')!.id
result = await request('/items', 'POST', { name: 'Test Device', sku: 'TEST-DEVICE' }, admin)
assert.equal(result.status, 201, result.data.message)
const itemId = result.data.items.find((item) => item.sku === 'TEST-DEVICE')!.id

async function createRecord(quantity: number, state: InventoryRecord['state'] = 'in_stock') {
  const label = crypto.randomUUID()
  const result = await request('/records', 'POST', { itemId, locationId, quantity, state, label }, admin)
  assert.equal(result.status, 201, result.data.message)
  return result.data.records.find((record) => record.label === label)!
}
async function receiptBody(quantity: number, sourceRecordId?: string, idempotencyKey = crypto.randomUUID()) {
  return { receivedAt: '2026-09-01T12:00:00.000Z', idempotencyKey, lines: [{ itemId, locationId, quantity, sourceRecordId, sourceExpectedVersion: sourceRecordId ? await version(sourceRecordId) : undefined, notes: 'Fragile; inspect on arrival' }] }
}
async function state() {
  const result = await request('/state', 'GET', undefined, admin)
  assert.equal(result.status, 200, result.data.message)
  return result.data
}

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  closeInventorySystemDatabase()
  assert.equal(dirname(resolve(temporaryDirectory)), resolve(tmpdir()))
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

async function version(recordId: string) {
  return (await state()).records.find((record) => record.id === recordId)!.version
}

test('inventory projects allocate finite stock, preserve history and enforce permissions and revisions', async () => {
  const created = await request('/projects', 'POST', { name: 'Laboratory expansion', code: 'LAB-2026', description: 'Equipment for the new room' }, admin)
  assert.equal(created.status, 201, created.data.message)
  const project = created.data.projects.find(project => project.code === 'LAB-2026')!
  assert.ok(project)
  assert.equal((await request('/projects', 'POST', { name: 'Duplicate', code: 'lab-2026' }, admin)).status, 400)
  assert.equal((await request('/projects', 'POST', { name: 'Forbidden', code: 'DENIED' }, buyer)).status, 403)
  const record = await createRecord(5)
  const assign = (extra: Record<string, unknown>, session = admin) => request(`/records/${record.id}/assignments`, 'POST', { userId: admin.userId, projectId: project.id, quantity: 3, expectedVersion: record.version, ...extra }, session)
  assert.equal((await assign({}, buyer)).status, 403)
  assert.equal((await assign({ projectId: 'missing' })).status, 400)
  const assigned = await assign({})
  assert.equal(assigned.status, 201, assigned.data.message)
  const allocation = assigned.data.assignments.find(assignment => assignment.projectId === project.id)!
  assert.equal(allocation.quantity, 3)
  assert.equal(assigned.data.records.find(candidate => candidate.id === record.id)!.quantity, 5)
  assert.equal((await assign({})).status, 409)
  assert.equal((await assign({ expectedVersion: await version(record.id) })).status, 400)
  // Person-only assignments share the same availability pool.
  assert.equal((await assign({ projectId: '', expectedVersion: await version(record.id) })).status, 400)
  assert.equal((await request(`/projects/${project.id}`, 'PATCH', { active: false, expectedUpdatedAt: project.updatedAt }, admin)).status, 400)
  assert.equal((await request(`/records/${record.id}`, 'DELETE', { reason: 'Cannot remove allocated stock', expectedVersion: await version(record.id) }, admin)).status, 400)
  const returned = await request(`/assignments/${allocation.id}/return`, 'POST', { expectedVersion: await version(record.id) }, admin)
  assert.equal(returned.status, 200, returned.data.message)
  assert.ok(returned.data.assignments.find(assignment => assignment.id === allocation.id)!.returnedAt)
  assert.equal(returned.data.assignments.find(assignment => assignment.id === allocation.id)!.projectId, project.id)
  const archived = await request(`/projects/${project.id}`, 'PATCH', { active: false, expectedUpdatedAt: project.updatedAt }, admin)
  assert.equal(archived.status, 200, archived.data.message)
  assert.equal((await assign({ quantity: 1, expectedVersion: await version(record.id) })).status, 400)
  assert.equal((await request(`/projects/${project.id}`, 'PATCH', { name: 'Stale', expectedUpdatedAt: project.updatedAt }, admin)).status, 409)
  const latest = archived.data.projects.find(candidate => candidate.id === project.id)!
  assert.equal((await request(`/projects/${project.id}`, 'PATCH', { active: true, expectedUpdatedAt: latest.updatedAt }, admin)).status, 200)
})
test('receiving consumes a source with no optional reference once and safely replays the same request', async () => {
  const source = await createRecord(4, 'delivered')
  const body = await receiptBody(4, source.id)
  const initial = await state()
  const first = await request('/receipts', 'POST', body, receiver)
  assert.equal(first.status, 201, first.data.message)
  const replay = await request('/receipts', 'POST', body, receiver)
  assert.equal(replay.status, 200, replay.data.message)
  assert.equal(replay.data.receipts.length, initial.receipts.length + 1)
  assert.equal(replay.data.records.length, initial.records.length + 1)
  assert.equal(replay.data.records.find((record) => record.id === source.id)?.quantity, 0)
  assert.equal(replay.data.records.find((record) => record.id === source.id)?.state, 'cancelled')
  assert.equal(replay.data.receiptLines.find((line) => line.sourceRecordId === source.id)?.quantity, 4)
  const duplicate = await request('/receipts', 'POST', await receiptBody(4, source.id), receiver)
  assert.equal(duplicate.status, 400)
  assert.equal((await state()).receipts.length, replay.data.receipts.length)
})

test('partial receiving validates remaining units and rolls back an entire invalid batch', async () => {
  const source = await createRecord(10, 'ordered')
  const first = await request('/receipts', 'POST', await receiptBody(4, source.id), receiver)
  assert.equal(first.status, 201)
  const overflow = await request('/receipts', 'POST', await receiptBody(7, source.id), receiver)
  assert.equal(overflow.status, 400)
  const batch = await receiptBody(4, source.id)
  batch.lines.push({ ...batch.lines[0] })
  const failedBatch = await request('/receipts', 'POST', batch, receiver)
  assert.equal(failedBatch.status, 400)
  const current = await state()
  assert.equal(current.records.find((record) => record.id === source.id)?.quantity, 6)
  assert.equal(current.receipts.length, first.data.receipts.length)
  assert.equal(current.records.length, first.data.records.length)
})

test('idempotency keys reject changed input without silently returning an unrelated receipt', async () => {
  const body = await receiptBody(3)
  assert.equal((await request('/receipts', 'POST', body, receiver)).status, 201)
  const changed = { ...body, lines: [{ ...body.lines[0], quantity: 5 }] }
  assert.equal((await request('/receipts', 'POST', changed, receiver)).status, 409)
})

test('buyers cannot turn physical stock into procurement records or split it, while receivers can receive orders', async () => {
  const physical = await createRecord(10)
  const cancel = await request(`/records/${physical.id}`, 'PATCH', { expectedVersion: await version(physical.id), state: 'cancelled' }, buyer)
  assert.equal(cancel.status, 403)
  const split = await request(`/records/${physical.id}/split`, 'POST', { expectedVersion: await version(physical.id), quantity: 3, state: 'requested' }, buyer)
  assert.equal(split.status, 403)
  assert.equal((await state()).records.find((record) => record.id === physical.id)?.state, 'in_stock')
  const order = await createRecord(5, 'ordered')
  assert.equal((await request(`/records/${order.id}`, 'PATCH', { expectedVersion: await version(order.id), state: 'delivered' }, receiver)).status, 200)
  assert.equal((await request(`/records/${order.id}`, 'PATCH', { expectedVersion: await version(order.id), state: 'in_stock' }, receiver)).status, 409)
  assert.equal((await request('/receipts', 'POST', await receiptBody(5, order.id), receiver)).status, 201)
})

test('assigned stock cannot be split, corrected, or reversed below its assigned quantity', async () => {
  const received = await request('/receipts', 'POST', await receiptBody(10), receiver)
  assert.equal(received.status, 201)
  const line = received.data.receiptLines[0]
  const assigned = await request(`/records/${line.recordId}/assignments`, 'POST', { expectedVersion: await version(line.recordId), quantity: 10, userId: buyer.userId }, admin)
  assert.equal(assigned.status, 201, assigned.data.message)
  assert.equal((await request(`/records/${line.recordId}/split`, 'POST', { expectedVersion: await version(line.recordId), quantity: 5, state: 'in_stock' }, admin)).status, 400)
  assert.equal((await request(`/records/${line.recordId}`, 'PATCH', { expectedVersion: await version(line.recordId), quantity: 5, changeReason: 'Count correction' }, admin)).status, 400)
  assert.equal((await request(`/receipt-lines/${line.id}/correct`, 'POST', { expectedVersion: await version(line.recordId), quantity: 7, reason: 'Count correction' }, receiver)).status, 400)
  assert.equal((await request(`/records/${line.recordId}`, 'DELETE', { expectedVersion: await version(line.recordId), reason: 'Return delivery' }, admin)).status, 400)
  const current = await state()
  assert.equal(current.records.find((record) => record.id === line.recordId)?.quantity, 10)
  assert.equal(current.records.length, assigned.data.records.length)
  const assignment = current.assignments.find((assignment) => assignment.recordId === line.recordId)!
  assert.equal((await request(`/assignments/${assignment.id}/return`, 'POST', { expectedVersion: await version(line.recordId) }, admin)).status, 200)
  assert.equal((await request(`/records/${line.recordId}`, 'DELETE', { expectedVersion: await version(line.recordId), reason: 'Returned delivery' }, admin)).status, 200)
})

test('an unassigned remainder can be split without changing any custody quantities', async () => {
  const record = await createRecord(10)
  assert.equal((await request(`/records/${record.id}/assignments`, 'POST', { expectedVersion: await version(record.id), quantity: 5, userId: buyer.userId }, admin)).status, 201)
  const split = await request(`/records/${record.id}/split`, 'POST', { expectedVersion: await version(record.id), quantity: 3, state: 'in_stock' }, admin)
  assert.equal(split.status, 201, split.data.message)
  assert.equal(split.data.records.find((entry) => entry.id === record.id)?.quantity, 7)
  assert.equal(split.data.assignments.find((assignment) => assignment.recordId === record.id)?.quantity, 5)
  const damaged = await createRecord(1, 'damaged')
  assert.equal((await request(`/records/${damaged.id}/assignments`, 'POST', { expectedVersion: await version(damaged.id), quantity: 1, userId: buyer.userId }, admin)).status, 400)
})

test('the receipt journal preserves originals, exports adjustments and reversals, and quotes semicolons', async () => {
  const created = await request('/receipts', 'POST', { ...await receiptBody(10), receivedAt: '2026-08-01T12:00:00.000Z' }, receiver)
  assert.equal(created.status, 201)
  const newIds = new Set(created.data.receiptLines.filter((line) => created.data.receipts.find((receipt) => receipt.id === line.receiptId)?.receivedAt.startsWith('2026-08')).map((line) => line.id))
  assert.equal(newIds.size, 1)
  const line = created.data.receiptLines.find((line) => newIds.has(line.id))!
  const correction = await request(`/receipt-lines/${line.id}/correct`, 'POST', { expectedVersion: await version(line.recordId), quantity: 7, reason: 'Three units; not delivered' }, receiver)
  assert.equal(correction.status, 200)
  const reversal = await request(`/records/${line.recordId}`, 'DELETE', { expectedVersion: await version(line.recordId), reason: 'Delivery returned' }, admin)
  assert.equal(reversal.status, 200)
  const journalLine = reversal.data.receiptLines.find((entry) => entry.id === line.id)!
  assert.equal(journalLine.quantity, 10)
  assert.equal(journalLine.currentQuantity, 0)
  assert.equal(journalLine.adjustments?.length, 2)
  assert.ok(journalLine.reversedByEventId)
  assert.equal((await request(`/receipt-lines/${line.id}/correct`, 'POST', { expectedVersion: await version(line.recordId), quantity: 4, reason: 'Cannot undo reversal' }, receiver)).status, 400)
  const response = await fetch(`${base}/receipts/export?month=2026-08`, { headers: { Cookie: admin.cookie } })
  assert.equal(response.status, 200)
  const [headers, ...rows] = parseCsv(await response.text())
  assert.equal(rows.length, 3)
  assert.ok(rows.every((row) => row.length === headers.length))
  assert.deepEqual(rows.map((row) => row[headers.indexOf('Entry type')]), ['received', 'corrected', 'reversed'])
  assert.equal(rows.reduce((sum, row) => sum + Number(row[headers.indexOf('Quantity change')]), 0), 0)
  assert.equal(rows[0][headers.indexOf('Notes')], 'Fragile; inspect on arrival')
  assert.equal(rows[1][headers.indexOf('Reason')], 'Three units; not delivered')
  assert.ok(rows.every((row) => row[headers.indexOf('Status')] === 'reversed'))
})

test('stale and missing stock revisions cannot overwrite a newer edit', async () => {
  const original = await createRecord(10)
  const changed = await request(`/records/${original.id}`, 'PATCH', { ...original, quantity: 6, expectedVersion: original.version, changeReason: 'Physical count' }, admin)
  assert.equal(changed.status, 200, changed.data.message)
  const latest = changed.data.records.find((record) => record.id === original.id)!
  assert.equal(latest.version, original.version + 1)
  const stale = await request(`/records/${original.id}`, 'PATCH', { ...original, notes: 'Old form notes', expectedVersion: original.version, changeReason: 'Notes only' }, admin)
  assert.equal(stale.status, 409)
  assert.equal((await request(`/records/${original.id}`, 'PATCH', { notes: 'Unversioned client', changeReason: 'Notes only' }, admin)).status, 409)
  for (const expectedVersion of [null, '2', 0, 1.5]) {
    assert.equal((await request(`/records/${original.id}`, 'PATCH', { notes: 'Invalid version', expectedVersion, changeReason: 'Notes only' }, admin)).status, 409)
  }
  const concurrent = await Promise.all(['A', 'B'].map((notes) => request(`/records/${original.id}`, 'PATCH', { notes, expectedVersion: latest.version, changeReason: 'Concurrent note edit' }, admin)))
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409])
  const final = (await state()).records.find((record) => record.id === original.id)!
  assert.equal(final.quantity, 6)
  assert.equal(final.version, latest.version + 1)
})

test('custody changes, splits and reversals advance stock revisions', async () => {
  const original = await createRecord(10)
  const assigned = await request(`/records/${original.id}/assignments`, 'POST', { expectedVersion: original.version, quantity: 1, userId: buyer.userId }, admin)
  assert.equal(assigned.status, 201)
  const assignedRecord = assigned.data.records.find((record) => record.id === original.id)!
  assert.equal(assignedRecord.state, 'in_stock')
  assert.equal(assignedRecord.version, original.version + 1)
  assert.equal((await request(`/records/${original.id}/assignments`, 'POST', { expectedVersion: original.version, quantity: 1, userId: buyer.userId }, admin)).status, 409)
  const assignment = assigned.data.assignments.find((entry) => entry.recordId === original.id)!
  assert.equal((await request(`/assignments/${assignment.id}/return`, 'POST', {}, admin)).status, 409)
  const returned = await request(`/assignments/${assignment.id}/return`, 'POST', { expectedVersion: assignedRecord.version }, admin)
  assert.equal(returned.status, 200)
  const returnedRecord = returned.data.records.find((record) => record.id === original.id)!
  assert.equal(returnedRecord.version, assignedRecord.version + 1)
  assert.equal((await request(`/records/${original.id}/split`, 'POST', { expectedVersion: assignedRecord.version, quantity: 3 }, admin)).status, 409)
  const split = await request(`/records/${original.id}/split`, 'POST', { expectedVersion: returnedRecord.version, quantity: 3 }, admin)
  assert.equal(split.status, 201)
  assert.equal(split.data.records.find((record) => record.id === original.id)!.version, returnedRecord.version + 1)
  const newRecord = split.data.records.find((record) => !returned.data.records.some((previous) => previous.id === record.id))!
  assert.equal(newRecord.version, 1)
  assert.equal((await request(`/records/${original.id}`, 'DELETE', { expectedVersion: returnedRecord.version, reason: 'Stale reversal' }, admin)).status, 409)
  assert.equal((await request(`/records/${original.id}`, 'DELETE', { expectedVersion: returnedRecord.version + 1, reason: 'Verified reversal' }, admin)).status, 200)
})

test('receiving requires fresh source revisions and accepts multiple lines from one source atomically', async () => {
  const source = await createRecord(10, 'ordered')
  const body = await receiptBody(2, source.id)
  body.lines.push({ ...body.lines[0] })
  const batch = await request('/receipts', 'POST', body, receiver)
  assert.equal(batch.status, 201, batch.data.message)
  const remaining = batch.data.records.find((record) => record.id === source.id)!
  assert.equal(remaining.quantity, 6)
  assert.equal(remaining.version, source.version + 2)
  const replay = await request('/receipts', 'POST', body, receiver)
  assert.equal(replay.status, 200)
  assert.equal(replay.data.receipts.length, batch.data.receipts.length)
  const stale = { ...body, idempotencyKey: crypto.randomUUID() }
  assert.equal((await request('/receipts', 'POST', stale, receiver)).status, 409)
  const missing = await receiptBody(1, source.id)
  missing.lines[0].sourceExpectedVersion = undefined
  assert.equal((await request('/receipts', 'POST', missing, receiver)).status, 409)
  assert.equal((await state()).receipts.length, batch.data.receipts.length)
})

test('partial catalog updates preserve every component identity field', async () => {
  const created = await request('/items', 'POST', { name: 'Metadata component', sku: 'AUDIT-METADATA', value: '10k', manufacturerPartNumber: 'R1234', lcscPartNumber: 'C1234', packageForm: '0603' }, admin)
  const original = created.data.items.find((item) => item.sku === 'AUDIT-METADATA')!
  const edited = await request(`/items/${original.id}`, 'PATCH', { minQuantity: 2 }, admin)
  assert.equal(edited.status, 200)
  const saved = edited.data.items.find((item) => item.id === original.id)!
  for (const field of ['value', 'manufacturerPartNumber', 'lcscPartNumber', 'packageForm'] as const) assert.equal(saved[field], original[field])
  assert.equal(saved.minQuantity, 2)
})

test('damaged receipts stay unavailable through corrections and require explicit audited release', async () => {
  const initial = await state()
  const body = await receiptBody(7)
  Object.assign(body.lines[0], { discrepancy: 'damaged' })
  const received = await request('/receipts', 'POST', body, receiver)
  assert.equal(received.status, 201)
  const line = received.data.receiptLines.find((line) => !initial.receiptLines.some((previous) => previous.id === line.id))!
  const stock = received.data.records.find((record) => record.id === line.recordId)!
  assert.equal(stock.quarantined, true)
  assert.equal(stock.state, 'damaged')
  assert.equal(stock.condition, 'damaged')
  assert.equal(line.reviewRequired, true)
  assert.equal(line.quarantined, true)
  assert.equal(line.currentVersion, stock.version)
  assert.equal(received.data.totals.find((total) => total.itemId === itemId)!.usableQuantity, initial.totals.find((total) => total.itemId === itemId)!.usableQuantity)
  assert.equal((await request(`/records/${stock.id}/assignments`, 'POST', { expectedVersion: stock.version, quantity: 1, userId: buyer.userId }, admin)).status, 400)
  assert.equal((await request(`/records/${stock.id}/split`, 'POST', { expectedVersion: stock.version, quantity: 1 }, admin)).status, 400)
  assert.equal((await request(`/records/${stock.id}`, 'PATCH', { expectedVersion: stock.version, state: 'in_stock', condition: 'new', quarantined: false, changeReason: 'Attempted bypass' }, admin)).status, 400)
  const corrected = await request(`/receipt-lines/${line.id}/correct`, 'POST', { expectedVersion: stock.version, quantity: 6, reason: 'One missing unit' }, receiver)
  assert.equal(corrected.status, 200)
  assert.equal(corrected.data.receiptLines.find((entry) => entry.id === line.id)!.quarantined, true)
  assert.equal((await request(`/receipt-lines/${line.id}/correct`, 'POST', { expectedVersion: stock.version, quantity: 4, reason: 'Stale correction' }, receiver)).status, 409)
  const release = { expectedVersion: stock.version + 1, reason: 'Inspected and repaired; six units are safe to use', itemId, condition: 'usable' }
  assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', release, buyer)).status, 403)
  assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', { ...release, reason: '' }, receiver)).status, 400)
  assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', { ...release, condition: 'damaged' }, receiver)).status, 400)
  assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', { ...release, expectedVersion: stock.version }, receiver)).status, 409)
  const fault = new DatabaseSync(process.env.INVENTORY_SYSTEM_DATA!)
  fault.exec("CREATE TRIGGER audit_release_failure BEFORE INSERT ON inventory_record_events WHEN NEW.reason LIKE 'Quarantine release:%' BEGIN SELECT RAISE(ABORT, 'Synthetic audit failure'); END;")
  try {
    assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', release, receiver)).status, 400)
    const failed = (await state()).receiptLines.find((entry) => entry.id === line.id)!
    assert.equal(failed.quarantined, true, 'a failure after updating the record rolls the release back')
    assert.equal(failed.currentVersion, release.expectedVersion)
    assert.equal(failed.releasedByEventId, undefined)
  } finally {
    fault.exec('DROP TRIGGER audit_release_failure;')
    fault.close()
  }
  const released = await request(`/receipt-lines/${line.id}/release`, 'POST', release, receiver)
  assert.equal(released.status, 200, released.data.message)
  const releasedLine = released.data.receiptLines.find((entry) => entry.id === line.id)!
  const releasedStock = released.data.records.find((record) => record.id === stock.id)!
  assert.equal(releasedStock.quarantined, false)
  assert.equal(releasedStock.state, 'in_stock')
  assert.equal(releasedStock.condition, 'usable')
  assert.equal(releasedLine.quantity, 7, 'original receipt quantity remains immutable')
  assert.equal(releasedLine.condition, 'damaged', 'original received condition remains immutable')
  assert.equal(releasedLine.discrepancy, 'damaged')
  assert.ok(releasedLine.releasedByEventId)
  const event = released.data.recordEvents.find((event) => event.id === releasedLine.releasedByEventId)!
  assert.equal(event.receiptLineId, line.id)
  assert.equal(event.before!.quarantined, true)
  assert.equal(event.after!.quarantined, false)
  assert.equal((await request(`/receipt-lines/${line.id}/release`, 'POST', { ...release, expectedVersion: releasedStock.version }, receiver)).status, 400)
  assert.equal((await request(`/records/${stock.id}/assignments`, 'POST', { expectedVersion: releasedStock.version, quantity: 1, userId: buyer.userId }, admin)).status, 201)
})

test('wrong-item receipts do not fulfill an order and release records the actual item without rewriting the receipt', async () => {
  const source = await createRecord(5, 'ordered')
  const before = await state()
  const body = await receiptBody(3, source.id)
  Object.assign(body.lines[0], { discrepancy: 'wrong_item' })
  const received = await request('/receipts', 'POST', body, receiver)
  assert.equal(received.status, 201)
  assert.equal(received.data.records.find((record) => record.id === source.id)!.quantity, 5)
  const line = received.data.receiptLines.find((line) => !before.receiptLines.some((previous) => previous.id === line.id))!
  const created = await request('/items', 'POST', { name: 'Actual received model', sku: 'ACTUAL-MODEL' }, admin)
  const actualItem = created.data.items.find((item) => item.sku === 'ACTUAL-MODEL')!
  const released = await request(`/receipt-lines/${line.id}/release`, 'POST', { expectedVersion: line.currentVersion, itemId: actualItem.id, condition: 'new', reason: 'Inspected labels; accepted this different model separately' }, receiver)
  assert.equal(released.status, 200, released.data.message)
  assert.equal(released.data.records.find((record) => record.id === line.recordId)!.itemId, actualItem.id)
  assert.equal(released.data.receiptLines.find((entry) => entry.id === line.id)!.itemId, itemId)
  assert.equal(released.data.records.find((record) => record.id === source.id)!.quantity, 5)
})

test('unusable condition blocks assignment and availability even without a receipt quarantine flag', async () => {
  const stock = await createRecord(2)
  const changed = await request(`/records/${stock.id}`, 'PATCH', { expectedVersion: stock.version, condition: 'expired', changeReason: 'Shelf-life inspection' }, admin)
  assert.equal(changed.status, 200)
  assert.equal((await request(`/records/${stock.id}/assignments`, 'POST', { expectedVersion: stock.version + 1, quantity: 1, userId: buyer.userId }, admin)).status, 400)
})
test('additive safety migration preserves legacy quantities, conditions and history across restarts', async () => {
  closeInventorySystemDatabase()
  const legacy = new DatabaseSync(process.env.INVENTORY_SYSTEM_DATA!)
  const historical = legacy.prepare('SELECT id, itemId, locationId, quantity, state, condition, createdAt, updatedAt FROM inventory_records ORDER BY id').all()
  const history = legacy.prepare('SELECT * FROM inventory_record_events ORDER BY id').all()
  legacy.exec('ALTER TABLE inventory_records DROP COLUMN version; ALTER TABLE inventory_records DROP COLUMN quarantined; ALTER TABLE inventory_receipt_lines DROP COLUMN releasedByEventId;')
  legacy.close()
  const migrated = await state()
  assert.ok(migrated.records.every((record) => record.version === 1 && record.quarantined === false))
  closeInventorySystemDatabase()
  const checked = new DatabaseSync(process.env.INVENTORY_SYSTEM_DATA!)
  assert.deepEqual(checked.prepare('SELECT id, itemId, locationId, quantity, state, condition, createdAt, updatedAt FROM inventory_records ORDER BY id').all(), historical)
  assert.deepEqual(checked.prepare('SELECT * FROM inventory_record_events ORDER BY id').all(), history)
  const recordId = migrated.records[0].id
  checked.prepare('UPDATE inventory_records SET version = 11 WHERE id = ?').run(recordId)
  checked.close()
  assert.equal((await state()).records.find((record) => record.id === recordId)!.version, 11, 'subsequent startups do not reset revisions')
})

test('suite requests use authoritative Core identity and recheck revocation and write access every time', async () => {
  const coreApp = express()
  coreApp.use(express.json())
  let revoked = false
  let readOnly = false
  let membership = true
  let logoutFailure = false
  let lastIntrospection: Record<string, unknown> | undefined
  let lastApproval: Record<string, unknown> | undefined
  const identity = { id: 'core-admin-id', name: 'Core Administrator', email: 'test-admin@example.test', role: 'admin', active: true, mustChangePassword: false, moduleRole: 'admin', readOnly: false }
  coreApp.post('/api/core/internal/introspect', (req, res) => {
    lastIntrospection = req.body
    if (req.body.token !== 'core-valid-token' || revoked) { res.status(401).json({ message: 'Session revoked' }); return }
    if (identity.mustChangePassword && !req.body.allowPasswordChange) { res.status(403).json({ message: 'Change your password' }); return }
    if (!membership || (readOnly && req.body.write)) { res.status(403).json({ message: 'Module access denied' }); return }
    res.json({ user: { ...identity, readOnly } })
  })
  coreApp.post('/api/core/internal/login', (req, res) => {
    if (req.body.password !== 'CoreOnly!Password') { res.status(401).json({ message: 'Incorrect Core password' }); return }
    res.json({ user: identity, sessionToken: 'core-valid-token', expiresAt: '2026-10-01T00:00:00.000Z' })
  })
  coreApp.post('/api/core/internal/qr-login/challenges/approve', (req, res) => {
    lastApproval = req.body
    res.json({ ok: true })
  })
  coreApp.post('/api/core/auth/logout', (_req, res) => {
    res.status(logoutFailure ? 503 : 200).json(logoutFailure ? { message: 'Core unavailable' } : { ok: true })
  })
  const core = createServer(coreApp)
  process.env.DCO_CORE_URL = await listen(core)
  process.env.DCO_INTERNAL_AUTH_SECRET = 'test-internal-secret'
  process.env.DCO_CORE_LOGIN_URL = '/'
  try {
    assert.equal((await request('/state', 'GET', undefined, admin)).status, 401, 'legacy local cookie must not bypass Core')
    const headers = { Authorization: 'Bearer core-valid-token' }
    const authenticated = await request('/state', 'GET', undefined, undefined, headers)
    assert.equal(authenticated.status, 200, authenticated.data.message)
    assert.equal(authenticated.data.currentUser.id, admin.userId, 'migration preserves the existing Inventory profile ID')
    assert.equal(authenticated.data.currentUser.name, 'Core Administrator')
    assert.equal(authenticated.data.usersManagedByCore, true)
    assert.equal(lastIntrospection?.moduleId, 'inventory')
    const ambient = await request('/state', 'GET', undefined, undefined, { Cookie: 'dco_core_session=core-valid-token', 'x-inventory-mobile-app': '1' })
    assert.equal(ambient.status, 200)
    assert.equal(ambient.data.sessionToken, undefined, 'forged mobile flag cannot extract the HttpOnly Core cookie')
    assert.equal(ambient.data.csrfToken, 'core-cookie-session', 'suite CSRF payload has no credential-derived data')
    assert.deepEqual(ambient.data.referenceRooms, [privateReferenceRoom])
    identity.mustChangePassword = true
    const restricted = await request('/state', 'GET', undefined, undefined, headers)
    assert.equal(restricted.status, 200)
    assert.equal(restricted.data.currentUser.mustChangePassword, true)
    for (const field of ['locations', 'items', 'records', 'assignments', 'activity', 'receipts', 'receiptLines', 'recordEvents', 'qrLabels', 'referenceRooms'] as const) {
      assert.deepEqual(restricted.data[field], [], `temporary-password state must not expose ${field}`)
    }
    assert.equal((await request('/items', 'POST', { name: 'Blocked until password changes' }, undefined, headers)).status, 403)
    identity.mustChangePassword = false
    revoked = true
    assert.equal((await request('/state', 'GET', undefined, undefined, headers)).status, 401)
    revoked = false
    assert.equal((await request('/state', 'GET', undefined, undefined, { ...headers, Cookie: 'dco_core_session=revoked-cookie' })).status, 401, 'ambient Core cookie takes precedence over bearer')
    membership = false
    assert.equal((await request('/state', 'GET', undefined, undefined, headers)).status, 403)
    membership = true
    readOnly = true
    const read = await request('/state', 'GET', undefined, undefined, headers)
    assert.equal(read.status, 200)
    assert.deepEqual(read.data.permissions, ['read_inventory', 'export_inventory'])
    assert.equal((await request('/items', 'POST', { name: 'Forbidden write' }, undefined, headers)).status, 403)
    assert.equal(lastIntrospection?.write, true)
    readOnly = false
    assert.equal((await request('/users', 'POST', {}, undefined, headers)).status, 409, 'identity management is centralized in Core')
    assert.equal((await request('/auth/login', 'POST', { email: identity.email, password: 'CoreOnly!Password' })).status, 409, 'web users sign in through Core')
    const mobileHeaders = { 'x-inventory-mobile-app': '1', Origin: 'https://localhost' }
    assert.equal((await request('/auth/login', 'POST', { email: identity.email, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD }, undefined, mobileHeaders)).status, 401, 'local Inventory passwords cannot bypass Core on mobile')
    const mobile = await request('/auth/login', 'POST', { email: identity.email, password: 'CoreOnly!Password' }, undefined, mobileHeaders)
    assert.equal(mobile.status, 200, mobile.data.message)
    assert.equal(mobile.data.sessionToken, 'core-valid-token')
    assert.ok(mobile.cookies.every((cookie) => !cookie.startsWith('digital_office_sso=')))
    assert.equal((await request('/auth/qr-login/challenges/approve', 'POST', { token: 'desktop-challenge' }, undefined, { ...mobileHeaders, Authorization: `Bearer ${mobile.data.sessionToken}` })).status, 200)
    assert.deepEqual(lastApproval, { token: 'desktop-challenge', sessionToken: 'core-valid-token' })
    assert.equal((await request('/auth/qr-login/claim', 'POST', { token: 'legacy-grant' })).status, 409)
    logoutFailure = true
    const failedLogout = await request('/auth/logout', 'POST', {}, undefined, headers)
    assert.equal(failedLogout.status, 503)
    assert.deepEqual(failedLogout.cookies, [], 'unconfirmed Core revocation must not clear cookies or report success')
    logoutFailure = false
    assert.equal((await request('/auth/logout', 'POST', {}, undefined, headers)).status, 200)
    identity.id = 'core-new-person'
    identity.email = 'new-person@example.test'
    identity.name = 'New Core Person'
    identity.moduleRole = 'receiver'
    const fresh = await request('/state', 'GET', undefined, undefined, headers)
    assert.equal(fresh.status, 200)
    assert.equal(fresh.data.currentUser.id, 'core-new-person')
    assert.equal(fresh.data.currentUser.role, 'receiver')
    identity.id = 'core-reused-email'
    assert.equal((await request('/state', 'GET', undefined, undefined, headers)).status, 409, 'a different Core account cannot inherit a linked local profile by email')
    identity.id = 'core-new-person'
    identity.email = 'renamed-person@example.test'
    assert.equal((await request('/state', 'GET', undefined, undefined, headers)).data.currentUser.id, 'core-new-person', 'persistent Core binding survives an email change')
    identity.id = 'core-reused-email'
    identity.email = 'new-person@example.test'
    const reused = await request('/state', 'GET', undefined, undefined, headers)
    assert.equal(reused.status, 200)
    assert.equal(reused.data.currentUser.id, 'core-reused-email', 'released email gets a new profile without old custody/history')
    identity.id = 'core-new-person'
    assert.equal((await request('/state', 'GET', undefined, undefined, headers)).status, 409, 'Core binding takes precedence over a conflicting reused email')
  } finally {
    delete process.env.DCO_CORE_URL
    core.closeAllConnections()
    await new Promise<void>((done) => core.close(() => done()))
  }
})
