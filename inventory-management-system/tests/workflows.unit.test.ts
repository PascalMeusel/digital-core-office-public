import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'node:http'
import express from 'express'
import type { InventoryStatePayload, InventoryRecord } from '../shared/inventory.ts'
import { availableStock, buildRequirements, groupWorkRequests, inventorySupply, materialUsageCosts, orderLineCosts, projectPartIds, stockRequestIssued } from '../shared/workflows.ts'

const directory = mkdtempSync(join(tmpdir(), 'dco-workflows-'))
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
for (const role of ['hardware_developer', 'software_developer', 'buyer', 'receiver', 'buyer_receiver', 'stock_manager', 'viewer']) {
  await ok('/users', { name: role, email: `${role}@example.test`, role, password: process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD, mustChangePassword: false })
  sessions[role] = await login(`${role}@example.test`)
}
const hw = sessions.hardware_developer, sw = sessions.software_developer, buyer = sessions.buyer, receiver = sessions.receiver
const state = () => ok('/state')
const room = (await ok('/locations', { name: 'Workshop', code: 'WORK', kind: 'room' })).locations.find(l => l.code === 'WORK')!
const shelf = (await ok('/locations', { name: 'Parts shelf', code: 'PARTS', kind: 'fixture', parentId: room.id })).locations.find(l => l.code === 'PARTS')!
const item = (await ok('/items', { name: 'Controller board', sku: 'CTRL', unit: 'pcs' })).items.find(i => i.sku === 'CTRL')!
async function stock(quantity: number, unitCost?: number) {
  const label = crypto.randomUUID()
  return (await ok('/records', { itemId: item.id, locationId: room.id, quantity, unitCost, state: 'in_stock', condition: 'new', label })).records.find(r => r.label === label)!
}
async function purchase(extra = {}, session = hw) {
  const result = await ok('/workflows/requests', { kind: 'purchase', itemId: item.id, quantity: 4, estimatedUnitCost: 2.5, estimatedShipping: 1, reason: 'Experimental PCB', ...extra }, session)
  return result.workflows!.requests[0]
}
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

test('responsibilities enforce request / approval / purchase / receipt separation', async () => {
  const request = await purchase()
  for (const actor of [hw, sw, receiver, sessions.viewer]) assert.equal((await call(`/workflows/requests/${request.id}/review`, { expectedVersion: 1, decision: 'approve' }, actor)).status, 403)
  assert.equal((await call('/workflows/requests', { kind: 'purchase', itemId: item.id, quantity: 1, reason: 'No permission' }, sessions.viewer)).status, 403)
  assert.equal((await call('/projects', { name: 'Electronics', code: 'ELEC' }, hw)).status, 201)
  const approved = await approve(request.id)
  assert.equal((await call('/workflows/orders', { supplier: 'Supplier', reference: 'PREMATURE', shipping: 0, lines: [{ requestId: approved.id, expectedVersion: approved.version, unitCost: 2 }] }, admin)).status, 403, 'Only the actual approver places the order')
  assert.equal((await call('/workflows/orders', { supplier: 'Supplier', reference: 'OVER', shipping: 0, lines: [{ requestId: approved.id, expectedVersion: approved.version, unitCost: 3 }] }, buyer)).status, 400)
  assert.equal((await call(`/workflows/requests/${approved.id}/edit`, { expectedVersion: approved.version, kind: 'purchase', itemId: item.id, quantity: 100, reason: 'Changed after approval' }, hw)).status, 403)
  assert.equal((await call('/workflows/receive', { lines: [{ itemId: item.id, quantity: 1, locationId: room.id }] }, hw)).status, 403)
  assert.equal((await call('/workflows/products', { name: 'Forbidden' }, sw)).status, 403)
  const reopened = (await ok(`/workflows/requests/${approved.id}/reopen`, { expectedVersion: approved.version, note: 'Supplier increased price' }, buyer)).workflows!.requests.find(r => r.id === request.id)!
  assert.equal(reopened.status, 'changes_requested')
  const updated = (await ok(`/workflows/requests/${request.id}/edit`, { expectedVersion: reopened.version, kind: 'purchase', itemId: item.id, quantity: 4, estimatedUnitCost: 3, reason: 'Updated quote' }, hw)).workflows!.requests.find(r => r.id === request.id)!
  assert.equal(updated.status, 'pending'); assert.equal(updated.reviewedBy, undefined)
})

