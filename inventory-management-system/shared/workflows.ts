import type { InventoryAssignment, InventoryRecord, InventoryStatePayload } from './inventory.ts'
import { normalizeInventorySearch } from './search.ts'

export interface WorkflowDocument { id: string; version: number; createdAt: string; updatedAt: string }
export interface ProductPart { itemId: string; quantity: number; estimatedUnitCost?: number }
export interface InventoryProduct extends WorkflowDocument {
  name: string; code: string; revision: string; description?: string; outputItemId: string; parts: ProductPart[]; active: boolean
}
export interface InventoryBuild extends WorkflowDocument {
  productId: string; productName: string; productRevision: string; outputItemId: string; projectId?: string
  name: string; quantity: number; completedQuantity: number; parts: ProductPart[]; createdBy: string; cancelled: boolean
}
export type WorkRequestStatus = 'pending' | 'deferred' | 'changes_requested' | 'approved' | 'ordered' | 'fulfilled' | 'cancelled'
export interface InventoryWorkRequest extends WorkflowDocument {
  kind: 'purchase' | 'stock'; status: WorkRequestStatus; requesterId: string; projectId?: string; buildId?: string
  itemId?: string; itemName: string; quantity: number; unit: string; estimatedUnitCost?: number; estimatedShipping?: number
  supplier?: string; supplierUrl?: string; reason: string; decisionNote?: string; reviewedBy?: string
  usage: 'consume' | 'borrow'; orderId?: string; assignmentIds?: string[]
  fulfilledQuantity?: number
  materials?: Array<{ recordId: string; quantity: number; unitCost?: number }>
  batchId?: string
}
export interface PurchaseOrderLine {
  id: string; requestId: string; itemId?: string; itemName: string; unit: string; quantity: number; unitCost: number
  projectId?: string; buildId?: string; receivedQuantity: number; receipts: Array<{ recordId: string; receiptId: string; quantity: number }>
}
export interface InventoryPurchaseOrder extends WorkflowDocument {
  reference: string; supplier: string; expectedDate?: string; shipping: number; currency: 'EUR'; orderedBy: string; lines: PurchaseOrderLine[]
}
export interface InventoryBuildEvent extends WorkflowDocument {
  buildId: string; projectId?: string; quantity: number; outputRecordId: string; actorId: string
  materials: Array<{ recordId: string; itemId: string; quantity: number; unitCost?: number }>
}
export interface InventoryWorkflowState {
  products: InventoryProduct[]; builds: InventoryBuild[]; requests: InventoryWorkRequest[]; orders: InventoryPurchaseOrder[]; buildEvents: InventoryBuildEvent[]
}
export const emptyWorkflows: InventoryWorkflowState = { products: [], builds: [], requests: [], orders: [], buildEvents: [] }
export const roundQuantity = (value: number) => Math.round(value * 1e6) / 1e6
export const stockRequestIssued = (request: InventoryWorkRequest) => request.kind === 'stock' ? request.fulfilledQuantity ?? (request.status === 'fulfilled' ? request.quantity : 0) : 0

/** A filtered queue still shows the entire submitted request, including decided lines. */
export function groupWorkRequests(visible: InventoryWorkRequest[], all = visible) {
  const key = (request: InventoryWorkRequest) => request.kind === 'purchase' && request.batchId ? `batch:${request.batchId}` : `request:${request.id}`
  const groups = new Map<string, InventoryWorkRequest[]>(visible.map(request => [key(request), []]))
  for (const request of all) groups.get(key(request))?.push(request)
  return [...groups.values()].filter(group => group.length)
}

