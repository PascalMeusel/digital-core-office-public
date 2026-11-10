import type { InventoryStatePayload } from './inventory.ts'
import { emptyWorkflows, groupWorkRequests, type InventoryWorkRequest } from './workflows.ts'
import { inventorySearchScore } from './search.ts'
import { euroPrice } from './catalog.ts'

export type RequestView = 'open' | 'mine' | 'action' | 'approval' | 'deferred' | 'changes' | 'approved' | 'ordered' | 'handout' | 'closed' | 'all'
export type ProjectScope = { kind: 'all' } | { kind: 'project'; id: string }
export const requestReference = (request: Pick<InventoryWorkRequest, 'id' | 'batchId'>) => `ANF-${(request.batchId ?? request.id).slice(0, 8).toUpperCase()}`

const partNameKey = (value?: string) => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() ?? ''
const linkKey = (value?: string) => { try { const link = new URL(value ?? ''); if (!['https:', 'http:'].includes(link.protocol)) return ''; link.hash = ''; return link.href } catch { return '' } }

/** Hints only: a matching name/link never merges requests or prevents more demand. */
export function matchingProcurement(requests: InventoryWorkRequest[], { projectId, itemId, itemName, supplierUrl, excludeId }: { projectId?: string; itemId?: string; itemName?: string; supplierUrl?: string; excludeId?: string }) {
  const name = partNameKey(itemName), link = linkKey(supplierUrl)
  return requests.filter(request => request.kind === 'purchase' && request.id !== excludeId && !['cancelled', 'fulfilled'].includes(request.status) && (request.projectId ?? '') === (projectId ?? '') && (itemId ? request.itemId === itemId : Boolean((name && partNameKey(request.itemName) === name) || (link && linkKey(request.supplierUrl) === link))))
}

export function requestNeedsAction(request: InventoryWorkRequest, state: Pick<InventoryStatePayload, 'permissions' | 'currentUser'>) {
  if (request.status === 'changes_requested') return request.requesterId === state.currentUser.id && state.permissions.includes('request_stock')
  if (request.kind === 'stock') return request.status === 'pending' && state.permissions.includes('fulfill_requests')
  if (!state.permissions.includes('order_stock')) return false
  return ['pending', 'deferred'].includes(request.status) || (request.status === 'approved' && request.reviewedBy === state.currentUser.id)
}

/** Match a submitted request as a whole, including its already decided positions. */
export function selectRequestGroups(state: InventoryStatePayload, { view = 'open', project = { kind: 'all' }, query = '' }: { view?: RequestView; project?: ProjectScope; query?: string } = {}) {
  const workflow = state.workflows ?? emptyWorkflows
  const users = new Map(state.users.map(user => [user.id, user.name]))
  const projects = new Map(state.projects.map(project => [project.id, project]))
  const items = new Map(state.items.map(item => [item.id, item]))
  const orders = new Map(workflow.orders.map(order => [order.id, order]))
  function matches(request: InventoryWorkRequest) {
    if (project.kind === 'project' && (request.projectId ?? '') !== project.id) return false
    switch (view) {
      case 'open': return !['fulfilled', 'cancelled'].includes(request.status)
      case 'mine': return request.requesterId === state.currentUser.id
      case 'action': return requestNeedsAction(request, state)
      case 'approval': return request.kind === 'purchase' && request.status === 'pending'
      case 'deferred': return request.status === 'deferred'
      case 'changes': return request.status === 'changes_requested'
      case 'approved': return request.status === 'approved'
      case 'ordered': return request.kind === 'purchase' && request.status === 'ordered'
      case 'handout': return request.kind === 'stock' && request.status === 'pending'
      case 'closed': return ['fulfilled', 'cancelled'].includes(request.status)
      case 'all': return true
    }
  }
  return groupWorkRequests(workflow.requests).filter(group => group.some(matches) && inventorySearchScore(query, group.flatMap(request => {
    const item = items.get(request.itemId ?? ''), project = projects.get(request.projectId ?? ''), order = orders.get(request.orderId ?? '')
    return [request.itemName, request.reason, request.decisionNote, requestReference(request), request.supplier, request.supplierUrl, users.get(request.requesterId), users.get(request.reviewedBy ?? ''), project?.name, project?.code, item?.sku, item?.manufacturerPartNumber, item?.lcscPartNumber, order?.reference, order?.supplier]
  })))
}

/** Show the same line-cent and shipping-cent rounding used by recorded orders. */
export function orderDraftTotals(requests: InventoryWorkRequest[], costs: Record<string, string>, shipping: string) {
  const price = (value: string, format = { decimalPlaces: 6 as 2 | 6, maximum: 1e9 }) => { try { return euroPrice(value, format) } catch { return undefined } }
  const lines = requests.map(request => ({ request, unitCost: price(costs[request.id] ?? String(request.estimatedUnitCost ?? '')) }))
  const missingPrices = lines.filter(line => line.unitCost === undefined).length
  const materials = lines.reduce((cents, line) => cents + Math.round(line.request.quantity * (line.unitCost ?? 0) * 100), 0) / 100
  const parsedShipping = price(shipping, { decimalPlaces: 2, maximum: 1e7 }), shippingCost = parsedShipping === undefined ? undefined : Math.round(parsedShipping * 100) / 100
  const overLimit = lines.filter(({ request, unitCost }) => unitCost !== undefined && request.estimatedUnitCost !== undefined && unitCost > request.estimatedUnitCost).map(line => line.request.id)
  return { lines, missingPrices, materials, shipping: shippingCost, total: missingPrices || shippingCost === undefined ? undefined : Math.round((materials + shippingCost) * 100) / 100, overLimit }
}
