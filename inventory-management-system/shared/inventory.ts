import type { InventoryWorkflowState } from './workflows.ts'

export const inventoryRoles = ['admin', 'hardware_developer', 'software_developer', 'buyer', 'receiver', 'buyer_receiver', 'stock_manager', 'viewer'] as const
export type InventoryRole = (typeof inventoryRoles)[number]

export const inventoryStates = [
  'requested',
  'approved',
  'ordered',
  'delivered',
  'in_stock',
  'reserved',
  'in_use',
  'maintenance',
  'damaged',
  'retired',
  'cancelled',
] as const
export type InventoryState = (typeof inventoryStates)[number]

export const inventoryConditions = ['new', 'usable', 'needs_check', 'damaged', 'expired'] as const
export type InventoryCondition = (typeof inventoryConditions)[number]

export const inventoryPermissions = [
  'read_inventory',
  'manage_users',
  'manage_catalog',
  'manage_locations',
  'request_stock',
  'order_stock',
  'receive_stock',
  'adjust_stock',
  'update_state',
  'export_inventory',
  'manage_products',
  'plan_builds',
  'manage_projects',
  'fulfill_requests',
  'move_stock',
] as const
export type InventoryPermission = (typeof inventoryPermissions)[number]

export const inventoryLocationKinds = ['room', 'fixture', 'container'] as const
export type InventoryLocationKind = (typeof inventoryLocationKinds)[number]

export interface InventoryUser {
  id: string
  name: string
  email: string
  role: InventoryRole
  active: boolean
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
}

export interface InventoryLocation {
  id: string
  name: string
  code: string
  kind: InventoryLocationKind
  parentId?: string
  area?: string
  rack?: string
  bin?: string
  description?: string
  roomCode?: string
  roomName?: string
  fixtureCode?: string
  fixtureType?: string
  rowCode?: string
  planImagePath?: string
  photoPath?: string
  highlightX?: number
  highlightY?: number
  highlightWidth?: number
  highlightHeight?: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InventoryItemDefinition {
  id: string
  sku: string
  name: string
  category: string
  description?: string
  manufacturer?: string
  model?: string
  value?: string
  manufacturerPartNumber?: string
  lcscPartNumber?: string
  packageForm?: string
  supplierUrl?: string
  estimatedUnitCost?: number
  projectIds?: string[]
  photoPath?: string
  unit: string
  minQuantity: number
  reorderQuantity: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InventoryTag {
  id: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export interface InventoryCategoryTag {
  category: string
  tagId: string
}

export interface InventoryRecordTag {
  recordId: string
  tagId: string
}

export interface InventoryRecord {
  id: string
  version: number
  quarantined: boolean
  itemId: string
  locationId: string
  label?: string
  groupName?: string
  quantity: number
  quantityLabel?: string
  state: InventoryState
  condition: InventoryCondition
  assetTag?: string
  serialNumber?: string
  lotNumber?: string
  supplier?: string
  orderReference?: string
  unitCost?: number
  requestedBy?: string
  orderedBy?: string
  receivedBy?: string
  lastCountedBy?: string
  notes?: string
  photoPath?: string
  photoVerified?: boolean
  sourceReference?: string
  dueDate?: string
  requestedAt?: string
  orderedAt?: string
  deliveredAt?: string
  stockedAt?: string
  createdAt: string
  updatedAt: string
}

export interface InventoryAssignment {
  id: string
  recordId: string
  userId: string
  projectId?: string
  buildId?: string
  requestId?: string
  consumedQuantity?: number
  quantity: number
  notes?: string
  assignedAt: string
  returnedAt?: string
  createdAt: string
  updatedAt: string
}

export interface InventoryProject {
  id: string
  name: string
  code: string
  description?: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InventoryActivity {
  id: string
  itemId?: string
  recordId?: string
  actorId: string
  action: string
  details: Record<string, unknown>
  createdAt: string
}

export const inventoryReceiptDiscrepancies = ['none', 'short', 'over', 'damaged', 'wrong_item'] as const
export type InventoryReceiptDiscrepancy = (typeof inventoryReceiptDiscrepancies)[number]

export interface InventoryReceipt {
  id: string
  receivedAt: string
  supplier?: string
  orderReference?: string
  deliveryNoteNumber?: string
  receiverId?: string
  receiverLabel?: string
  notes?: string
  attachmentName?: string
  attachmentPath?: string
  sourceReference?: string
  createdAt: string
  createdBy: string
}

export interface InventoryReceiptLine {
  id: string
  receiptId: string
  recordId: string
  itemId: string
  locationId: string
  quantity: number
  quantityLabel?: string
  condition: InventoryCondition
  discrepancy: InventoryReceiptDiscrepancy
  discrepancyQuantity?: number
  notes?: string
  barcode?: string
  sourceReference?: string
  reviewRequired: boolean
  reversedByEventId?: string
  releasedByEventId?: string
  sourceRecordId?: string
  currentVersion: number
  quarantined: boolean
  currentQuantity?: number
  currentLocationId?: string
  adjustments?: Array<{ id: string; type: 'corrected' | 'reversed'; createdAt: string; quantityBefore?: number; quantityAfter?: number; reason?: string; actor?: string }>
  createdAt: string
}

export interface InventoryRecordEvent {
  id: string
  recordId: string
  itemId: string
  eventType: 'created' | 'changed' | 'received' | 'corrected' | 'reversed' | 'legacy_import'
  actorId?: string
  actorLabel?: string
  reason?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  receiptLineId?: string
  sourceReference?: string
  createdAt: string
}

export type InventoryQrTargetType = 'record' | 'item' | 'category' | 'place'

export interface InventoryQrLabel {
  id: string
  name: string
  targetType: InventoryQrTargetType
  targetId: string
  active: boolean
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export interface InventoryItemTotals {
  itemId: string
  requestedQuantity: number
  orderedQuantity: number
  deliveredQuantity: number
  inStockQuantity: number
  usableQuantity: number
  totalTrackedQuantity: number
  belowMinimum: boolean
}

export interface InventoryStatePayload {
  workflows?: InventoryWorkflowState
  currentUser: InventoryUser
  csrfToken: string
  sessionToken?: string
  usersManagedByCore?: boolean
  coreLoginUrl?: string
  users: InventoryUser[]
  locations: InventoryLocation[]
  items: InventoryItemDefinition[]
  categories: string[]
  tags: InventoryTag[]
  categoryTags: InventoryCategoryTag[]
  recordTags: InventoryRecordTag[]
  records: InventoryRecord[]
  assignments: InventoryAssignment[]
  projects: InventoryProject[]
  activity: InventoryActivity[]
  receipts: InventoryReceipt[]
  receiptLines: InventoryReceiptLine[]
  recordEvents: InventoryRecordEvent[]
  qrLabels: InventoryQrLabel[]
  permissions: InventoryPermission[]
  totals: InventoryItemTotals[]
  referenceRooms: Array<{ code: string; name: string; planImagePath: string }>
  generatedAt: string
}