/** Suggest a project's catalog family and parts already used by its builds or requests. */
export function projectPartIds(state: InventoryStatePayload, projectId?: string) {
  const project = state.projects.find(project => project.id === projectId)
  const ids = new Set<string>()
  if (!project) return ids
  const name = normalizeInventorySearch(project.name).replaceAll(' ', '')
  const code = normalizeInventorySearch(project.code)
  for (const item of state.items) {
    if (item.projectIds?.includes(project.id)) ids.add(item.id)
    const category = normalizeInventorySearch(item.category).replaceAll(' ', '')
    if (category === name || category === code.replaceAll(' ', '') || (code && normalizeInventorySearch(item.sku).startsWith(code + ' '))) ids.add(item.id)
  }
  const workflow = state.workflows ?? emptyWorkflows
  for (const build of workflow.builds) if (build.projectId === projectId) { ids.add(build.outputItemId); for (const part of build.parts) ids.add(part.itemId) }
  for (const request of workflow.requests) if (request.projectId === projectId && request.itemId) ids.add(request.itemId)
  for (const order of workflow.orders) for (const line of order.lines) if (line.projectId === projectId && line.itemId) ids.add(line.itemId)
  const records = new Map(state.records.map(record => [record.id, record]))
  for (const assignment of state.assignments) if (assignment.projectId === projectId) { const record = records.get(assignment.recordId); if (record) ids.add(record.itemId) }
  let added = true
  while (added) {
    added = false
    for (const product of workflow.products) if (ids.has(product.outputItemId)) for (const part of product.parts) if (!ids.has(part.itemId)) { ids.add(part.itemId); added = true }
  }
  return ids
}
export function usableStock(record: InventoryRecord) {
  return !record.quarantined && ['new', 'usable'].includes(record.condition) && ['in_stock', 'reserved', 'in_use'].includes(record.state) && record.quantity > 0
}
export function availableStock(record: InventoryRecord, assignments: InventoryAssignment[]) {
  if (!usableStock(record)) return 0
  return roundQuantity(Math.max(0, record.quantity - assignments.filter(a => a.recordId === record.id && !a.returnedAt).reduce((sum, a) => sum + a.quantity, 0)))
}

export interface ItemSupply {
  physical: number; available: number; assigned: number; unavailable: number
  requested: number; approved: number; ordered: number; locationIds: string[]
}
/** Stock is office-wide; allocations and procurement belong only to the selected scope.
 * Assignment quantities from the state API already exclude consumed units.
 */