test('batch review is atomic, permission checked, versioned and idempotent', async () => {
  const before = await state()
  const result = await ok('/workflows/requests/batch', { lines: [{ itemId: item.id, quantity: 2 }, { itemName: 'Batch cable', quantity: 1 }, { itemName: 'Batch mat', quantity: 0.5, unit: 'm²' }] }, sw)
  const rows = result.workflows!.requests.filter(r => !before.workflows!.requests.some(old => old.id === r.id))
  const batchId = rows[0].batchId!, path = `/workflows/request-batches/${batchId}/review`
  const lines = rows.map((r, index) => ({ requestId: r.id, expectedVersion: r.version, decision: index === 2 ? 'defer' : 'approve', note: index === 2 ? 'Confirm dimensions first' : '' }))
  for (const actor of [hw, sw, receiver, sessions.viewer]) assert.equal((await call(path, { lines }, actor)).status, 403)
  const other = await purchase()
  const cases = [
    { lines: [...lines.slice(0, 2), { ...lines[2], note: '' }] },
    { lines: [...lines, lines[0]] },
    { lines: [...lines.slice(0, 2), { ...lines[2], requestId: other.id }] },
    { lines: [...lines.slice(0, 2), { ...lines[2], decision: 'invalid' }] },
  ]
  for (const body of cases) {
    assert.equal((await call(path, body, buyer)).status, 400)
    const unchanged = (await state()).workflows!.requests.filter(r => r.batchId === batchId)
    assert.deepEqual(unchanged, rows, 'invalid later positions roll back the whole review')
  }
  assert.equal((await call(path, { lines: [...lines.slice(0, 2), { ...lines[2], expectedVersion: 0 }] }, buyer)).status, 409)
  assert.deepEqual((await state()).workflows!.requests.filter(r => r.batchId === batchId), rows)
  const body = { idempotencyKey: crypto.randomUUID(), lines }
  const reviewed = (await ok(path, body, buyer)).workflows!.requests.filter(r => r.batchId === batchId)
  assert.deepEqual(reviewed.map(r => r.status), ['approved', 'approved', 'deferred'])
  assert.ok(reviewed.every(r => r.reviewedBy === buyer.id && r.version === 2))
  assert.deepEqual((await ok(path, body, buyer)).workflows!.requests.filter(r => r.batchId === batchId), reviewed)
  assert.equal((await call(path, { ...body, lines: [lines[0]] }, buyer)).status, 409)
  const held = reviewed[2], approved = reviewed.slice(0, 2)
  assert.equal((await call('/workflows/orders', { supplier: 'Supplier', reference: 'HELD', lines: [{ requestId: held.id, expectedVersion: held.version, unitCost: 1 }] }, buyer)).status, 400)
  const ordered = await ok('/workflows/orders', { supplier: 'Supplier', reference: 'BATCH-APPROVED', shipping: 1, lines: approved.map(r => ({ requestId: r.id, expectedVersion: r.version, unitCost: 2 })) }, buyer)
  const group = groupWorkRequests([held], ordered.workflows!.requests)
  assert.equal(group.length, 1); assert.equal(group[0].length, 3)
  assert.equal(group[0].filter(r => r.status === 'ordered').length, 2)
  const later = await approve(held.id, admin)
  assert.equal(later.batchId, batchId); assert.equal(later.reviewedBy, admin.id)
  const orderBody = { supplier: 'Supplier', reference: 'BATCH-LATER', lines: [{ requestId: later.id, expectedVersion: later.version, unitCost: 1 }] }
  assert.equal((await call('/workflows/orders', orderBody, buyer)).status, 403)
  const complete = await ok('/workflows/orders', orderBody, admin)
  assert.equal(groupWorkRequests(complete.workflows!.requests.filter(r => r.batchId === batchId)).length, 1)
  assert.equal(groupWorkRequests([other, ...group[0]]).length, 2, 'legacy requests remain separate')
})

test('deferred positions remain requested, editable and part of their original batch', async () => {
  const project = (await state()).projects.find(p => p.code === 'ELEC')!
  const before = await state()
  const result = await ok('/workflows/requests/batch', { projectId: project.id, lines: [{ itemId: item.id, quantity: 0.75 }, { itemName: 'Keep this position', quantity: 1 }] }, sw)
  const r = result.workflows!.requests.find(r => r.itemId === item.id && !before.workflows!.requests.some(old => old.id === r.id))!
  const held = (await ok(`/workflows/requests/${r.id}/review`, { expectedVersion: r.version, decision: 'defer', note: 'Next prototype' }, buyer)).workflows!.requests.find(row => row.id === r.id)!
  assert.equal(inventorySupply(await state(), project.id).get(item.id)!.requested, inventorySupply(before, project.id).get(item.id)!.requested + 0.75)
  const edit = { kind: 'purchase', projectId: project.id, itemId: item.id, quantity: 1.5, expectedVersion: held.version }
  assert.equal((await call(`/workflows/requests/${r.id}/edit`, { ...edit, projectId: '' }, sw)).status, 400)
  assert.equal((await call(`/workflows/requests/${r.id}/edit`, { ...edit, kind: 'stock', reason: 'Change type' }, sw)).status, 400)
  assert.equal((await call(`/workflows/requests/${r.id}/edit`, { ...edit, itemId: '', itemName: 'Keep this position' }, sw)).status, 400)
  const changed = (await ok(`/workflows/requests/${r.id}/edit`, edit, sw)).workflows!.requests.find(row => row.id === r.id)!
  assert.equal(changed.batchId, r.batchId); assert.equal(changed.status, 'pending'); assert.equal(changed.reviewedBy, undefined); assert.equal(changed.decisionNote, undefined)
  const deferred = (await ok(`/workflows/requests/${r.id}/review`, { expectedVersion: changed.version, decision: 'defer', note: 'Still waiting' }, buyer)).workflows!.requests.find(row => row.id === r.id)!
  assert.equal((await ok(`/workflows/requests/${r.id}/cancel`, { expectedVersion: deferred.version }, sw)).workflows!.requests.find(row => row.id === r.id)!.status, 'cancelled')
})

test('project parts can be requested together without prices or a justification, with safe retries', async () => {
  const before = await state(), project = before.projects.find(p => p.code === 'ELEC')!
  const body = { idempotencyKey: crypto.randomUUID(), projectId: project.id, lines: [{ itemId: item.id, quantity: 3 }, { itemName: 'Mat material', quantity: 1.25, unit: 'm²' }] }
  const result = await ok('/workflows/requests/batch', body, sw)
  const added = result.workflows!.requests.filter(r => !before.workflows!.requests.some(old => old.id === r.id))
  assert.equal(added.length, 2); assert.equal(new Set(added.map(r => r.batchId)).size, 1); assert.ok(added[0].batchId)
  for (const r of added) { assert.equal(r.projectId, project.id); assert.equal(r.requesterId, sw.id); assert.equal(r.reason, ''); assert.equal(r.estimatedUnitCost, undefined); assert.equal(r.status, 'pending'); assert.equal(r.kind, 'purchase') }
  assert.equal(added.find(r => r.itemName === 'Mat material')!.unit, 'm²')
  assert.equal(result.items.length, before.items.length, 'requesting a new item does not fabricate catalog stock')
  assert.equal(result.records.length, before.records.length)
  const retried = await ok('/workflows/requests/batch', body, sw)
  assert.equal(retried.workflows!.requests.length, result.workflows!.requests.length)
  assert.equal((await call('/workflows/requests/batch', { ...body, lines: [{ itemId: item.id, quantity: 99 }] }, sw)).status, 409)
  const general = await ok('/workflows/requests/batch', { lines: [{ itemName: 'General supplies', quantity: 1 }] }, sw)
  const request = general.workflows!.requests.find(r => r.itemName === 'General supplies')!
  assert.equal(request.projectId, undefined); assert.equal(request.unit, 'pcs')
  // The existing approval/order handoff accepts an unpriced batch line and records actual costs.
  const placed = await order(added.find(r => r.itemId === item.id)!.id)
  assert.equal(placed.lines[0].quantity, 3); assert.equal(placed.lines[0].projectId, project.id)
})

