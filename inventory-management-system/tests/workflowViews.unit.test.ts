import assert from 'node:assert/strict'
import test from 'node:test'
import type { InventoryStatePayload } from '../shared/inventory.ts'
import { matchingProcurement, orderDraftTotals, requestNeedsAction, selectRequestGroups } from '../shared/workflowViews.ts'
import { euroPrice } from '../shared/catalog.ts'
import { emptyWorkflows, orderLineCosts, type InventoryPurchaseOrder, type InventoryWorkRequest } from '../shared/workflows.ts'

const request = (id: string, fields: Partial<InventoryWorkRequest> = {}): InventoryWorkRequest => ({ id, version: 1, createdAt: '', updatedAt: '', kind: 'purchase', status: 'pending', requesterId: 'developer', itemId: 'pcb', itemName: 'Controller board', quantity: 2, unit: 'pcs', usage: 'consume', reason: '', ...fields })
function fixture() {
  return {
    currentUser: { id: 'developer' }, permissions: ['request_stock'],
    users: [{ id: 'developer', name: 'Developer Example' }, { id: 'administrator', name: 'Administrator Example' }, { id: 'buyer', name: 'Buyer Example' }],
    projects: [{ id: 'demo', name: 'DemoDevice', code: 'DEMO' }, { id: 'demo-storage', name: 'DemoStorage', code: 'CE' }],
    items: [{ id: 'pcb', name: 'Controller board', sku: 'DEMO-PCB', manufacturerPartNumber: 'ESP-32' }],
    workflows: { ...emptyWorkflows, requests: [
      request('a', { batchId: 'batch-demo', projectId: 'demo', supplier: 'Example Supplier', status: 'approved', reviewedBy: 'administrator' }),
      request('b', { batchId: 'batch-demo', projectId: 'demo', itemName: 'Sensorstripe', itemId: undefined, status: 'deferred', decisionNote: 'Confirm size' }),
      request('c', { projectId: 'demo-storage', requesterId: 'buyer' }),
      request('general', { itemName: 'Lab supplies' }),
      request('changes', { status: 'changes_requested' }),
      request('stock', { kind: 'stock', usage: 'borrow' }),
      request('done', { status: 'fulfilled', projectId: 'demo' }),
      request('cancelled', { status: 'cancelled' }),
    ] },
  } as InventoryStatePayload
}
const ids = (groups: InventoryWorkRequest[][]) => groups.flat().map(r => r.id)

test('request filters keep reviewed siblings, isolate projects and distinguish general supplies', () => {
  const state = fixture()
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'approved', project: { kind: 'project', id: 'demo' } })), ['a', 'b'])
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'deferred' })), ['a', 'b'])
  assert.deepEqual(ids(selectRequestGroups(state, { project: { kind: 'project', id: '' } })), ['general', 'changes', 'stock'])
  assert.deepEqual(ids(selectRequestGroups(state, { project: { kind: 'project', id: 'demo-storage' } })), ['c'])
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'closed' })), ['done', 'cancelled'])
  assert(!ids(selectRequestGroups(state, { view: 'mine' })).includes('c'))
})

test('request search finds codes, people, suppliers and terms across grouped positions', () => {
  const state = fixture()
  for (const query of ['DEMO PCB Example Supplier', 'Administrator Example', 'Sensorstripe Controller', 'ANF-BATCH-DE', 'Confirm size', 'ESP32']) {
    const results = selectRequestGroups(state, { query })
    if (query === 'ESP32') assert.equal(results.length, 0, 'Do not invent fuzzy part-number matches')
    else assert.deepEqual(ids(results), ['a', 'b'], query)
  }
  assert.deepEqual(ids(selectRequestGroups(state, { query: 'buyer CE' })), ['c'])
  assert.equal(selectRequestGroups(state, { query: 'unrelated-never-matches' }).length, 0)
})