export function inventorySupply(state: Pick<InventoryStatePayload, 'items' | 'records' | 'assignments' | 'workflows'>, projectId?: string) {
  const supply = new Map<string, ItemSupply>(state.items.map(item => [item.id, { physical: 0, available: 0, assigned: 0, unavailable: 0, requested: 0, approved: 0, ordered: 0, locationIds: [] }]))
  const allocations = new Map<string, { all: number; scoped: number }>()
  const inScope = (id?: string) => (id ?? '') === (projectId ?? '')
  for (const assignment of state.assignments) {
    if (assignment.returnedAt || assignment.quantity <= 0) continue
    const value = allocations.get(assignment.recordId) ?? { all: 0, scoped: 0 }
    value.all += assignment.quantity
    if (inScope(assignment.projectId)) value.scoped += assignment.quantity
    allocations.set(assignment.recordId, value)
  }
  for (const record of state.records) {
    const value = supply.get(record.itemId)
    if (!value || record.quantity <= 0 || !['delivered', 'in_stock', 'reserved', 'in_use', 'maintenance', 'damaged'].includes(record.state)) continue
    value.physical += record.quantity
    if (!value.locationIds.includes(record.locationId)) value.locationIds.push(record.locationId)
    if (usableStock(record)) {
      const allocation = allocations.get(record.id)
      value.available += Math.max(0, record.quantity - (allocation?.all ?? 0))
      value.assigned += Math.min(record.quantity, allocation?.scoped ?? 0)
    } else value.unavailable += record.quantity
  }
  const workflow = state.workflows ?? emptyWorkflows
  for (const request of workflow.requests) {
    const value = request.itemId ? supply.get(request.itemId) : undefined
    if (!value || !inScope(request.projectId) || request.kind !== 'purchase') continue
    if (['pending', 'deferred', 'changes_requested', 'approved'].includes(request.status)) value.requested += request.quantity
    if (request.status === 'approved') value.approved += request.quantity
  }
  // Read outstanding quantities from orders, never from the original request as well.
  for (const order of workflow.orders) for (const line of order.lines) {
    const value = line.itemId ? supply.get(line.itemId) : undefined
    if (value && inScope(line.projectId)) value.ordered += Math.max(0, line.quantity - line.receivedQuantity)
  }
  for (const value of supply.values()) for (const key of ['physical', 'available', 'assigned', 'unavailable', 'requested', 'approved', 'ordered'] as const) value[key] = roundQuantity(value[key])
  return supply
}
export function buildRequirements(build: InventoryBuild, state: Pick<InventoryStatePayload, 'records' | 'assignments' | 'workflows'>) {
  const workflow = state.workflows ?? emptyWorkflows
  const records = new Map(state.records.map(record => [record.id, record]))
  return build.parts.map(part => {
    const needed = roundQuantity((build.quantity - build.completedQuantity) * part.quantity)
    const reserved = roundQuantity(state.assignments.filter(a => a.buildId === build.id && !a.returnedAt && records.get(a.recordId)?.itemId === part.itemId && usableStock(records.get(a.recordId)!)).reduce((sum, a) => sum + a.quantity, 0))
    const ordered = roundQuantity(workflow.orders.flatMap(order => order.lines).filter(line => line.buildId === build.id && line.itemId === part.itemId).reduce((sum, line) => sum + line.quantity - line.receivedQuantity, 0))
    const requested = roundQuantity(workflow.requests.filter(request => request.buildId === build.id && request.itemId === part.itemId && ['pending', 'deferred', 'changes_requested', 'approved'].includes(request.status)).reduce((sum, request) => sum + request.quantity, 0))
    const available = roundQuantity(state.records.filter(record => record.itemId === part.itemId).reduce((sum, record) => sum + availableStock(record, state.assignments), 0))
    return { ...part, needed, reserved, ordered, requested, available, missing: roundQuantity(Math.max(0, needed - reserved - ordered)), toRequest: roundQuantity(Math.max(0, needed - reserved - ordered - requested)) }
  })
}
/** Allocate a shared shipping charge exactly once, in cents, across order lines. */
export function orderLineCosts(order: InventoryPurchaseOrder) {
  const cents = order.lines.map(line => Math.round(line.quantity * line.unitCost * 100))
  const total = cents.reduce((sum, value) => sum + value, 0)
  let left = Math.round(order.shipping * 100)
  return order.lines.map((line, index) => {
    const shipping = index === order.lines.length - 1 ? left : Math.floor(Math.round(order.shipping * 100) * (total ? cents[index] / total : 1 / order.lines.length))
    left -= shipping
    return { line, materials: cents[index] / 100, shipping: shipping / 100, total: (cents[index] + shipping) / 100 }
  })
}

/** Transfers between builds in the same scope must not count the same parts a second time. */
export function materialUsageCosts(workflow: InventoryWorkflowState, records: InventoryRecord[], project: string | null) {
  const inScope = (id?: string) => project === null || (id ?? '') === project
  const events = workflow.buildEvents.filter(event => inScope(event.projectId))
  const outputs = new Set(events.map(event => event.outputRecordId))
  let added = true
  while (added) {
    added = false
    for (const record of records) if (!outputs.has(record.id) && record.sourceReference?.startsWith('Moved from ') && outputs.has(record.sourceReference.slice(11))) { outputs.add(record.id); added = true }
  }
  const materials = [...events.flatMap(event => event.materials), ...workflow.requests.filter(request => inScope(request.projectId) && request.usage === 'consume').flatMap(request => request.materials ?? [])].filter(material => !outputs.has(material.recordId))
  return { known: materials.reduce((sum, material) => sum + material.quantity * (material.unitCost ?? 0), 0), incomplete: materials.some(material => material.unitCost === undefined) }
}