test('batch requests validate every part atomically and preserve permission and build boundaries', async () => {
  const before = await state()
  for (const lines of [[], [{ itemId: item.id, quantity: 1 }, { itemId: 'missing', quantity: 2 }], [{ itemId: item.id, quantity: 1 }, { itemId: item.id, quantity: 2 }], [{ itemId: item.id, quantity: 0 }], [{ itemName: 'Material', quantity: 1, supplierUrl: 'javascript:alert(1)' }], Array.from({ length: 101 }, (_, i) => ({ itemName: String(i), quantity: 1 }))]) {
    assert.ok((await call('/workflows/requests/batch', { lines }, sw)).status >= 400)
    assert.equal((await state()).workflows!.requests.length, before.workflows!.requests.length)
  }
  assert.equal((await call('/workflows/requests/batch', { lines: [{ itemId: item.id, quantity: 1 }] }, sessions.viewer)).status, 403)
  const product = (await ok('/workflows/products', { name: 'Batch boundary module', code: 'BATCH-BOUNDARY', revision: '1', parts: [{ itemId: item.id, quantity: 1 }] }, hw)).workflows!.products.find(p => p.code === 'BATCH-BOUNDARY')!
  const planned = (await ok('/workflows/builds', { productId: product.id, quantity: 1 }, hw)).workflows!.builds.find(b => b.productId === product.id)!
  assert.equal((await call('/workflows/requests/batch', { buildId: planned.id, lines: [{ itemName: 'Unrelated', quantity: 1 }] }, sw)).status, 400)
  assert.equal((await call('/workflows/requests/batch', { buildId: planned.id, projectId: before.projects[0].id, lines: [{ itemId: item.id, quantity: 1 }] }, sw)).status, 400)
})

test('project part suggestions include catalog families and historical parts without unrelated supplies', async () => {
  const current = await state(), project = current.projects.find(p => p.code === 'ELEC')!
  const material = (await ok('/items', { name: 'Mat material', sku: 'ELEC-MAT', unit: 'm²' })).items.find(i => i.sku === 'ELEC-MAT')!
  const byCategory = (await ok('/items', { name: 'Case', sku: 'CASE-TEST', category: 'Electronics', unit: 'pcs' })).items.find(i => i.sku === 'CASE-TEST')!
  const unrelated = (await ok('/items', { name: 'General solder', sku: 'GEN-SOLDER', unit: 'pcs' })).items.find(i => i.sku === 'GEN-SOLDER')!
  const ids = projectPartIds(await state(), project.id)
  assert.ok(ids.has(material.id)); assert.ok(ids.has(byCategory.id)); assert.ok(ids.has(item.id), 'previously requested part stays available')
  assert.ok(!ids.has(unrelated.id)); assert.equal(projectPartIds(await state()).size, 0)
})

test('project supply follows partial deliveries, reservations, consumption and returns without counting orders twice', async () => {
  const project = (await ok('/projects', { name: 'Supply pilot', code: 'SUPPLY' })).projects.find(p => p.code === 'SUPPLY')!
  const other = (await ok('/projects', { name: 'Other pilot', code: 'OTHER' })).projects.find(p => p.code === 'OTHER')!
  const material = (await ok('/items', { name: 'Supply mat', sku: 'SUPPLY-MAT', unit: 'm²' })).items.find(i => i.sku === 'SUPPLY-MAT')!
  const first = (await ok('/records', { itemId: material.id, locationId: room.id, quantity: 10, state: 'in_stock', condition: 'new' })).records.find(r => r.itemId === material.id)!
  await ok('/records', { itemId: material.id, locationId: shelf.id, quantity: 3, state: 'damaged', condition: 'damaged' })
  await ok(`/records/${first.id}/assignments`, { expectedVersion: first.version, projectId: project.id, userId: hw.id, quantity: 2 })
  let current = await state()
  await ok(`/records/${first.id}/assignments`, { expectedVersion: current.records.find(r => r.id === first.id)!.version, projectId: other.id, userId: hw.id, quantity: 3 })
  const pending = await purchase({ itemId: material.id, projectId: project.id, quantity: 4 })
  const approved = await purchase({ itemId: material.id, projectId: project.id, quantity: 1 }); await approve(approved.id)
  const toOrder = await purchase({ itemId: material.id, projectId: project.id, quantity: 8 }), placed = await order(toOrder.id)
  const external = await purchase({ itemId: material.id, projectId: other.id, quantity: 99 }); await order(external.id)
  await purchase({ itemId: material.id, quantity: 7 })
  await ok('/workflows/requests', { kind: 'stock', itemId: material.id, projectId: project.id, quantity: 1, reason: 'From existing stock' }, sw)
  current = await state()
  const summary = () => inventorySupply(current, project.id).get(material.id)!
  assert.deepEqual(summary(), { physical: 13, available: 5, assigned: 2, unavailable: 3, requested: 5, approved: 1, ordered: 8, locationIds: summary().locationIds })
  assert.deepEqual(new Set(summary().locationIds), new Set([room.id, shelf.id]))
  assert.equal(inventorySupply(current).get(material.id)!.requested, 7, 'general supplies exclude all project purchases')
  current = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines[0].id, quantity: 2, locationId: shelf.id }] }, receiver)
  assert.equal(summary().physical, 15); assert.equal(summary().assigned, 4); assert.equal(summary().available, 5)
  assert.equal(summary().ordered, 6); assert.equal(summary().requested, 5)
  const reservation = current.assignments.find(a => a.requestId === toOrder.id)!, received = current.records.find(r => r.id === reservation.recordId)!
  current = await ok(`/workflows/assignments/${reservation.id}/use`, { expectedVersion: received.version, quantity: 1.25 }, hw)
  assert.equal(summary().physical, 13.75); assert.equal(summary().assigned, 2.75, 'API remaining quantity must not have consumption subtracted again')
  const otherReservation = current.assignments.find(a => a.projectId === other.id)!
  current = await ok(`/workflows/assignments/${otherReservation.id}/return`, { expectedVersion: current.records.find(r => r.id === first.id)!.version })
  assert.equal(summary().available, 8); assert.equal(summary().assigned, 2.75)
  current = await ok(`/workflows/requests/${pending.id}/cancel`, { expectedVersion: pending.version }, hw)
  assert.equal(summary().requested, 1)
  const updated = current.workflows!.orders.find(o => o.id === placed.id)!
  current = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: updated.version, lines: [{ lineId: placed.lines[0].id, quantity: 6, locationId: shelf.id }] }, receiver)
  assert.equal(summary().ordered, 0); assert.equal(summary().requested, 1); assert.equal(summary().assigned, 8.75)
  assert.equal(summary().physical, 19.75); assert.equal(summary().unavailable, 3)
})

