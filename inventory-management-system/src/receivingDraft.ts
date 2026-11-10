import type { InventoryPurchaseOrder } from '../shared/workflows.ts'

export function receivingDraftKey(userId: string, serverScope: string) {
  return `inventorySystem.receiving-draft.v1:${encodeURIComponent(serverScope)}:${encodeURIComponent(userId)}`
}

export interface ArrivalDraft { quantity: string; locationId: string; condition: string; notes: string }
export interface OrderReceiptDraft { order: InventoryPurchaseOrder; locationId: string; lines: Record<string, ArrivalDraft>; deliveryNote: string; notes: string }
export interface UnorderedReceiptDraft { itemId: string; locationId: string; parts: Record<string, ArrivalDraft & { unitCost: string }>; deliveryNote: string; notes: string }
export const emptyArrival = (): ArrivalDraft => ({ quantity: '', locationId: '', condition: 'new', notes: '' })
export const orderReceiptDraft = (order: InventoryPurchaseOrder): OrderReceiptDraft => ({ order, locationId: '', lines: {}, deliveryNote: '', notes: '' })
export const hasOrderReceiptDraft = (draft: OrderReceiptDraft) => Boolean(draft.locationId || draft.deliveryNote || draft.notes || Object.values(draft.lines).some(line => line.quantity || line.locationId || line.notes || line.condition !== 'new'))
