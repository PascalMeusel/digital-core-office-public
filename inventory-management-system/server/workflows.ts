import { catalogUnit, catalogLink } from '../shared/catalog.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response, Router } from 'express'
import type { InventoryAssignment, InventoryItemDefinition, InventoryLocation, InventoryPermission, InventoryProject, InventoryRecord, InventoryRecordEvent, InventoryUser } from '../shared/inventory.ts'
import { availableStock, buildRequirements, orderLineCosts, roundQuantity, stockRequestIssued, usableStock, type InventoryBuild, type InventoryBuildEvent, type InventoryProduct, type InventoryPurchaseOrder, type InventoryWorkflowState, type InventoryWorkRequest, type WorkflowDocument } from '../shared/workflows.ts'

const tables = { products: 'inventory_workflow_products', builds: 'inventory_workflow_builds', requests: 'inventory_workflow_requests', orders: 'inventory_workflow_orders', buildEvents: 'inventory_workflow_build_events' } as const
type Collection = keyof typeof tables
type Body = Record<string, unknown>
interface Host {
  connection(): DatabaseSync
  requirePermission(request: Request, response: Response, permission: InventoryPermission): InventoryUser | undefined
  handleRoute(response: Response, action: () => void): void
  sendUpdatedState(request: Request, response: Response, actor: InventoryUser, status?: number): void
  transaction<T>(database: DatabaseSync, action: () => T): T
  itemById(id: string): InventoryItemDefinition | undefined
  recordById(id: string): InventoryRecord | undefined
  locationById(id: string): InventoryLocation | undefined
  readProjects(): InventoryProject[]
  readRecords(): InventoryRecord[]
  readAssignments(): InventoryAssignment[]
  insertItem(db: DatabaseSync, item: InventoryItemDefinition): void
  insertRecord(db: DatabaseSync, record: InventoryRecord): void
  updateRecord(db: DatabaseSync, record: InventoryRecord): void
  insertAssignment(db: DatabaseSync, assignment: InventoryAssignment): void
  auditRecordChange(db: DatabaseSync, actor: InventoryUser, type: InventoryRecordEvent['eventType'], record: InventoryRecord, before?: InventoryRecord, reason?: string, receiptLineId?: string): string
  logActivity(db: DatabaseSync, actor: InventoryUser, action: string, details: Record<string, unknown>, itemId?: string, recordId?: string): void
}
export function ensureWorkflowSchema(db: DatabaseSync) {
  for (const table of Object.values(tables)) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`)
  const columns = db.prepare('PRAGMA table_info(inventory_assignments)').all()
  if (!columns.some(column => column.name === 'buildId')) db.exec('ALTER TABLE inventory_assignments ADD COLUMN buildId TEXT')
  if (!columns.some(column => column.name === 'requestId')) db.exec('ALTER TABLE inventory_assignments ADD COLUMN requestId TEXT')
  if (!columns.some(column => column.name === 'consumedQuantity')) db.exec('ALTER TABLE inventory_assignments ADD COLUMN consumedQuantity REAL NOT NULL DEFAULT 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_inventory_assignments_build ON inventory_assignments(buildId)')
  db.exec('CREATE TABLE IF NOT EXISTS inventory_workflow_operations (actorId TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(actorId,key))')
}
export function readWorkflowState(db: DatabaseSync): InventoryWorkflowState {
  return Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(row => JSON.parse(String(row.data)))])) as unknown as InventoryWorkflowState
}
export function workflowUsesItem(db: DatabaseSync, itemId: string) {
  const state = readWorkflowState(db)
  return state.products.some(p => p.outputItemId === itemId || p.parts.some(part => part.itemId === itemId)) || state.builds.some(b => b.outputItemId === itemId || b.parts.some(part => part.itemId === itemId)) || state.requests.some(r => r.itemId === itemId)
}
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }) }
function str(value: unknown, max = 200) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function required(value: unknown, label: string, max = 200) { const result = str(value, max); if (!result) fail(`Enter ${label}.`); return result }
function number(value: unknown, label: string, zero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > 1e9 || (zero ? value < 0 : value <= 0)) fail(`Enter a valid ${label}.`)
  const rounded = roundQuantity(value)
  if (!zero && rounded <= 0) fail(`Enter a valid ${label}.`)
  return rounded
}
function money(value: unknown, label: string) { const result = number(value, label, true); if (result > 1e7) fail(`${label} is too large.`); return Math.round(result * 100) / 100 }
function document(): WorkflowDocument { const now = new Date().toISOString(); return { id: randomUUID(), version: 1, createdAt: now, updatedAt: now } }
function revision(expected: unknown, existing: { version: number }) { if (expected !== existing.version) fail('This information changed. Close this form, refresh, and reopen it to review the current values.', 409) }
function get<T extends WorkflowDocument>(db: DatabaseSync, collection: Collection, id: string): T {
  const row = db.prepare(`SELECT data FROM ${tables[collection]} WHERE id = ?`).get(id)
  if (!row) fail('This workflow entry no longer exists.', 404)
  return JSON.parse(String(row.data)) as T
}
function save<T extends WorkflowDocument>(db: DatabaseSync, collection: Collection, value: T, existing?: WorkflowDocument) {
  if (existing) {
    value.version = existing.version + 1
    value.updatedAt = new Date().toISOString()
    const result = db.prepare(`UPDATE ${tables[collection]} SET data = ? WHERE id = ? AND json_extract(data, '$.version') = ?`).run(JSON.stringify(value), value.id, existing.version)
    if (result.changes !== 1) fail('This workflow entry changed. Refresh and try again.', 409)
  } else db.prepare(`INSERT INTO ${tables[collection]} (id,data) VALUES (?,?)`).run(value.id, JSON.stringify(value))
}

export function registerInventoryWorkflows(router: Router, h: Host) {
  function route(path: string, permission: InventoryPermission, action: (db: DatabaseSync, actor: InventoryUser, body: Body, id: string) => void) {
    router.post(`/workflows${path}`, (req, res) => h.handleRoute(res, () => {
      const actor = h.requirePermission(req, res, permission)
      if (!actor) return
      const db = h.connection()
      const body = (req.body ?? {}) as Body
      h.transaction(db, () => {
        // Every UI mutation has a stable key: retrying a saved form cannot repeat stock or spending.
        const key = str(body.idempotencyKey, 160)
        const hash = createHash('sha256').update(req.path + JSON.stringify(body)).digest('hex')
        if (key) {
          const previous = db.prepare('SELECT hash FROM inventory_workflow_operations WHERE actorId = ? AND key = ?').get(actor.id, key)
          if (previous) { if (previous.hash !== hash) fail('This submission key was already used for different values.', 409); return }
        }
        action(db, actor, body, String((req.params as Record<string, string>).id ?? ''))
        if (key) db.prepare('INSERT INTO inventory_workflow_operations VALUES (?,?,?,?)').run(actor.id, key, hash, new Date().toISOString())
      })
      h.sendUpdatedState(req, res, actor)
    }))
  }
  function projectId(value: unknown) {
    const id = str(value)
    if (id && !h.readProjects().some(project => project.id === id && project.active)) fail('Choose an active project or general supplies.')
    return id || undefined
  }
  function item(id: unknown) { const value = h.itemById(required(id, 'an item')); if (!value?.active) fail('Choose an active item.'); return value }
  function place(id: unknown) { const value = h.locationById(required(id, 'a storage place')); if (!value?.active) fail('Choose an active storage place.'); return value }
  function record(id: unknown, expected: unknown) { const value = h.recordById(required(id, 'a stock record')); if (!value) fail('Stock record not found.'); revision(expected, value); return value }
  function newItem(db: DatabaseSync, name: string, unit: string, category = 'Components', details: Partial<InventoryItemDefinition> = {}): InventoryItemDefinition {
    const value = { ...details, ...document(), name, sku: '', category, unit, minQuantity: 0, reorderQuantity: 0, active: true }
    h.insertItem(db, value)
    return value
  }
  function newRecord(db: DatabaseSync, actor: InventoryUser, itemId: string, locationId: string, quantity: number, fields: Partial<InventoryRecord> = {}, reason = 'Stock received') {
    const value: InventoryRecord = { ...document(), itemId, locationId, quantity, state: 'in_stock', condition: 'new', quarantined: false, receivedBy: actor.id, stockedAt: new Date().toISOString(), ...fields }
    h.insertRecord(db, value)
    h.auditRecordChange(db, actor, 'created', value, undefined, reason)
    return value
  }
  function changeRecord(db: DatabaseSync, actor: InventoryUser, existing: InventoryRecord, fields: Partial<InventoryRecord>, reason: string) {
    const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() }
    h.updateRecord(db, updated)
    h.auditRecordChange(db, actor, 'changed', updated, existing, reason)
    return updated
  }
  function reserve(db: DatabaseSync, actor: InventoryUser, stock: InventoryRecord, quantity: number, options: { userId?: string; projectId?: string; buildId?: string; requestId?: string; notes?: string }) {
    if (quantity > availableStock(stock, h.readAssignments())) fail('There is not enough available stock at this place.')
    const assignment: InventoryAssignment = { ...document(), recordId: stock.id, userId: options.userId ?? actor.id, quantity, assignedAt: new Date().toISOString(), ...options }
    h.insertAssignment(db, assignment)
    changeRecord(db, actor, stock, {}, 'Stock reserved')
    return assignment
  }
  function build(db: DatabaseSync, id: string, expected?: unknown) {
    const value = get<InventoryBuild>(db, 'builds', id)
    if (expected !== undefined) revision(expected, value)
    if (value.cancelled || value.completedQuantity >= value.quantity) fail('This build is already closed.')
    if (value.projectId) projectId(value.projectId)
    return value
  }
  function parts(body: Body, outputItemId?: string) {
    if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 200) fail('Add between 1 and 200 parts.')
    const seen = new Set<string>()
    return (body.parts as Body[]).map(part => {
      const selected = item(part.itemId)
      if (selected.id === outputItemId || seen.has(selected.id)) fail('Each part must appear once, and cannot be the product itself.')
      seen.add(selected.id)
      return { itemId: selected.id, quantity: number(part.quantity, 'quantity per product'), ...(part.estimatedUnitCost === undefined ? {} : { estimatedUnitCost: number(part.estimatedUnitCost, 'estimated unit price', true) }) }
    })
  }
  route('/products', 'manage_products', (db, actor, body) => {
    const name = required(body.name, 'a product name')
    const code = required(body.code, 'a product code', 80)
    if (readWorkflowState(db).products.some(p => p.code.toLowerCase() === code.toLowerCase())) fail('This product code is already used.')
    const product: InventoryProduct = { ...document(), name, code, revision: str(body.revision, 80) || '1', description: str(body.description, 2000), outputItemId: newItem(db, name, 'pcs', 'Built products').id, parts: parts(body), active: true }
    save(db, 'products', product)
    h.logActivity(db, actor, 'product_created', { productId: product.id, name })
  })
  route('/products/:id', 'manage_products', (db, actor, body, id) => {
    const old = get<InventoryProduct>(db, 'products', id); revision(body.expectedVersion, old)
    const updated = { ...old, name: required(body.name, 'a product name'), revision: required(body.revision, 'a revision', 80), description: str(body.description, 2000), parts: parts(body, old.outputItemId), active: body.active !== false }
    save(db, 'products', updated, old)
    db.prepare('UPDATE inventory_items SET name = ?, updatedAt = ? WHERE id = ?').run(updated.name, updated.updatedAt, old.outputItemId)
    h.logActivity(db, actor, 'product_updated', { productId: id, revision: updated.revision })
  })
  route('/builds', 'plan_builds', (db, actor, body) => {
    const product = get<InventoryProduct>(db, 'products', required(body.productId, 'a product'))
    if (!product.active) fail('This product is archived.')
    const quantity = number(body.quantity, 'build quantity')
    if (!Number.isSafeInteger(quantity)) fail('Build a whole number of products.')
    const value: InventoryBuild = { ...document(), productId: product.id, productName: product.name, productRevision: product.revision, outputItemId: product.outputItemId, projectId: projectId(body.projectId), name: str(body.name) || product.name, quantity, completedQuantity: 0, parts: product.parts, createdBy: actor.id, cancelled: false }
    save(db, 'builds', value)
    h.logActivity(db, actor, 'build_planned', { buildId: value.id, quantity, projectId: value.projectId })
  })
  route('/builds/:id/reserve', 'plan_builds', (db, actor, body, id) => {
    const planned = build(db, id, body.expectedVersion)
    const stock = record(body.recordId, body.recordVersion)
    const requirement = buildRequirements(planned, { records: h.readRecords(), assignments: h.readAssignments(), workflows: readWorkflowState(db) }).find(part => part.itemId === stock.itemId)
    const quantity = number(body.quantity, 'reserved quantity')
    if (!requirement || quantity > roundQuantity(requirement.needed - requirement.reserved)) fail('Reserve only the parts still needed for this build.')
    reserve(db, actor, stock, quantity, { buildId: id, projectId: planned.projectId, notes: planned.name })
    save(db, 'builds', { ...planned }, planned)
  })
  route('/builds/:id/cancel', 'plan_builds', (db, actor, body, id) => {
    const planned = build(db, id, body.expectedVersion)
    if (readWorkflowState(db).requests.some(r => r.buildId === id && !['cancelled', 'fulfilled'].includes(r.status))) fail('Close this build’s open requests and deliveries first.')
    const active = h.readAssignments().filter(a => a.buildId === id && !a.returnedAt && a.quantity > 0)
    for (const assignment of active) {
      db.prepare('UPDATE inventory_assignments SET returnedAt = ?, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), assignment.id)
      const stock = h.recordById(assignment.recordId)!
      changeRecord(db, actor, stock, {}, 'Build cancelled; unused reservation released')
    }
    save(db, 'builds', { ...planned, cancelled: true }, planned)
    h.logActivity(db, actor, 'build_cancelled', { buildId: id })
  })
  route('/builds/:id/complete', 'plan_builds', (db, actor, body, id) => {
    const planned = build(db, id, body.expectedVersion)
    const quantity = number(body.quantity, 'completed quantity')
    if (!Number.isSafeInteger(quantity) || quantity > planned.quantity - planned.completedQuantity) fail('Complete only the remaining whole products.')
    const location = place(body.locationId)
    const versions = (body.recordVersions ?? {}) as Record<string, unknown>
    const materials: InventoryBuildEvent['materials'] = []
    for (const part of planned.parts) {
      let remaining = roundQuantity(part.quantity * quantity)
      const assignments = h.readAssignments().filter(a => a.buildId === id && !a.returnedAt && a.quantity > 0 && h.recordById(a.recordId)?.itemId === part.itemId)
      for (const assignment of assignments) {
        if (remaining <= 0) break
        const stock = record(assignment.recordId, versions[assignment.recordId])
        if (!usableStock(stock)) continue
        const used = Math.min(remaining, assignment.quantity)
        db.prepare('UPDATE inventory_assignments SET consumedQuantity = consumedQuantity + ?, updatedAt = ? WHERE id = ?').run(used, new Date().toISOString(), assignment.id)
        const updated = changeRecord(db, actor, stock, { quantity: roundQuantity(stock.quantity - used) }, `Used for build ${planned.name}`)
        versions[stock.id] = updated.version
        materials.push({ recordId: stock.id, itemId: part.itemId, quantity: used, unitCost: stock.unitCost })
        remaining = roundQuantity(remaining - used)
      }
      if (remaining > 0) fail('Reserve enough usable parts before completing this build.')
    }
    const cost = materials.every(m => m.unitCost !== undefined) ? materials.reduce((sum, m) => sum + m.quantity * m.unitCost!, 0) / quantity : undefined
    const output = newRecord(db, actor, planned.outputItemId, location.id, quantity, { unitCost: cost, label: planned.name }, `Built from reserved parts: ${planned.name}`)
    const event: InventoryBuildEvent = { ...document(), buildId: id, projectId: planned.projectId, quantity, outputRecordId: output.id, actorId: actor.id, materials }
    save(db, 'buildEvents', event)
    save(db, 'builds', { ...planned, completedQuantity: planned.completedQuantity + quantity }, planned)
    h.logActivity(db, actor, 'build_completed', { buildId: id, quantity, outputRecordId: output.id })
  })

  function requestInput(db: DatabaseSync, body: Body) {
    const kind = body.kind === 'stock' ? 'stock' : 'purchase'
    const selected = str(body.itemId) ? item(body.itemId) : undefined
    if (kind === 'stock' && !selected) fail('Choose an item already in the catalog.')
    const linkedBuild = str(body.buildId) ? build(db, str(body.buildId)) : undefined
    if (linkedBuild && kind !== 'purchase') fail('Reserve existing parts directly from the build overview.')
    if (linkedBuild && (!selected || !linkedBuild.parts.some(p => p.itemId === selected.id))) fail('Choose a part used by this build.')
    const project = projectId(body.projectId)
    if (linkedBuild && linkedBuild.projectId !== project) fail('The request must use the build’s project.')
    const quantity = number(body.quantity, 'request quantity')
    const supplierUrl = catalogLink(body.supplierUrl ?? selected?.supplierUrl)
    if (supplierUrl) { try { if (!['https:', 'http:'].includes(new URL(supplierUrl).protocol)) fail('Use an http or https supplier URL.') } catch { fail('Enter a valid supplier URL.') } }
    return { kind, itemId: selected?.id, itemName: selected?.name ?? required(body.itemName, 'an item name'), unit: selected?.unit ?? catalogUnit(body.unit), quantity, projectId: project, buildId: linkedBuild?.id, reason: str(body.reason, 2000), supplier: str(body.supplier), supplierUrl, usage: body.usage === 'borrow' ? 'borrow' : 'consume', estimatedUnitCost: body.estimatedUnitCost === undefined ? undefined : number(body.estimatedUnitCost, 'estimated price', true), estimatedShipping: body.estimatedShipping === undefined ? undefined : money(body.estimatedShipping, 'estimated shipping') } as const
  }
  route('/requests', 'request_stock', (db, actor, body) => {
    const value: InventoryWorkRequest = { ...document(), ...requestInput(db, body), requesterId: actor.id, status: 'pending' }
    save(db, 'requests', value)
    h.logActivity(db, actor, 'request_submitted', { requestId: value.id, kind: value.kind, quantity: value.quantity })
  })
  route('/requests/batch', 'request_stock', (db, actor, body) => {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Choose between 1 and 100 parts and enter their quantities.')
    const batchId = randomUUID(), seen = new Set<string>()
    const requests = (body.lines as Body[]).map(line => {
      const input = requestInput(db, { ...line, kind: 'purchase', usage: 'consume', projectId: body.projectId, buildId: body.buildId, reason: body.reason, supplier: body.supplier ?? line?.supplier })
      const key = input.itemId ?? input.itemName.toLowerCase()
      if (seen.has(key)) fail('Enter each part once and combine its quantities.')
      seen.add(key)
      return { ...document(), ...input, batchId, requesterId: actor.id, status: 'pending' } satisfies InventoryWorkRequest
    })
    for (const request of requests) {
      save(db, 'requests', request)
      h.logActivity(db, actor, 'request_submitted', { requestId: request.id, batchId, kind: request.kind, quantity: request.quantity, projectId: request.projectId })
    }
  })
  route('/requests/:id/edit', 'request_stock', (db, actor, body, id) => {
    const old = get<InventoryWorkRequest>(db, 'requests', id); revision(body.expectedVersion, old)
    if (old.requesterId !== actor.id || !['pending', 'deferred', 'changes_requested'].includes(old.status)) fail('Only the requester can edit a request awaiting approval.', 403)
    if (stockRequestIssued(old) > 0) fail('This request has already been partly handed out. Withdraw its remainder and create a new request to change it.')
    const input = requestInput(db, body)
    if (old.batchId) {
      if (input.kind !== old.kind || input.projectId !== old.projectId || input.buildId !== old.buildId) fail('Keep this position in its original purchase request and project.')
      if (readWorkflowState(db).requests.some(r => r.batchId === old.batchId && r.id !== old.id && r.status !== 'cancelled' && (input.itemId ? r.itemId === input.itemId : !r.itemId && r.itemName.toLowerCase() === input.itemName.toLowerCase()))) fail('This part already has a position in this request.')
    }
    save(db, 'requests', { ...old, ...input, status: 'pending', reviewedBy: undefined, decisionNote: undefined }, old)
    h.logActivity(db, actor, 'request_resubmitted', { requestId: id })
  })
  route('/requests/:id/cancel', 'request_stock', (db, actor, body, id) => {
    const old = get<InventoryWorkRequest>(db, 'requests', id); revision(body.expectedVersion, old)
    if ((old.requesterId !== actor.id && actor.role !== 'admin') || !['pending', 'deferred', 'changes_requested', 'approved'].includes(old.status)) fail('Only an open, unordered request can be cancelled by its requester.', 403)
    save(db, 'requests', { ...old, status: 'cancelled' }, old)
    h.logActivity(db, actor, 'request_cancelled', { requestId: id })
  })
  function reviewRequest(db: DatabaseSync, actor: InventoryUser, body: Body, id: string, batchId?: string) {
    const old = get<InventoryWorkRequest>(db, 'requests', id); revision(body.expectedVersion, old)
    if (batchId && old.batchId !== batchId) fail('Every position must belong to this purchase request.')
    if (old.kind !== 'purchase' || !['pending', 'deferred'].includes(old.status)) fail('This purchase request is no longer awaiting approval.')
    const status = body.decision === 'approve' ? 'approved' : body.decision === 'defer' ? 'deferred' : body.decision === 'changes' ? 'changes_requested' : body.decision === 'reject' ? 'cancelled' : fail('Choose approve, defer, changes or reject.')
    const decisionNote = status === 'approved' ? str(body.note, 2000) : required(body.note, 'a reason for the decision', 2000)
    save(db, 'requests', { ...old, status, reviewedBy: actor.id, decisionNote }, old)
    h.logActivity(db, actor, 'request_reviewed', { requestId: id, batchId: old.batchId, status, decisionNote })
  }
  route('/requests/:id/review', 'order_stock', (db, actor, body, id) => reviewRequest(db, actor, body, id))
  route('/request-batches/:id/review', 'order_stock', (db, actor, body, id) => {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Review between 1 and 100 positions.')
    const seen = new Set<string>()
    for (const line of body.lines as Body[]) {
      const requestId = required(line?.requestId, 'a request position')
      if (seen.has(requestId)) fail('Review each position only once.')
      seen.add(requestId)
      reviewRequest(db, actor, line, requestId, id)
    }
  })
  route('/orders', 'order_stock', (db, actor, body) => {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Select between 1 and 100 approved requests.')
    const seen = new Set<string>()
    const order: InventoryPurchaseOrder = { ...document(), reference: required(body.reference, 'the supplier order reference'), supplier: required(body.supplier, 'a supplier'), expectedDate: str(body.expectedDate, 10) || undefined, shipping: money(body.shipping ?? 0, 'shipping cost'), currency: 'EUR', orderedBy: actor.id, lines: [] }
    if (order.expectedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(order.expectedDate) || !Number.isFinite(Date.parse(order.expectedDate)))) fail('Enter a valid expected delivery date.')
    for (const line of body.lines as Body[]) {
      const request = get<InventoryWorkRequest>(db, 'requests', required(line.requestId, 'an approved request'))
      revision(line.expectedVersion, request)
      if (request.status !== 'approved' || request.kind !== 'purchase' || seen.has(request.id)) fail('Select each approved purchase request once.')
      if (request.reviewedBy !== actor.id) fail('The person who approved the request must record its supplier order.', 403)
      seen.add(request.id)
      const unitCost = number(line.unitCost, 'unit price', true)
      // Approval is a spending boundary: a higher quote needs a fresh approval.
      if (request.estimatedUnitCost !== undefined && unitCost > request.estimatedUnitCost) fail('The unit price exceeds the approved estimate. Return the request for changes and approve the revised price.')
      order.lines.push({ id: randomUUID(), requestId: request.id, itemId: request.itemId, itemName: request.itemName, unit: request.unit, quantity: request.quantity, unitCost, projectId: request.projectId, buildId: request.buildId, receivedQuantity: 0, receipts: [] })
      save(db, 'requests', { ...request, status: 'ordered', orderId: order.id }, request)
    }
    save(db, 'orders', order)
    h.logActivity(db, actor, 'supplier_order_placed', { orderId: order.id, reference: order.reference, shipping: order.shipping })
  })
  route('/requests/:id/reopen', 'order_stock', (db, actor, body, id) => {
    const old = get<InventoryWorkRequest>(db, 'requests', id); revision(body.expectedVersion, old)
    if (old.status !== 'approved' || old.reviewedBy !== actor.id) fail('Only its approver can return an approved, unordered request for changes.', 403)
    save(db, 'requests', { ...old, status: 'changes_requested', decisionNote: required(body.note, 'a reason', 2000) }, old)
  })

  function receive(db: DatabaseSync, actor: InventoryUser, body: Body, order?: InventoryPurchaseOrder) {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Enter at least one item in this delivery.')
    const receiptId = randomUUID(), timestamp = new Date().toISOString()
    db.prepare('INSERT INTO inventory_receipts (id, receivedAt, supplier, orderReference, deliveryNoteNumber, receiverId, receiverLabel, notes, createdAt, createdBy) VALUES (?,?,?,?,?,?,?,?,?,?)').run(receiptId, timestamp, order?.supplier ?? str(body.supplier), order?.reference ?? str(body.reference), str(body.deliveryNote), actor.id, actor.name, str(body.notes, 2000), timestamp, actor.id)
    const seen = new Set<string>()
    for (const input of body.lines as Body[]) {
      const line = order?.lines.find(candidate => candidate.id === input.lineId)
      if (order && (!line || seen.has(line.id))) fail('Select each order line once.')
      if (line) seen.add(line.id)
      const quantity = number(input.quantity, 'received quantity')
      if (line && quantity > roundQuantity(line.quantity - line.receivedQuantity)) fail('The received quantity exceeds the outstanding order quantity.')
      const location = place(input.locationId)
      const requestedPart = line ? get<InventoryWorkRequest>(db, 'requests', line.requestId) : undefined
      const createsArticle = line && !line.itemId
      const selected = line ? (line.itemId ? item(line.itemId) : newItem(db, line.itemName, line.unit, 'Components', { supplierUrl: requestedPart?.supplierUrl, estimatedUnitCost: requestedPart?.estimatedUnitCost, projectIds: line.projectId ? [line.projectId] : [] })) : item(input.itemId)
      if (createsArticle) h.logActivity(db, actor, 'item_created', { name: selected.name, requestId: line.requestId, projectId: line.projectId }, selected.id)
      if (line) line.itemId = selected.id
      const wrongItem = input.condition === 'wrong_item'
      const condition = input.condition === 'damaged' ? 'damaged' : input.condition === 'needs_check' || wrongItem ? 'needs_check' : input.condition === 'new' || input.condition === undefined ? 'new' : fail('Choose new, damaged, wrong item, or needs inspection.')
      const quarantined = condition !== 'new'
      const allocation = order && line ? orderLineCosts(order).find(cost => cost.line.id === line.id)! : undefined
      const unitCost = wrongItem ? undefined : allocation && line ? allocation.total / line.quantity : input.unitCost === undefined ? undefined : number(input.unitCost, 'unit cost', true)
      const stock = newRecord(db, actor, selected.id, location.id, quantity, { condition, quarantined, state: quarantined ? 'delivered' : 'in_stock', unitCost, supplier: order?.supplier ?? str(body.supplier), orderReference: order?.reference ?? str(body.reference), deliveredAt: timestamp, notes: str(input.notes, 2000) }, 'Goods received')
      const receiptLineId = randomUUID()
      db.prepare('INSERT INTO inventory_receipt_lines (id,receiptId,recordId,itemId,locationId,quantity,condition,discrepancy,reviewRequired,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(receiptLineId, receiptId, stock.id, selected.id, location.id, quantity, condition, wrongItem ? 'wrong_item' : condition === 'damaged' ? 'damaged' : 'none', quarantined ? 1 : 0, timestamp)
      h.auditRecordChange(db, actor, 'received', stock, undefined, `Goods receipt ${receiptId}`, receiptLineId)
      if (line) {
        line.receivedQuantity = roundQuantity(line.receivedQuantity + (wrongItem ? 0 : quantity))
        line.receipts.push({ recordId: stock.id, receiptId, quantity })
        const request = get<InventoryWorkRequest>(db, 'requests', line.requestId)
        save(db, 'requests', { ...request, itemId: selected.id, status: line.receivedQuantity >= line.quantity ? 'fulfilled' : 'ordered' }, request)
        if (line.buildId && !quarantined) {
          const planned = get<InventoryBuild>(db, 'builds', line.buildId)
          if (!planned.cancelled && planned.completedQuantity < planned.quantity) {
            const needed = buildRequirements(planned, { records: h.readRecords(), assignments: h.readAssignments(), workflows: readWorkflowState(db) }).find(part => part.itemId === selected.id)
            const toReserve = needed ? Math.min(quantity, Math.max(0, needed.needed - needed.reserved)) : 0
            if (toReserve) { reserve(db, actor, stock, toReserve, { userId: planned.createdBy, projectId: planned.projectId, buildId: planned.id, notes: planned.name }); save(db, 'builds', { ...planned }, planned) }
          }
        } else if (line.projectId && !line.buildId && !quarantined) {
          reserve(db, actor, stock, quantity, { userId: request.requesterId, projectId: line.projectId, requestId: request.id, notes: request.reason })
        }
      }
    }
    h.logActivity(db, actor, 'workflow_delivery_received', { receiptId, orderId: order?.id })
  }
  route('/orders/:id/receive', 'receive_stock', (db, actor, body, id) => {
    const old = get<InventoryPurchaseOrder>(db, 'orders', id); revision(body.expectedVersion, old)
    const updated = structuredClone(old)
    receive(db, actor, body, updated)
    save(db, 'orders', updated, old)
  })
  route('/receive', 'receive_stock', (db, actor, body) => receive(db, actor, body))

  route('/requests/:id/fulfill', 'fulfill_requests', (db, actor, body, id) => {
    const old = get<InventoryWorkRequest>(db, 'requests', id); revision(body.expectedVersion, old)
    if (old.kind !== 'stock' || old.status !== 'pending') fail('This stock request is no longer open.')
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) fail('Select stock to hand out.')
    const lines = body.lines as Body[], seen = new Set<string>(), assignmentIds: string[] = [], materials: Array<{ recordId: string; quantity: number; unitCost?: number }> = []
    const total = roundQuantity(lines.reduce((sum, line) => sum + number(line.quantity, 'handout quantity'), 0))
    const fulfilledQuantity = roundQuantity(stockRequestIssued(old) + total)
    if (fulfilledQuantity > old.quantity) fail('Hand out no more than the remaining requested quantity.')
    for (const line of lines) {
      const stock = record(line.recordId, line.expectedVersion)
      if (seen.has(stock.id) || stock.itemId !== old.itemId) fail('Select each matching stock record once.')
      seen.add(stock.id)
      const quantity = number(line.quantity, 'handout quantity')
      if (quantity > availableStock(stock, h.readAssignments())) fail('There is not enough usable, unreserved stock.')
      if (old.usage === 'borrow') assignmentIds.push(reserve(db, actor, stock, quantity, { userId: old.requesterId, projectId: old.projectId, requestId: old.id, notes: old.reason }).id)
      else changeRecord(db, actor, stock, { quantity: roundQuantity(stock.quantity - quantity) }, `Issued for request ${old.id}: ${old.reason}`)
      materials.push({ recordId: stock.id, quantity, unitCost: stock.unitCost })
    }
    save(db, 'requests', { ...old, status: fulfilledQuantity >= old.quantity ? 'fulfilled' : 'pending', fulfilledQuantity, assignmentIds: [...(old.assignmentIds ?? []), ...assignmentIds], materials: [...(old.materials ?? []), ...materials] }, old)
    h.logActivity(db, actor, 'stock_request_fulfilled', { requestId: id, usage: old.usage, quantity: total, fulfilledQuantity, remaining: roundQuantity(old.quantity - fulfilledQuantity) })
  })
  route('/assignments/:id/return', 'read_inventory', (db, actor, body, id) => {
    const assignment = h.readAssignments().find(a => a.id === id)
    if (!assignment || assignment.returnedAt || assignment.quantity <= 0) fail('This reservation has already been closed.')
    // Read-only users cannot return someone else's stock; build reservations need the planning role.
    const allowed = assignment.buildId ? ['admin', 'hardware_developer', 'stock_manager'].includes(actor.role) : assignment.userId === actor.id || ['admin', 'receiver', 'buyer_receiver', 'stock_manager'].includes(actor.role)
    if (!allowed || actor.role === 'viewer') fail('You cannot return this reservation.', 403)
    const stock = record(assignment.recordId, body.expectedVersion)
    db.prepare('UPDATE inventory_assignments SET returnedAt = ?, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id)
    changeRecord(db, actor, stock, {}, assignment.buildId ? 'Build reservation released' : 'Borrowed equipment returned')
    if (assignment.buildId) { const planned = get<InventoryBuild>(db, 'builds', assignment.buildId); save(db, 'builds', { ...planned }, planned) }
    h.logActivity(db, actor, 'stock_returned', { assignmentId: id })
  })
  route('/assignments/:id/use', 'plan_builds', (db, actor, body, id) => {
    const assignment = h.readAssignments().find(a => a.id === id)
    if (!assignment || assignment.returnedAt || assignment.buildId || !assignment.projectId) fail('Choose material reserved directly for a project.')
    const source = assignment.requestId ? get<InventoryWorkRequest>(db, 'requests', assignment.requestId) : undefined
    if (source?.kind === 'stock' && source.usage === 'borrow') fail('Borrowed equipment must be returned, not consumed.')
    const stock = record(assignment.recordId, body.expectedVersion), quantity = number(body.quantity, 'used quantity')
    if (!usableStock(stock) || quantity > assignment.quantity) fail('Use only the remaining usable reserved quantity.')
    db.prepare('UPDATE inventory_assignments SET consumedQuantity = consumedQuantity + ?, updatedAt = ? WHERE id = ?').run(quantity, new Date().toISOString(), id)
    changeRecord(db, actor, stock, { quantity: roundQuantity(stock.quantity - quantity) }, `Used for project ${assignment.projectId}`)
    const material = { recordId: stock.id, quantity, unitCost: stock.unitCost }
    if (source) save(db, 'requests', { ...source, materials: [...(source.materials ?? []), material] }, source)
    else {
      const selected = item(stock.itemId)
      const request: InventoryWorkRequest = { ...document(), kind: 'stock', status: 'fulfilled', requesterId: actor.id, projectId: assignment.projectId, itemId: selected.id, itemName: selected.name, unit: selected.unit, quantity, usage: 'consume', reason: assignment.notes || 'Project material used', materials: [material] }
      save(db, 'requests', request)
    }
    h.logActivity(db, actor, 'project_material_used', { assignmentId: id, projectId: assignment.projectId, quantity })
  })
  route('/move', 'move_stock', (db, actor, body) => {
    const stock = record(body.recordId, body.expectedVersion), location = place(body.locationId)
    const quantity = number(body.quantity, 'moved quantity')
    if (!['in_stock', 'reserved', 'in_use', 'delivered', 'maintenance', 'damaged'].includes(stock.state) || quantity > stock.quantity || location.id === stock.locationId) fail('Choose physical stock and a different destination.')
    if (quantity === stock.quantity) changeRecord(db, actor, stock, { locationId: location.id }, 'Stock moved')
    else {
      if (!usableStock(stock) || quantity > availableStock(stock, h.readAssignments())) fail('Only free usable stock can be split. Move all units together to preserve reservations or review history.')
      changeRecord(db, actor, stock, { quantity: roundQuantity(stock.quantity - quantity) }, 'Part of stock moved')
      const moved = { ...stock, ...document(), quantity, locationId: location.id, sourceReference: `Moved from ${stock.id}` }
      h.insertRecord(db, moved); h.auditRecordChange(db, actor, 'created', moved, undefined, 'Part of stock moved')
    }
    h.logActivity(db, actor, 'stock_moved', { recordId: stock.id, from: stock.locationId, to: location.id, quantity })
  })
}