test('general supplies have no project; partial receipts and retries cannot duplicate stock or shipping', async () => {
  const request = await purchase(); assert.equal(request.projectId, undefined)
  const placed = await order(request.id, buyer, 2.01)
  const line = placed.lines[0]
  const before = await state()
  const body = { expectedVersion: placed.version, idempotencyKey: crypto.randomUUID(), lines: [{ lineId: line.id, quantity: 1, locationId: shelf.id }] }
  const first = await ok(`/workflows/orders/${placed.id}/receive`, body, receiver)
  const again = await ok(`/workflows/orders/${placed.id}/receive`, body, receiver)
  assert.equal(again.records.length, first.records.length); assert.equal(again.receipts.length, before.receipts.length + 1)
  const current = again.workflows!.orders.find(o => o.id === placed.id)!
  assert.equal(current.lines[0].receivedQuantity, 1)
  const added = again.records.find(r => r.id === current.lines[0].receipts[0].recordId)!
  assert.equal(added.locationId, shelf.id); assert.equal(added.unitCost, (10 + 2.01) / 4)
  assert.equal(again.workflows!.requests.find(r => r.id === request.id)!.status, 'ordered')
  assert.equal((await call(`/workflows/orders/${placed.id}/receive`, { ...body, lines: [{ ...body.lines[0], quantity: 2 }] }, receiver)).status, 409)
  assert.equal((await call(`/workflows/orders/${placed.id}/receive`, { expectedVersion: current.version, lines: [{ lineId: line.id, quantity: 4, locationId: room.id }] }, receiver)).status, 400)
  const done = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: current.version, lines: [{ lineId: line.id, quantity: 3, locationId: room.id }] }, receiver)
  assert.equal(done.workflows!.requests.find(r => r.id === request.id)!.status, 'fulfilled')
  assert.equal(done.workflows!.orders.find(o => o.id === placed.id)!.shipping, 2.01)
})

test('wrong and damaged packages remain unavailable and wrong items do not fulfill the order', async () => {
  const request = await purchase(), placed = await order(request.id)
  const wrong = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines[0].id, quantity: 2, locationId: shelf.id, condition: 'wrong_item' }] }, receiver)
  const o = wrong.workflows!.orders.find(o => o.id === placed.id)!
  assert.equal(o.lines[0].receivedQuantity, 0)
  const bad = wrong.records.find(r => r.id === o.lines[0].receipts[0].recordId)!
  assert.equal(availableStock(bad, wrong.assignments), 0); assert.equal(bad.unitCost, undefined)
  const damaged = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: o.version, lines: [{ lineId: o.lines[0].id, quantity: 1, locationId: shelf.id, condition: 'damaged' }] }, receiver)
  const updated = damaged.workflows!.orders.find(o => o.id === placed.id)!
  assert.equal(updated.lines[0].receivedQuantity, 1)
  const damagedRecord = damaged.records.find(r => r.id === updated.lines[0].receipts[1].recordId)!
  assert.equal(availableStock(damagedRecord, damaged.assignments), 0)
  assert.equal((await call('/workflows/move', { recordId: damagedRecord.id, expectedVersion: damagedRecord.version, quantity: 0.5, locationId: room.id }, receiver)).status, 400)
})