test('action queue follows actual requester, approver and handout permissions', () => {
  const state = fixture()
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'action' })), ['changes'])
  state.currentUser.id = 'administrator'; state.permissions = ['order_stock', 'request_stock']
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'action' })), ['a', 'b', 'c', 'general'])
  assert.equal(requestNeedsAction(state.workflows!.requests[0], { ...state, currentUser: { ...state.currentUser, id: 'buyer' } }), false)
  state.currentUser.id = 'receiver'; state.permissions = ['fulfill_requests', 'receive_stock']
  assert.deepEqual(ids(selectRequestGroups(state, { view: 'action' })), ['stock'])
  state.permissions = ['read_inventory']
  assert.equal(selectRequestGroups(state, { view: 'action' }).length, 0)
})

test('order preview matches saved line-cent rounding and keeps unknown prices visibly incomplete', () => {
  const requests = [request('a', { quantity: 3, estimatedUnitCost: 0.333333 }), request('b', { quantity: 2.5 })]
  const incomplete = orderDraftTotals(requests, {}, '1,25'); assert.equal(incomplete.missingPrices, 1); assert.equal(incomplete.total, undefined); assert.equal(incomplete.materials, 1)
  const totals = orderDraftTotals(requests, { b: '2,50' }, '1,25'); assert.equal(totals.materials, 7.25); assert.equal(totals.total, 8.5); assert.deepEqual(totals.overLimit, [])
  const order = { shipping: 1.25, lines: totals.lines.map(({ request, unitCost }) => ({ ...request, unitCost })) } as unknown as InventoryPurchaseOrder
  assert.equal(orderLineCosts(order).reduce((sum, line) => sum + line.total, 0), totals.total)
  assert.deepEqual(orderDraftTotals(requests, { a: '0,333334', b: '2' }, '0').overLimit, ['a'])
  assert.equal(orderDraftTotals(requests, { b: '2€' }, '0').total, undefined)
  assert.equal(orderDraftTotals(requests, { b: '2' }, '0,123').total, undefined)
  assert.equal(orderDraftTotals(requests, { b: '2' }, '').total, undefined)
  assert.throws(() => euroPrice('0.000001'), 'Catalog default precision remains four decimals')
  assert.equal(euroPrice('0,000001', { decimalPlaces: 6 }), 0.000001)
})

test('procurement hints match exact article identity or new-part name/link within the selected project', () => {
  const requests = [
    request('catalog', { projectId: 'demo', supplierUrl: 'https://supplier.test/part?v=1' }),
    request('draft', { itemId: undefined, itemName: 'External IMU', projectId: 'demo', supplierUrl: 'https://supplier.test/part?v=2#specs' }),
    request('other-project', { projectId: 'demo-storage' }), request('general'),
    request('stock', { kind: 'stock', projectId: 'demo' }), request('closed', { status: 'cancelled', projectId: 'demo' }), request('done', { status: 'fulfilled', projectId: 'demo' }),
  ]
  const ids = (options: Parameters<typeof matchingProcurement>[1]) => matchingProcurement(requests, options).map(r => r.id)
  assert.deepEqual(ids({ projectId: 'demo', itemId: 'pcb', itemName: 'External IMU' }), ['catalog'], 'Catalog identity wins over similar names')
  assert.deepEqual(ids({ projectId: 'demo', itemName: ' external   IMU ' }), ['draft'])
  assert.deepEqual(ids({ projectId: 'demo', supplierUrl: 'https://SUPPLIER.test/part?v=2#order' }), ['draft'])
  assert.deepEqual(ids({ projectId: 'demo', supplierUrl: 'https://supplier.test/part?v=3' }), [], 'Query variants stay distinct')
  assert.deepEqual(ids({ itemId: 'pcb' }), ['general'])
  assert.deepEqual(ids({ projectId: 'demo', itemId: 'pcb', excludeId: 'catalog' }), [])
  assert.deepEqual(ids({ projectId: 'demo' }), [])
  assert.deepEqual(ids({ projectId: 'demo', itemName: 'external' }), [], 'Do not suggest loose name substrings as duplicates')
})
