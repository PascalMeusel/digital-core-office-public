import { stockRequestIssued, type InventoryWorkflowState, type InventoryWorkRequest } from './workflows.ts'

export interface ClickUpOption { id: string; name: string }
export interface ClickUpListLink { projectId: string; listId: string; path: string }
export interface ClickUpTaskLink {
  listId: string; taskId?: string; name?: string; url?: string; status?: string
  managed: boolean; pending: boolean; lastSyncedAt?: string; error?: string; canRemove: boolean
}
export interface ClickUpConnection { configured: boolean; connected: boolean; name?: string }
export type ClickUpApi = <T>(path: string, body?: Record<string, unknown>) => Promise<T>

export function clickUpRequestKey(request: InventoryWorkRequest) { return request.batchId ? `batch:${request.batchId}` : `request:${request.id}` }
export function clickUpRequestGroup(state: InventoryWorkflowState, requestId: string) {
  const request = state.requests.find(r => r.id === requestId)
  return request ? state.requests.filter(r => clickUpRequestKey(r) === clickUpRequestKey(request)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) : []
}
export function clickUpReference(request: InventoryWorkRequest) { return `ANF-${(request.batchId ?? request.id).slice(0, 8).toUpperCase()}` }
const labels: Record<InventoryWorkRequest['status'], string> = { pending: 'Angefragt', deferred: 'Zurückgestellt', changes_requested: 'Rückfrage', approved: 'Freigegeben', ordered: 'Bestellt', fulfilled: 'Erledigt', cancelled: 'Zurückgezogen' }
const plain = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '')
export function clickUpReport(state: InventoryWorkflowState, group: InventoryWorkRequest[], projectName: string) {
  return [
    `## Inventar · ${plain(projectName)} · ${clickUpReference(group[0])}`,
    'Freigabe, Bestellung und Wareneingang werden im Digital Core Office geführt.', '',
    ...group.map(r => {
      const line = state.orders.flatMap(o => o.lines).find(l => l.requestId === r.id)
      const progress = r.kind === 'stock' ? ` · ${stockRequestIssued(r)} ausgegeben` : line ? ` · ${line.receivedQuantity} von ${line.quantity} eingegangen` : ''
      return `- ${r.quantity} ${plain(r.unit)} ${plain(r.itemName)}: **${labels[r.status]}**${progress}${r.decisionNote ? ` · ${plain(r.decisionNote)}` : ''}`
    }),
  ].join('\n')
}
// A separate block preserves text added by the team in the same ClickUp task.
export function clickUpDescription(description: string, key: string, report: string) {
  const start = `[DCO-INVENTORY:${key}]`, end = `[/DCO-INVENTORY:${key}]`
  const block = `${start}\n${report}\n${end}`
  const from = description.indexOf(start), to = description.indexOf(end, from)
  if (from >= 0 && to >= from) return description.slice(0, from) + block + description.slice(to + end.length)
  if (from >= 0 || description.includes(end)) throw new Error('Der Inventarbereich in ClickUp wurde verändert. Bitte die Markierungen wiederherstellen.')
  return [description.trim(), block].filter(Boolean).join('\n\n')
}