test('build snapshots, reservations, partial completion and outputs preserve quantities and costs', async () => {
  const material = await stock(10, 2)
  const project = (await state()).projects.find(p => p.code === 'ELEC')!
  const product = (await ok('/workflows/products', { name: 'Control module', code: 'MODULE', revision: 'A', parts: [{ itemId: item.id, quantity: 2, estimatedUnitCost: 2 }] }, hw)).workflows!.products[0]
  assert.notEqual(product.outputItemId, item.id)
  const planned = (await ok('/workflows/builds', { productId: product.id, quantity: 3, projectId: project.id }, hw)).workflows!.builds[0]
  await ok(`/workflows/products/${product.id}`, { expectedVersion: product.version, name: product.name, revision: 'B', parts: [{ itemId: item.id, quantity: 9 }] }, hw)
  assert.equal((await state()).workflows!.builds.find(b => b.id === planned.id)!.parts[0].quantity, 2)
  const before = await state()
  assert.equal((await call(`/workflows/builds/${planned.id}/complete`, { expectedVersion: planned.version, quantity: 1, locationId: shelf.id, recordVersions: { [material.id]: material.version } }, hw)).status, 400)
  assert.equal((await state()).records.length, before.records.length, 'failed build is atomic')
  const reserved = await ok(`/workflows/builds/${planned.id}/reserve`, { expectedVersion: planned.version, recordId: material.id, recordVersion: material.version, quantity: 6 }, hw)
  const b = reserved.workflows!.builds.find(b => b.id === planned.id)!
  const r = reserved.records.find(r => r.id === material.id)!
  assert.equal(availableStock(r, reserved.assignments), 4)
  assert.equal(buildRequirements(b, reserved)[0].reserved, 6)
  const completeBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: b.version, quantity: 1, locationId: shelf.id, recordVersions: { [material.id]: r.version } }
  const partial = await ok(`/workflows/builds/${b.id}/complete`, completeBody, hw)
  assert.equal(partial.records.find(r => r.id === material.id)!.quantity, 8)
  const reservation = partial.assignments.find(a => a.buildId === b.id)!
  assert.equal(reservation.quantity, 4); assert.equal(reservation.consumedQuantity, 2)
  const output = partial.records.find(r => r.itemId === product.outputItemId)!
  assert.equal(output.quantity, 1); assert.equal(output.unitCost, 4)
  const replay = await ok(`/workflows/builds/${b.id}/complete`, completeBody, hw)
  assert.equal(replay.workflows!.buildEvents.length, partial.workflows!.buildEvents.length)
  const currentBuild = partial.workflows!.builds.find(p => p.id === b.id)!
  const currentStock = partial.records.find(r => r.id === material.id)!
  const finished = await ok(`/workflows/builds/${b.id}/complete`, { expectedVersion: currentBuild.version, quantity: 2, locationId: shelf.id, recordVersions: { [material.id]: currentStock.version } }, hw)
  assert.equal(finished.records.find(r => r.id === material.id)!.quantity, 4)
  assert.equal(finished.assignments.find(a => a.id === reservation.id)!.quantity, 0)
  assert.equal(finished.workflows!.builds.find(p => p.id === b.id)!.completedQuantity, 3)
  assert.equal((await call('/items/' + item.id, undefined, admin, 'DELETE')).status, 409)
})

test('borrowed items remain in physical stock, consumables leave stock, and returns are revision protected', async () => {
  const material = await stock(7, 3)
  const request = (await ok('/workflows/requests', { kind: 'stock', usage: 'borrow', itemId: item.id, quantity: 2, reason: 'Bench experiment' }, sw)).workflows!.requests[0]
  assert.equal((await call(`/workflows/requests/${request.id}/fulfill`, { expectedVersion: request.version, lines: [{ recordId: material.id, expectedVersion: material.version, quantity: 2 }] }, sw)).status, 403)
  const borrowed = await ok(`/workflows/requests/${request.id}/fulfill`, { expectedVersion: request.version, lines: [{ recordId: material.id, expectedVersion: material.version, quantity: 2 }] }, receiver)
  const a = borrowed.assignments.find(a => a.userId === sw.id && a.recordId === material.id)!
  const updated = borrowed.records.find(r => r.id === material.id)!
  assert.equal(updated.quantity, 7); assert.equal(availableStock(updated, borrowed.assignments), 5)
  assert.equal((await call(`/workflows/assignments/${a.id}/return`, { expectedVersion: material.version }, sw)).status, 409)
  assert.equal((await call(`/workflows/assignments/${a.id}/return`, { expectedVersion: updated.version }, hw)).status, 403)
  const returned = await ok(`/workflows/assignments/${a.id}/return`, { expectedVersion: updated.version }, sw)
  assert.equal(availableStock(returned.records.find(r => r.id === material.id)!, returned.assignments), 7)
  const request2 = (await ok('/workflows/requests', { kind: 'stock', usage: 'consume', itemId: item.id, quantity: 2, reason: 'Install permanently' }, sw)).workflows!.requests[0]
  const used = await ok(`/workflows/requests/${request2.id}/fulfill`, { expectedVersion: request2.version, lines: [{ recordId: material.id, expectedVersion: returned.records.find(r => r.id === material.id)!.version, quantity: 2 }] }, receiver)
  assert.equal(used.records.find(r => r.id === material.id)!.quantity, 5)
  assert.equal(used.workflows!.requests.find(r => r.id === request2.id)!.materials![0].unitCost, 3)
})

test('stock handouts can be partial without losing quantities, custody, costs or stale-write protection', async () => {
  const project = (await state()).projects.find(p => p.code === 'ELEC')!, material = await stock(5, 2)
  const request = (await ok('/workflows/requests', { kind: 'stock', usage: 'consume', itemId: item.id, projectId: project.id, quantity: 4 }, sw)).workflows!.requests[0]
  const firstBody = { idempotencyKey: crypto.randomUUID(), expectedVersion: request.version, lines: [{ recordId: material.id, expectedVersion: material.version, quantity: 1.5 }] }
  const first = await ok(`/workflows/requests/${request.id}/fulfill`, firstBody, receiver), issued = first.workflows!.requests.find(r => r.id === request.id)!
  assert.equal(issued.status, 'pending'); assert.equal(stockRequestIssued(issued), 1.5); assert.equal(issued.quantity, 4)
  assert.equal(first.records.find(r => r.id === material.id)!.quantity, 3.5)
  const replay = await ok(`/workflows/requests/${request.id}/fulfill`, firstBody, receiver)
  assert.deepEqual(replay.workflows!.requests.find(r => r.id === request.id), issued)
  assert.equal((await call(`/workflows/requests/${request.id}/edit`, { expectedVersion: issued.version, kind: 'stock', itemId: item.id, quantity: 2, usage: 'borrow', projectId: project.id }, sw)).status, 400)
  assert.equal((await call(`/workflows/requests/${request.id}/fulfill`, { ...firstBody, idempotencyKey: crypto.randomUUID() }, sessions.buyer_receiver)).status, 409)
  let currentRecord = first.records.find(r => r.id === material.id)!
  assert.equal((await call(`/workflows/requests/${request.id}/fulfill`, { expectedVersion: issued.version, lines: [{ recordId: material.id, expectedVersion: currentRecord.version, quantity: 3 }] }, receiver)).status, 400)
  const done = await ok(`/workflows/requests/${request.id}/fulfill`, { expectedVersion: issued.version, lines: [{ recordId: material.id, expectedVersion: currentRecord.version, quantity: 2.5 }] }, sessions.buyer_receiver)
  const completed = done.workflows!.requests.find(r => r.id === request.id)!
  assert.equal(completed.status, 'fulfilled'); assert.equal(stockRequestIssued(completed), 4)
  assert.equal(completed.materials!.length, 2); assert.equal(completed.materials!.reduce((sum, part) => sum + part.quantity * part.unitCost!, 0), 8)
  assert.equal(stockRequestIssued({ ...completed, fulfilledQuantity: undefined }), 4, 'legacy completed stock requests still report their original quantity')
  currentRecord = done.records.find(r => r.id === material.id)!
  const loan = (await ok('/workflows/requests', { kind: 'stock', usage: 'borrow', itemId: item.id, quantity: 2, projectId: project.id }, sw)).workflows!.requests[0]
  const partlyBorrowed = await ok(`/workflows/requests/${loan.id}/fulfill`, { expectedVersion: loan.version, lines: [{ recordId: material.id, expectedVersion: currentRecord.version, quantity: 0.5 }] }, receiver)
  const partly = partlyBorrowed.workflows!.requests.find(r => r.id === loan.id)!, assignment = partlyBorrowed.assignments.find(a => a.requestId === loan.id)!
  assert.equal(assignment.projectId, project.id); assert.equal(assignment.userId, sw.id)
  assert.equal(partlyBorrowed.records.find(r => r.id === material.id)!.quantity, 1, 'loan remains in physical stock')
  const cancelled = await ok(`/workflows/requests/${loan.id}/cancel`, { expectedVersion: partly.version }, sw)
  assert.equal(stockRequestIssued(cancelled.workflows!.requests.find(r => r.id === loan.id)!), 0.5)
  assert.equal(cancelled.assignments.find(a => a.id === assignment.id)!.quantity, 0.5, 'withdrawing the remainder retains already-issued custody')
  const returned = await ok(`/workflows/assignments/${assignment.id}/return`, { expectedVersion: cancelled.records.find(r => r.id === material.id)!.version }, sw)
  assert.equal(availableStock(returned.records.find(r => r.id === material.id)!, returned.assignments), 1)
})

test('partial stock handouts roll back stale sources and preserve cumulative loans and reservations', async () => {
  const a = await stock(2, 1), b = await stock(2, 3)
  const request = (await ok('/workflows/requests', { kind: 'stock', usage: 'borrow', itemId: item.id, quantity: 4 }, sw)).workflows!.requests[0]
  const path = `/workflows/requests/${request.id}/fulfill`
  assert.equal((await call(path, { expectedVersion: request.version, lines: [{ recordId: a.id, expectedVersion: a.version, quantity: 1 }, { recordId: b.id, expectedVersion: 0, quantity: 1 }] }, receiver)).status, 409)
  const unchanged = await state()
  assert.equal(unchanged.records.find(r => r.id === a.id)!.version, a.version)
  assert.equal(unchanged.assignments.filter(a => a.requestId === request.id).length, 0)
  const first = await ok(path, { expectedVersion: request.version, lines: [{ recordId: a.id, expectedVersion: a.version, quantity: 2 }] }, receiver)
  const partial = first.workflows!.requests.find(r => r.id === request.id)!
  assert.equal(partial.status, 'pending'); assert.equal(partial.assignmentIds!.length, 1)
  const done = await ok(path, { expectedVersion: partial.version, lines: [{ recordId: b.id, expectedVersion: b.version, quantity: 2 }] }, sessions.buyer_receiver)
  const completed = done.workflows!.requests.find(r => r.id === request.id)!
  assert.equal(completed.assignmentIds!.length, 2); assert.equal(stockRequestIssued(completed), 4)
  const other = (await ok('/workflows/requests', { kind: 'stock', usage: 'consume', itemId: item.id, quantity: 1 }, hw)).workflows!.requests[0]
  assert.equal((await call(`/workflows/requests/${other.id}/fulfill`, { expectedVersion: other.version, lines: [{ recordId: a.id, expectedVersion: done.records.find(r => r.id === a.id)!.version, quantity: 1 }] }, receiver)).status, 400)
})

test('receiving for a build auto reserves usable parts, while general items remain free', async () => {
  const product = (await state()).workflows!.products[0]
  const b = (await ok('/workflows/builds', { productId: product.id, quantity: 1 }, hw)).workflows!.builds[0]
  const request = await purchase({ buildId: b.id, quantity: 9 })
  const placed = await order(request.id)
  const s = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines[0].id, quantity: 9, locationId: shelf.id }] }, receiver)
  const requirement = buildRequirements(s.workflows!.builds.find(build => build.id === b.id)!, s)[0]
  assert.equal(requirement.reserved, 9); assert.equal(requirement.toRequest, 0)
  assert.equal(s.assignments.find(a => a.buildId === b.id)!.userId, hw.id)
})

test('moving a partial unassigned quantity and the whole remainder retains reservations', async () => {
  const r = await stock(10)
  const assigned = await ok(`/records/${r.id}/assignments`, { userId: sw.id, quantity: 4, expectedVersion: r.version })
  const version = assigned.records.find(record => record.id === r.id)!.version
  assert.equal((await call('/workflows/move', { recordId: r.id, expectedVersion: version, quantity: 7, locationId: shelf.id }, receiver)).status, 400)
  const partial = await ok('/workflows/move', { recordId: r.id, expectedVersion: version, quantity: 6, locationId: shelf.id }, receiver)
  const remainder = partial.records.find(record => record.id === r.id)!
  assert.equal(remainder.quantity, 4); assert.equal(remainder.locationId, room.id)
  const moved = await ok('/workflows/move', { recordId: r.id, expectedVersion: remainder.version, quantity: 4, locationId: shelf.id }, receiver)
  assert.equal(moved.records.find(record => record.id === r.id)!.locationId, shelf.id)
  assert.equal(moved.assignments.find(a => a.recordId === r.id && !a.returnedAt)!.quantity, 4)
})

test('standalone project purchases reserve their arrivals and record actual use without a product build', async () => {
  const project = (await state()).projects.find(p => p.code === 'ELEC')!
  const request = await purchase({ projectId: project.id })
  const placed = await order(request.id)
  const received = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: placed.lines[0].id, quantity: 4, locationId: shelf.id }] }, receiver)
  const assignment = received.assignments.find(a => a.requestId === request.id)!
  assert.equal(assignment.projectId, project.id); assert.equal(assignment.quantity, 4)
  const r = received.records.find(r => r.id === assignment.recordId)!
  const body = { idempotencyKey: crypto.randomUUID(), expectedVersion: r.version, quantity: 2 }
  const used = await ok(`/workflows/assignments/${assignment.id}/use`, body, hw)
  assert.equal(used.assignments.find(a => a.id === assignment.id)!.quantity, 2)
  assert.equal(used.records.find(record => record.id === r.id)!.quantity, 2)
  assert.equal(used.workflows!.requests.find(r => r.id === request.id)!.materials![0].quantity, 2)
  const replay = await ok(`/workflows/assignments/${assignment.id}/use`, body, hw)
  assert.equal(replay.workflows!.requests.find(r => r.id === request.id)!.materials!.length, 1)
})

test('project material costs exclude a second consumption of the same built output', () => {
  const w = { products: [], builds: [], orders: [], requests: [
    { id: 'r', version: 1, createdAt: '', updatedAt: '', kind: 'stock' as const, status: 'fulfilled' as const, requesterId: '', itemName: '', quantity: 1, unit: 'pcs', reason: '', usage: 'consume' as const, projectId: 'p', materials: [{ recordId: 'output', quantity: 1, unitCost: 10 }] },
  ], buildEvents: [{ id: 'e', version: 1, createdAt: '', updatedAt: '', buildId: 'b', projectId: 'p', quantity: 1, outputRecordId: 'output', actorId: '', materials: [{ recordId: 'raw', itemId: 'i', quantity: 2, unitCost: 5 }] }] }
  assert.deepEqual(materialUsageCosts(w, [], 'p'), { known: 10, incomplete: false })
  assert.deepEqual(materialUsageCosts(w, [], null), { known: 10, incomplete: false })
  w.requests[0].projectId = 'other'
  assert.deepEqual(materialUsageCosts(w, [], 'other'), { known: 10, incomplete: false })
  assert.deepEqual(materialUsageCosts(w, [], null), { known: 10, incomplete: false })
})

test('shared shipping allocation is exact across projects and very small unit costs', () => {
  const values = orderLineCosts({ id: 'o', version: 1, createdAt: '', updatedAt: '', reference: '', supplier: '', orderedBy: '', currency: 'EUR', shipping: 5.03, lines: [1, 2, 3].map((id, i) => ({ id: String(id), requestId: String(id), itemName: 'Part', unit: 'pcs', quantity: 100, unitCost: 0.013 + i, receivedQuantity: 0, receipts: [] })) })
  assert.equal(Math.round(values.reduce((sum, v) => sum + v.shipping, 0) * 100), 503)
  assert.equal(Math.round(values.reduce((sum, v) => sum + v.total, 0) * 100), 30893)
  const record = { quantity: 1, state: 'in_stock', condition: 'new', quarantined: true } as InventoryRecord
  assert.equal(availableStock(record, []), 0)
})

test('DemoDevice set: six-component recipe, mixed project/general order, partial arrivals, builds and software loan reconcile', async () => {
  const stockManager = sessions.stock_manager
  const project = (await ok('/projects', { name: 'DemoDevice scenario', code: 'DEMO-SCENARIO' }, stockManager)).projects.find(p => p.code === 'DEMO-SCENARIO')!
  // These are synthetic test prices, not production catalog data.
  const definitions = [
    ['STRIPE', 'Sensorstripe scenario', 4, 3], ['IMU', 'External IMU scenario', 1, 8],
    ['IMU-CASE', 'IMU Case scenario', 1, 2], ['STM', 'STM PCB with onboard IMU scenario', 1, 12],
    ['STM-CASE', 'STM PCB Case scenario', 1, 3], ['IMU-STM', 'Separate IMU-to-STM RS485 cable scenario', 1, 4],
  ] as const
  const components = []
  for (const [code, name, quantity, estimatedUnitCost] of definitions) {
    const article = (await ok('/items', { name, sku: 'SCENARIO-' + code, unit: 'pcs', projectIds: [project.id] }, stockManager)).items.find(i => i.sku === 'SCENARIO-' + code)!
    components.push({ itemId: article.id, quantity, estimatedUnitCost })
  }
  const mat = (await ok('/items', { name: 'DemoDevice mat material scenario', sku: 'SCENARIO-MAT', unit: 'm²' }, stockManager)).items.find(i => i.sku === 'SCENARIO-MAT')!
  const usb = (await ok('/items', { name: 'USB C to RS485 connection cable scenario', sku: 'SCENARIO-USB', unit: 'pcs' }, stockManager)).items.find(i => i.sku === 'SCENARIO-USB')!
  const product = (await ok('/workflows/products', { name: 'Sensorstripeset (4 Stripes) with onboard IMU scenario', code: 'SCENARIO-SET', revision: '1', parts: components }, stockManager)).workflows!.products.find(p => p.code === 'SCENARIO-SET')!
  assert.equal(product.parts.length, 6)
  assert(!product.parts.some(p => p.itemId === mat.id || p.itemId === usb.id), 'No invented mat consumption or substituted USB cable in the recipe')
  const build = (await ok('/workflows/builds', { productId: product.id, projectId: project.id, quantity: 2 }, stockManager)).workflows!.builds[0]
  const batch = await ok('/workflows/requests/batch', { projectId: project.id, buildId: build.id, lines: components.map(p => ({ ...p, quantity: p.quantity * 2 })) }, stockManager)
  const requests = batch.workflows!.requests.filter(r => r.buildId === build.id)
  assert.equal(requests.length, 6); assert.equal(new Set(requests.map(r => r.batchId)).size, 1)
  assert.equal((await call(`/workflows/requests/${requests[0].id}/review`, { expectedVersion: requests[0].version, decision: 'approve' }, stockManager)).status, 403)
  const general = (await ok('/workflows/requests', { kind: 'purchase', itemId: mat.id, quantity: 2.5, estimatedUnitCost: 6, reason: 'General experimental mat stock' }, sw)).workflows!.requests[0]
  await ok(`/workflows/request-batches/${requests[0].batchId}/review`, { lines: requests.map(r => ({ requestId: r.id, expectedVersion: r.version, decision: 'approve' })) }, buyer)
  await approve(general.id)
  const reviewed = (await state()).workflows!.requests.filter(r => requests.some(old => old.id === r.id) || r.id === general.id)
  const orderBody = { supplier: 'Synthetic DEMO supplier', reference: 'DEMO-SCENARIO-ORDER', shipping: 7, lines: reviewed.map(r => ({ requestId: r.id, expectedVersion: r.version, unitCost: r.estimatedUnitCost })) }
  assert.equal((await call('/workflows/orders', orderBody, stockManager)).status, 403, 'High visibility does not grant purchasing permission')
  let current = await ok('/workflows/orders', orderBody, buyer)
  let placed = current.workflows!.orders.find(o => o.reference === 'DEMO-SCENARIO-ORDER')!
  const allocated = orderLineCosts(placed)
  assert.equal(Math.round(allocated.reduce((sum, c) => sum + c.total, 0) * 100), 10400, '97 EUR materials + 7 EUR shipping')
  const projectCost = allocated.filter(c => c.line.projectId === project.id).reduce((sum, c) => sum + c.total, 0)
  const stripeId = components[0].itemId, stripeLine = placed.lines.find(l => l.itemId === stripeId)!
  current = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: placed.lines.map(line => ({ lineId: line.id, quantity: line.itemId === stripeId ? 4 : line.quantity, locationId: shelf.id, condition: 'new' })) }, receiver)
  placed = current.workflows!.orders.find(o => o.id === placed.id)!
  assert.equal(placed.lines.find(l => l.id === stripeLine.id)!.receivedQuantity, 4)
  let activeBuild = current.workflows!.builds.find(b => b.id === build.id)!
  const requirements = buildRequirements(activeBuild, current)
  assert.equal(requirements.find(p => p.itemId === stripeId)!.reserved, 4)
  assert.equal(requirements.find(p => p.itemId === stripeId)!.ordered, 4)
  assert(requirements.every(p => p.toRequest === 0), 'The remaining delivery is not requested again')
  const generalStock = current.records.find(r => r.itemId === mat.id)!
  assert.equal(availableStock(generalStock, current.assignments), 2.5)
  assert.equal(inventorySupply(current, project.id).get(mat.id)!.assigned, 0)
  const complete = async (amount: number) => {
    const versions = Object.fromEntries(current.records.filter(r => components.some(p => p.itemId === r.itemId)).map(r => [r.id, r.version]))
    current = await ok(`/workflows/builds/${build.id}/complete`, { expectedVersion: activeBuild.version, quantity: amount, locationId: shelf.id, recordVersions: versions }, stockManager)
    activeBuild = current.workflows!.builds.find(b => b.id === build.id)!
  }
  await complete(1)
  assert.equal(activeBuild.completedQuantity, 1)
  current = await ok(`/workflows/orders/${placed.id}/receive`, { expectedVersion: placed.version, lines: [{ lineId: stripeLine.id, quantity: 4, locationId: shelf.id, condition: 'new' }] }, receiver)
  activeBuild = current.workflows!.builds.find(b => b.id === build.id)!
  await complete(1)
  assert.equal(activeBuild.completedQuantity, 2)
  const output = current.records.filter(r => r.itemId === product.outputItemId)
  assert.equal(output.reduce((sum, r) => sum + r.quantity, 0), 2)
  assert(Math.abs(output.reduce((sum, r) => sum + r.quantity * r.unitCost!, 0) - projectCost) < 1e-6)
  assert(Math.abs(materialUsageCosts(current.workflows!, current.records, project.id).known - projectCost) < 1e-6)
  assert.equal(current.records.find(r => r.id === generalStock.id)!.quantity, 2.5, 'General mat stock remains separate')
  assert(components.every(part => current.records.filter(r => r.itemId === part.itemId).reduce((sum, r) => sum + r.quantity, 0) === 0))
  const loan = (await ok('/workflows/requests', { kind: 'stock', itemId: product.outputItemId, projectId: project.id, quantity: 1, usage: 'borrow', reason: 'Software verification' }, sw)).workflows!.requests[0]
  current = await ok(`/workflows/requests/${loan.id}/fulfill`, { expectedVersion: loan.version, lines: [{ recordId: output[0].id, expectedVersion: output[0].version, quantity: 1 }] }, receiver)
  const assignment = current.assignments.find(a => a.requestId === loan.id)!
  assert.equal(assignment.userId, sw.id); assert.equal(assignment.projectId, project.id)
  assert.equal(current.records.filter(r => r.itemId === product.outputItemId).reduce((sum, r) => sum + r.quantity, 0), 2, 'Loan retains physical stock')
  current = await ok(`/workflows/assignments/${assignment.id}/return`, { expectedVersion: current.records.find(r => r.id === output[0].id)!.version }, sw)
  assert.equal(inventorySupply(current, project.id).get(product.outputItemId)!.available, 2)
  assert(Math.abs(materialUsageCosts(current.workflows!, current.records, project.id).known - projectCost) < 1e-6, 'Borrowing does not charge materials again')
})

