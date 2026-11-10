import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router, type NextFunction, type Request, type Response } from 'express'
import {
  inventoryConditions,
  inventoryLocationKinds,
  inventoryReceiptDiscrepancies,
  inventoryRoles,
  inventoryStates,
  type InventoryActivity,
  type InventoryAssignment,
  type InventoryCategoryTag,
  type InventoryCondition,
  type InventoryItemDefinition,
  type InventoryItemTotals,
  type InventoryLocation,
  type InventoryLocationKind,
  type InventoryPermission,
  type InventoryProject,
  type InventoryQrLabel,
  type InventoryQrTargetType,
  type InventoryReceipt,
  type InventoryReceiptDiscrepancy,
  type InventoryReceiptLine,
  type InventoryRecord,
  type InventoryRecordEvent,
  type InventoryRecordTag,
  type InventoryRole,
  type InventoryState,
  type InventoryStatePayload,
  type InventoryTag,
  type InventoryUser,
} from '../shared/inventory.ts'
import { catalogUnit } from '../shared/catalog.ts'
import { ensureCatalogSchema, readCatalogDetails, writeCatalogDetails, parseCatalogDetails, saveCatalogPhoto, registerCatalogRoutes } from './catalog.ts'
import { parseCsv, rowsFromMatrix, type ReceivingImportRow } from './receivingImport.ts'
import { ensureWorkflowSchema, readWorkflowState, registerInventoryWorkflows, workflowUsesItem } from './workflows.ts'
import { ensureClickUpSchema, registerInventoryClickUp } from './clickup.ts'
import { coreInventoryIntegrationUsers } from '../../packages/core-client/index.ts'
import { CoreAuthError, coreEnabled, requireCoreIdentity, loginWithCore, logoutFromCore, coreTokenForRequest, coreCookieTokenForRequest, coreSessionCookie, approveCoreQr } from '../../packages/core-client/index.ts'

interface CountRow {
  count: number
}

interface IdRow {
  id: string
}

interface InventoryUserRow {
  id: string
  name: string
  email: string
  role: InventoryRole
  active: number
  mustChangePassword: number
  createdAt: string
  updatedAt: string
}

interface InventoryLocationRow {
  id: string
  name: string
  code: string | null
  kind: InventoryLocationKind
  parentId: string | null
  area: string | null
  rack: string | null
  bin: string | null
  description: string | null
  roomCode: string | null
  roomName: string | null
  fixtureCode: string | null
  fixtureType: string | null
  rowCode: string | null
  planImagePath: string | null
  photoPath: string | null
  highlightX: number | null
  highlightY: number | null
  highlightWidth: number | null
  highlightHeight: number | null
  active: number
  createdAt: string
  updatedAt: string
}

interface InventoryItemRow {
  id: string
  sku: string | null
  name: string
  category: string
  description: string | null
  manufacturer: string | null
  model: string | null
  value: string | null
  manufacturerPartNumber: string | null
  lcscPartNumber: string | null
  packageForm: string | null
  unit: string
  minQuantity: number
  reorderQuantity: number
  active: number
  createdAt: string
  updatedAt: string
}

interface InventoryRecordRow {
  id: string
  version: number
  quarantined: number
  itemId: string
  locationId: string
  label: string | null
  groupName: string | null
  quantity: number
  quantityLabel: string | null
  state: InventoryState
  condition: InventoryCondition
  assetTag: string | null
  serialNumber: string | null
  lotNumber: string | null
  supplier: string | null
  orderReference: string | null
  unitCost: number | null
  requestedBy: string | null
  orderedBy: string | null
  receivedBy: string | null
  lastCountedBy: string | null
  notes: string | null
  photoPath: string | null
  photoVerified: number
  sourceReference: string | null
  dueDate: string | null
  requestedAt: string | null
  orderedAt: string | null
  deliveredAt: string | null
  stockedAt: string | null
  createdAt: string
  updatedAt: string
}

interface TableInfoRow {
  name: string
  notnull: number
}

interface InventoryActivityRow {
  id: string
  itemId: string | null
  recordId: string | null
  actorId: string
  action: string
  details: string
  createdAt: string
}

interface InventoryReceiptRow {
  id: string
  receivedAt: string
  supplier: string | null
  orderReference: string | null
  deliveryNoteNumber: string | null
  receiverId: string | null
  receiverLabel: string | null
  notes: string | null
  attachmentName: string | null
  attachmentPath: string | null
  sourceReference: string | null
  createdAt: string
  createdBy: string
}

interface InventoryReceiptLineRow {
  id: string
  receiptId: string
  recordId: string
  itemId: string
  locationId: string
  quantity: number
  quantityLabel: string | null
  condition: InventoryCondition
  discrepancy: InventoryReceiptDiscrepancy
  discrepancyQuantity: number | null
  notes: string | null
  barcode: string | null
  sourceReference: string | null
  reviewRequired: number
  reversedByEventId: string | null
  releasedByEventId: string | null
  sourceRecordId: string | null
  createdAt: string
}

interface InventoryRecordEventRow {
  id: string
  recordId: string
  itemId: string
  eventType: InventoryRecordEvent['eventType']
  actorId: string | null
  actorLabel: string | null
  reason: string | null
  beforeJson: string | null
  afterJson: string | null
  receiptLineId: string | null
  sourceReference: string | null
  createdAt: string
}

interface InventoryQrLabelRow {
  id: string
  name: string
  targetType: InventoryQrTargetType
  targetId: string
  active: number
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

interface InventoryTagRow {
  id: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

interface InventoryCategoryTagRow {
  category: string
  tagId: string
}

interface InventoryRecordTagRow {
  recordId: string
  tagId: string
}

interface InventoryAssignmentRow {
  id: string
  recordId: string
  userId: string
  projectId: string | null
  buildId: string | null
  requestId: string | null
  consumedQuantity: number
  quantity: number
  notes: string | null
  assignedAt: string
  returnedAt: string | null
  createdAt: string
  updatedAt: string
}

interface InventoryQrLoginGrantRow {
  id: string
  userId: string
  tokenHash: string
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

interface InventoryQrLoginChallengeRow {
  id: string
  tokenHash: string
  approvedByUserId: string | null
  approvedAt: string | null
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

interface InventoryCredentialRow {
  userId: string
  passwordHash: string
  passwordSalt: string
  passwordAlgorithm?: string
  passwordUpdatedAt: string
  failedAttempts: number
  lockedUntil: string | null
}

interface InventorySessionRow {
  id: string
  userId: string
  tokenHash: string
  csrfToken: string
  expiresAt: string
  createdAt: string
  lastSeenAt: string
  userAgent: string | null
  ipAddress: string | null
}

interface LoginRateBucket {
  attempts: number
  resetAt: number
  lockedUntil: number
}

interface InventorySessionContext {
  user: InventoryUser
  session: InventorySessionRow
  sessionToken: string
  setCookie?: string
  coreReadOnly?: boolean
}

type InventoryRecordInput = Omit<InventoryRecord, 'id' | 'version' | 'quarantined' | 'createdAt' | 'updatedAt'>

interface ReferenceInventoryData {
  rooms: Array<{ code: string; name: string; planImagePath: string }>
  locations: Array<Omit<InventoryLocation, 'kind' | 'parentId'> & { kind?: InventoryLocationKind; parentId?: string }>
  rows: Array<{ item: InventoryItemDefinition; record: InventoryRecord }>
  removedInventoryRows?: Array<{ itemId: string; recordId: string; reason: string }>
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultInventoryDataPath = join(moduleDir, 'data', 'inventory-system.sqlite')
const inventoryDataPath = process.env.INVENTORY_SYSTEM_DATA ?? defaultInventoryDataPath
const inventoryMediaPath = process.env.INVENTORY_MEDIA_DIR?.trim() || join(dirname(inventoryDataPath), 'media')
export const inventoryStaticMediaPath = process.env.INVENTORY_STATIC_MEDIA_DIR?.trim() || join(dirname(inventoryDataPath), 'static-media')
const referenceInventoryPath = process.env.INVENTORY_REFERENCE_DATA_FILE?.trim()
const referenceInventory: ReferenceInventoryData = referenceInventoryPath && existsSync(referenceInventoryPath)
  ? JSON.parse(readFileSync(referenceInventoryPath, 'utf8')) as ReferenceInventoryData
  : { rooms: [], locations: [], rows: [] }
let inventoryConnection: DatabaseSync | undefined

const sessionCookieName = 'inventory_session'
const digitalOfficeSsoCookieName = process.env.DIGITAL_OFFICE_SSO_COOKIE_NAME?.trim() || 'digital_office_sso'
const sessionDurationMs = 12 * 60 * 60 * 1000
const persistentSessionDurationMs = 30 * 24 * 60 * 60 * 1000
const qrLoginGrantDurationMs = 2 * 60 * 1000
const loginWindowMs = 15 * 60 * 1000
const maxLoginAttempts = 6
const passwordKeyLength = 64
const passwordScryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const inventoryPasswordAlgorithm = 'inventory-scrypt-v1' // gitleaks:allow -- algorithm identifier, not a credential
const timePasswordAlgorithm = 'time-pbkdf2-sha256'
const digitalOfficeSsoSecret =
  process.env.DIGITAL_OFFICE_SSO_SECRET ?? process.env.INVENTORY_SYSTEM_SSO_SECRET ?? randomBytes(32).toString('hex')
const digitalOfficeCookieDomain = process.env.DIGITAL_OFFICE_COOKIE_DOMAIN?.trim()
const loginRateBuckets = new Map<string, LoginRateBucket>()
const requestAuthContexts = new WeakMap<Request, InventorySessionContext>()

const rolePermissions: Record<InventoryRole, InventoryPermission[]> = {
  admin: [
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
    'manage_products', 'plan_builds', 'manage_projects', 'fulfill_requests', 'move_stock',
  ],
  buyer: ['read_inventory', 'manage_catalog', 'request_stock', 'order_stock', 'export_inventory'],
  hardware_developer: ['read_inventory', 'request_stock', 'manage_catalog', 'manage_products', 'plan_builds', 'manage_projects', 'export_inventory'],
  software_developer: ['read_inventory', 'request_stock', 'export_inventory'],
  receiver: ['read_inventory', 'receive_stock', 'fulfill_requests', 'move_stock', 'request_stock', 'export_inventory'],
  buyer_receiver: ['read_inventory', 'manage_catalog', 'request_stock', 'order_stock', 'receive_stock', 'fulfill_requests', 'move_stock', 'export_inventory'],
  stock_manager: ['read_inventory', 'manage_catalog', 'manage_locations', 'adjust_stock', 'update_state', 'manage_products', 'plan_builds', 'manage_projects', 'fulfill_requests', 'move_stock', 'request_stock', 'export_inventory'],
  viewer: ['read_inventory', 'export_inventory'],
}

export const inventorySystemRouter = Router()

export function inventorySystemDataFilePath() {
  return inventoryDataPath
}

export function closeInventorySystemDatabase() {
  inventoryClickUp.stop()
  inventoryConnection?.close()
  inventoryConnection = undefined
}

export function inventorySystemHealth() {
  const database = connection()
  const integrity = (database.prepare(`PRAGMA quick_check`).get() as { quick_check: string }).quick_check
  const records = (database.prepare(`SELECT COUNT(*) AS count FROM inventory_records`).get() as unknown as CountRow).count
  const receipts = (database.prepare(`SELECT COUNT(*) AS count FROM inventory_receipts`).get() as unknown as CountRow).count
  return {
    ok: integrity === 'ok',
    service: 'digital-core-office-inventory',
    apiVersion: 1,
    dataFile: inventoryDataPath,
    records,
    receipts,
    integrity,
  }
}

function nowIso() {
  return new Date().toISOString()
}

function connection() {
  if (!inventoryConnection) {
    mkdirSync(dirname(inventoryDataPath), { recursive: true })
    inventoryConnection = new DatabaseSync(inventoryDataPath)
    inventoryConnection.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
    ensureSchema(inventoryConnection)
    if (!coreEnabled()) seedIfEmpty(inventoryConnection)
    ensureReferenceInventory(inventoryConnection)
    ensureLocationHierarchyData(inventoryConnection)
    ensureReferenceRoomLocations(inventoryConnection)
    if (!coreEnabled()) ensureBootstrapAdminFromEnv(inventoryConnection)
    cleanupExpiredSessions(inventoryConnection)
  }

  return inventoryConnection
}

function ensureSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inventory_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      mustChangePassword INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_core_profiles (
      coreUserId TEXT PRIMARY KEY,
      userId TEXT NOT NULL UNIQUE REFERENCES inventory_users(id)
    );
    CREATE TABLE IF NOT EXISTS inventory_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      kind TEXT NOT NULL DEFAULT 'room',
      parentId TEXT,
      area TEXT,
      rack TEXT,
      bin TEXT,
      description TEXT,
      roomCode TEXT,
      roomName TEXT,
      fixtureCode TEXT,
      fixtureType TEXT,
      rowCode TEXT,
      planImagePath TEXT,
      photoPath TEXT,
      highlightX REAL,
      highlightY REAL,
      highlightWidth REAL,
      highlightHeight REAL,
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_locations_code_unique
      ON inventory_locations(code)
      WHERE code IS NOT NULL AND code != '';
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      sku TEXT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      manufacturer TEXT,
      model TEXT,
      value TEXT,
      manufacturerPartNumber TEXT,
      lcscPartNumber TEXT,
      packageForm TEXT,
      unit TEXT NOT NULL,
      minQuantity REAL NOT NULL DEFAULT 0,
      reorderQuantity REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_records (
      id TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      locationId TEXT NOT NULL,
      label TEXT,
      groupName TEXT,
      quantity REAL NOT NULL,
      quantityLabel TEXT,
      state TEXT NOT NULL,
      condition TEXT NOT NULL,
      assetTag TEXT,
      serialNumber TEXT,
      lotNumber TEXT,
      supplier TEXT,
      orderReference TEXT,
      unitCost REAL,
      requestedBy TEXT,
      orderedBy TEXT,
      receivedBy TEXT,
      lastCountedBy TEXT,
      notes TEXT,
      photoPath TEXT,
      photoVerified INTEGER NOT NULL DEFAULT 0,
      sourceReference TEXT,
      dueDate TEXT,
      requestedAt TEXT,
      orderedAt TEXT,
      deliveredAt TEXT,
      stockedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_records_item ON inventory_records(itemId);
    CREATE INDEX IF NOT EXISTS idx_inventory_records_location ON inventory_records(locationId);
    CREATE INDEX IF NOT EXISTS idx_inventory_records_state ON inventory_records(state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku_unique
      ON inventory_items(sku)
      WHERE sku IS NOT NULL AND sku != '';
    CREATE TABLE IF NOT EXISTS inventory_activity (
      id TEXT PRIMARY KEY,
      itemId TEXT,
      recordId TEXT,
      actorId TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_activity_created ON inventory_activity(createdAt);
    CREATE TABLE IF NOT EXISTS inventory_receipts (
      id TEXT PRIMARY KEY,
      receivedAt TEXT NOT NULL,
      supplier TEXT,
      orderReference TEXT,
      deliveryNoteNumber TEXT,
      receiverId TEXT,
      receiverLabel TEXT,
      notes TEXT,
      attachmentName TEXT,
      attachmentPath TEXT,
      sourceReference TEXT,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_receipts_received ON inventory_receipts(receivedAt);
    CREATE INDEX IF NOT EXISTS idx_inventory_receipts_order ON inventory_receipts(orderReference);
    CREATE TABLE IF NOT EXISTS inventory_receipt_requests (
      actorId TEXT NOT NULL,
      requestKey TEXT NOT NULL,
      requestHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (actorId, requestKey)
    );
    CREATE TABLE IF NOT EXISTS inventory_receipt_lines (
      id TEXT PRIMARY KEY,
      receiptId TEXT NOT NULL,
      recordId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      locationId TEXT NOT NULL,
      quantity REAL NOT NULL,
      quantityLabel TEXT,
      condition TEXT NOT NULL,
      discrepancy TEXT NOT NULL DEFAULT 'none',
      discrepancyQuantity REAL,
      notes TEXT,
      barcode TEXT,
      sourceReference TEXT,
      reviewRequired INTEGER NOT NULL DEFAULT 0,
      reversedByEventId TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (receiptId) REFERENCES inventory_receipts(id),
      FOREIGN KEY (recordId) REFERENCES inventory_records(id),
      FOREIGN KEY (itemId) REFERENCES inventory_items(id),
      FOREIGN KEY (locationId) REFERENCES inventory_locations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_receipt_lines_receipt ON inventory_receipt_lines(receiptId);
    CREATE INDEX IF NOT EXISTS idx_inventory_receipt_lines_item ON inventory_receipt_lines(itemId);
    CREATE TABLE IF NOT EXISTS inventory_record_events (
      id TEXT PRIMARY KEY,
      recordId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      actorId TEXT,
      actorLabel TEXT,
      reason TEXT,
      beforeJson TEXT,
      afterJson TEXT,
      receiptLineId TEXT,
      sourceReference TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_record_events_record ON inventory_record_events(recordId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_inventory_record_events_created ON inventory_record_events(createdAt);
    CREATE TABLE IF NOT EXISTS inventory_qr_labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      targetType TEXT NOT NULL,
      targetId TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      createdBy TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_qr_labels_target ON inventory_qr_labels(targetType, targetId);
    CREATE INDEX IF NOT EXISTS idx_inventory_qr_labels_active ON inventory_qr_labels(active, updatedAt);
    CREATE TABLE IF NOT EXISTS inventory_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#0f766e',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_category_tags (
      category TEXT NOT NULL,
      tagId TEXT NOT NULL,
      PRIMARY KEY (category, tagId),
      FOREIGN KEY (tagId) REFERENCES inventory_tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_category_tags_tag ON inventory_category_tags(tagId);
    CREATE TABLE IF NOT EXISTS inventory_record_tags (
      recordId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      PRIMARY KEY (recordId, tagId),
      FOREIGN KEY (recordId) REFERENCES inventory_records(id) ON DELETE CASCADE,
      FOREIGN KEY (tagId) REFERENCES inventory_tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_record_tags_tag ON inventory_record_tags(tagId);
    CREATE TABLE IF NOT EXISTS inventory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_assignments (
      id TEXT PRIMARY KEY,
      recordId TEXT NOT NULL,
      userId TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      notes TEXT,
      assignedAt TEXT NOT NULL,
      returnedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (recordId) REFERENCES inventory_records(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES inventory_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_assignments_record ON inventory_assignments(recordId);
    CREATE INDEX IF NOT EXISTS idx_inventory_assignments_user ON inventory_assignments(userId);
    CREATE TABLE IF NOT EXISTS inventory_user_credentials (
      userId TEXT PRIMARY KEY,
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      passwordAlgorithm TEXT NOT NULL DEFAULT '${inventoryPasswordAlgorithm}',
      passwordUpdatedAt TEXT NOT NULL,
      failedAttempts INTEGER NOT NULL DEFAULT 0,
      lockedUntil TEXT,
      FOREIGN KEY (userId) REFERENCES inventory_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS inventory_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      csrfToken TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      userAgent TEXT,
      ipAddress TEXT,
      FOREIGN KEY (userId) REFERENCES inventory_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_sessions_user ON inventory_sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_inventory_sessions_expires ON inventory_sessions(expiresAt);
    CREATE TABLE IF NOT EXISTS inventory_qr_login_grants (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      usedAt TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES inventory_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_qr_login_grants_expires ON inventory_qr_login_grants(expiresAt);
    CREATE TABLE IF NOT EXISTS inventory_qr_login_challenges (
      id TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      approvedByUserId TEXT,
      approvedAt TEXT,
      expiresAt TEXT NOT NULL,
      usedAt TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (approvedByUserId) REFERENCES inventory_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_qr_login_challenges_expires ON inventory_qr_login_challenges(expiresAt);
  `)
  ensureUserAccountStateSchema(database)
  ensureCredentialAlgorithmSchema(database)
  ensureOptionalLocationCodeSchema(database)
  ensureOptionalSkuSchema(database)
  ensureRecordDetailSchema(database)
  ensureRecordSafetySchema(database)
  const assignmentColumns = database.prepare('PRAGMA table_info(inventory_assignments)').all() as unknown as TableInfoRow[]
  if (!assignmentColumns.some(column => column.name === 'projectId')) {
    database.exec('ALTER TABLE inventory_assignments ADD COLUMN projectId TEXT REFERENCES inventory_projects(id)')
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_inventory_assignments_project ON inventory_assignments(projectId)')
  ensureWorkflowSchema(database)
  ensureClickUpSchema(database)
  ensureCatalogSchema(database)
  ensureReferenceInventorySchema(database)
  ensureLocationHierarchySchema(database)
  backfillLegacyRecordEvents(database)
  backfillLegacyReceipts(database)
  database.exec(`PRAGMA optimize;`)
}

function backfillLegacyRecordEvents(database: DatabaseSync) {
  database.exec(`
    INSERT INTO inventory_record_events
      (id, recordId, itemId, eventType, actorLabel, reason, afterJson, sourceReference, createdAt)
    SELECT
      'legacy-' || id,
      id,
      itemId,
      'legacy_import',
      'Legacy import',
      'Created automatically from the preserved pre-receiving inventory record.',
      json_object(
        'id', id, 'itemId', itemId, 'locationId', locationId, 'quantity', quantity,
        'quantityLabel', quantityLabel, 'state', state, 'condition', condition,
        'notes', notes, 'stockedAt', stockedAt
      ),
      sourceReference,
      createdAt
    FROM inventory_records
    WHERE NOT EXISTS (SELECT 1 FROM inventory_record_events event WHERE event.recordId = inventory_records.id);
  `)
}

function backfillLegacyReceipts(database: DatabaseSync) {
  database.exec(`
    INSERT OR IGNORE INTO inventory_receipts
      (id, receivedAt, receiverLabel, notes, sourceReference, createdAt, createdBy)
    SELECT
      'legacy-receipt-' || id,
      COALESCE(stockedAt, createdAt),
      'Legacy import',
      'Preserved from the inventory dataset that existed before the receiving journal was introduced.',
      sourceReference,
      createdAt,
      'legacy-import'
    FROM inventory_records
    WHERE sourceReference IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM inventory_receipt_lines line WHERE line.recordId = inventory_records.id);

    INSERT INTO inventory_receipt_lines
      (id, receiptId, recordId, itemId, locationId, quantity, quantityLabel, condition, discrepancy, notes, sourceReference, reviewRequired, createdAt)
    SELECT
      'legacy-line-' || id,
      'legacy-receipt-' || id,
      id,
      itemId,
      locationId,
      quantity,
      quantityLabel,
      condition,
      'none',
      notes,
      sourceReference,
      CASE WHEN quantity <= 0 THEN 1 ELSE 0 END,
      createdAt
    FROM inventory_records
    WHERE sourceReference IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM inventory_receipt_lines line WHERE line.recordId = inventory_records.id);
  `)
}

function ensureLocationHierarchySchema(database: DatabaseSync) {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(inventory_locations)`).all() as unknown as TableInfoRow[]).map((column) => column.name),
  )
  if (!columns.has('kind')) {
    database.exec(`ALTER TABLE inventory_locations ADD COLUMN kind TEXT NOT NULL DEFAULT 'room';`)
  }
  if (!columns.has('parentId')) {
    database.exec(`ALTER TABLE inventory_locations ADD COLUMN parentId TEXT;`)
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_locations_parent ON inventory_locations(parentId);`)
}

function hierarchyId(level: 'room' | 'fixture', key: string) {
  return `inventory-${level}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

function inferredLocationKind(
  location: Pick<InventoryLocation, 'fixtureCode' | 'rack' | 'rowCode' | 'bin' | 'parentId'> & { kind?: InventoryLocationKind },
) {
  if (location.parentId && location.kind && inventoryLocationKinds.includes(location.kind)) {
    return location.kind
  }
  if (location.rowCode || location.bin) {
    return 'container' as const
  }
  if (location.fixtureCode || location.rack) {
    return 'fixture' as const
  }
  return 'room' as const
}

function ensureLocationHierarchyData(database: DatabaseSync) {
  const rows = database.prepare(`SELECT * FROM inventory_locations ORDER BY createdAt, id`).all() as unknown as InventoryLocationRow[]
  if (rows.length === 0) return
  const rowsById = new Map(rows.map((row) => [row.id, row]))

  const timestamp = nowIso()
  const insertParent = database.prepare(
    `INSERT OR IGNORE INTO inventory_locations
     (id, name, code, kind, parentId, area, rack, bin, description, roomCode, roomName, fixtureCode, fixtureType, rowCode,
      planImagePath, photoPath, highlightX, highlightY, highlightWidth, highlightHeight, active, createdAt, updatedAt)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
  )
  const updateHierarchy = database.prepare(`UPDATE inventory_locations SET kind = ?, parentId = ? WHERE id = ?`)

  database.exec('BEGIN TRANSACTION;')
  try {
    for (const row of rows) {
      const kind = inferredLocationKind({
        kind: inventoryLocationKinds.includes(row.kind) ? row.kind : undefined,
        parentId: optionalText(row.parentId),
        fixtureCode: optionalText(row.fixtureCode),
        rack: optionalText(row.rack),
        rowCode: optionalText(row.rowCode),
        bin: optionalText(row.bin),
      })
      const existingParent = row.parentId ? rowsById.get(row.parentId) : undefined
      if (
        existingParent
        && ((kind === 'fixture' && existingParent.kind === 'room') || (kind === 'container' && existingParent.kind === 'fixture'))
      ) {
        updateHierarchy.run(kind, row.parentId, row.id)
        continue
      }
      if (kind === 'room') {
        updateHierarchy.run('room', null, row.id)
        continue
      }

      const roomKey = row.roomCode || row.roomName || row.area || 'unassigned'
      const roomId = hierarchyId('room', roomKey)
      insertParent.run(
        roomId,
        row.roomName || row.area || row.roomCode || 'Nicht zugeordneter Raum',
        'room',
        null,
        row.area,
        `Automatisch aus bestehenden Ortsdaten angelegt.`,
        row.roomCode,
        row.roomName,
        null,
        null,
        row.planImagePath,
        row.createdAt || timestamp,
        timestamp,
      )

      if (kind === 'fixture') {
        updateHierarchy.run('fixture', roomId, row.id)
        continue
      }

      const fixtureKey = `${roomKey}:${row.fixtureCode || row.rack || 'unassigned'}`
      const fixtureId = hierarchyId('fixture', fixtureKey)
      insertParent.run(
        fixtureId,
        [row.fixtureCode || row.rack, row.fixtureType].filter(Boolean).join(' · ') || 'Schrank / Regal',
        'fixture',
        roomId,
        row.area,
        `Automatisch aus bestehenden Fach- und Boxdaten angelegt.`,
        row.roomCode,
        row.roomName,
        row.fixtureCode || row.rack,
        row.fixtureType,
        row.planImagePath,
        row.createdAt || timestamp,
        timestamp,
      )
      updateHierarchy.run('container', fixtureId, row.id)
    }
    database
      .prepare(
        `DELETE FROM inventory_locations
         WHERE id LIKE 'inventory-fixture-%'
           AND NOT EXISTS (SELECT 1 FROM inventory_locations child WHERE child.parentId = inventory_locations.id)
           AND NOT EXISTS (SELECT 1 FROM inventory_records record WHERE record.locationId = inventory_locations.id)`,
      )
      .run()
    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function ensureReferenceRoomLocations(database: DatabaseSync) {
  // Room plans exist independently of stock. Run after the legacy hierarchy
  // repair so its existing room IDs and all child locations stay intact.
  const findRoom = database.prepare(
    `SELECT id FROM inventory_locations WHERE kind = 'room' AND (roomCode = ? OR code = ? OR id = ?) LIMIT 1`,
  )
  const findCode = database.prepare(`SELECT id FROM inventory_locations WHERE code = ? LIMIT 1`)
  const timestamp = nowIso()
  database.exec('BEGIN TRANSACTION;')
  try {
    for (const room of referenceInventory.rooms) {
      const id = hierarchyId('room', room.code)
      if (findRoom.get(room.code, room.code, id)) continue
      insertLocation(database, {
        id,
        name: room.name,
        code: findCode.get(room.code) ? '' : room.code,
        kind: 'room',
        area: room.name,
        roomCode: room.code,
        roomName: room.name,
        planImagePath: room.planImagePath,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function ensureReferenceInventorySchema(database: DatabaseSync) {
  const additions: Array<[string, string, string]> = [
    ['inventory_locations', 'roomCode', 'TEXT'],
    ['inventory_locations', 'roomName', 'TEXT'],
    ['inventory_locations', 'fixtureCode', 'TEXT'],
    ['inventory_locations', 'fixtureType', 'TEXT'],
    ['inventory_locations', 'rowCode', 'TEXT'],
    ['inventory_locations', 'planImagePath', 'TEXT'],
    ['inventory_locations', 'photoPath', 'TEXT'],
    ['inventory_locations', 'highlightX', 'REAL'],
    ['inventory_locations', 'highlightY', 'REAL'],
    ['inventory_locations', 'highlightWidth', 'REAL'],
    ['inventory_locations', 'highlightHeight', 'REAL'],
    ['inventory_items', 'value', 'TEXT'],
    ['inventory_items', 'manufacturerPartNumber', 'TEXT'],
    ['inventory_items', 'lcscPartNumber', 'TEXT'],
    ['inventory_items', 'packageForm', 'TEXT'],
    ['inventory_records', 'quantityLabel', 'TEXT'],
    ['inventory_records', 'photoPath', 'TEXT'],
    ['inventory_records', 'photoVerified', 'INTEGER NOT NULL DEFAULT 0'],
    ['inventory_records', 'sourceReference', 'TEXT'],
    ['inventory_receipt_lines', 'sourceRecordId', 'TEXT REFERENCES inventory_records(id)'],
  ]
  const columnsByTable = new Map<string, Set<string>>()
  for (const [table, column, type] of additions) {
    let columns = columnsByTable.get(table)
    if (!columns) {
      columns = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[]).map((item) => item.name),
      )
      columnsByTable.set(table, columns)
    }
    if (!columns.has(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`)
      columns.add(column)
    }
  }
}

function ensureUserAccountStateSchema(database: DatabaseSync) {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(inventory_users)`).all() as unknown as TableInfoRow[]).map((column) => column.name),
  )
  if (!columns.has('mustChangePassword')) {
    database.exec(`ALTER TABLE inventory_users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0;`)
  }
}

function ensureCredentialAlgorithmSchema(database: DatabaseSync) {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(inventory_user_credentials)`).all() as unknown as TableInfoRow[]).map((column) => column.name),
  )
  if (!columns.has('passwordAlgorithm')) {
    database.exec(`ALTER TABLE inventory_user_credentials ADD COLUMN passwordAlgorithm TEXT NOT NULL DEFAULT '${inventoryPasswordAlgorithm}';`)
  }
}

function ensureRecordDetailSchema(database: DatabaseSync) {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(inventory_records)`).all() as unknown as TableInfoRow[]).map((column) => column.name),
  )
  if (!columns.has('label')) {
    database.exec(`ALTER TABLE inventory_records ADD COLUMN label TEXT;`)
  }
  if (!columns.has('groupName')) {
    database.exec(`ALTER TABLE inventory_records ADD COLUMN groupName TEXT;`)
  }
}

function ensureRecordSafetySchema(database: DatabaseSync) {
  const recordColumns = new Set((database.prepare('PRAGMA table_info(inventory_records)').all() as unknown as TableInfoRow[]).map((column) => column.name))
  if (!recordColumns.has('version')) database.exec('ALTER TABLE inventory_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;')
  if (!recordColumns.has('quarantined')) database.exec('ALTER TABLE inventory_records ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;')
  const lineColumns = new Set((database.prepare('PRAGMA table_info(inventory_receipt_lines)').all() as unknown as TableInfoRow[]).map((column) => column.name))
  if (!lineColumns.has('releasedByEventId')) database.exec('ALTER TABLE inventory_receipt_lines ADD COLUMN releasedByEventId TEXT;')
}

function ensureOptionalLocationCodeSchema(database: DatabaseSync) {
  const codeColumn = (database.prepare(`PRAGMA table_info(inventory_locations)`).all() as unknown as TableInfoRow[]).find(
    (column) => column.name === 'code',
  )
  if (!codeColumn || codeColumn.notnull === 0) {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_locations_code_unique
        ON inventory_locations(code)
        WHERE code IS NOT NULL AND code != '';
    `)
    return
  }

  database.exec(`PRAGMA foreign_keys = OFF;`)
  try {
    database.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE inventory_locations RENAME TO inventory_locations_legacy_code;
      CREATE TABLE inventory_locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT,
        area TEXT,
        rack TEXT,
        bin TEXT,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO inventory_locations
        (id, name, code, area, rack, bin, description, active, createdAt, updatedAt)
        SELECT id, name, NULLIF(code, ''), area, rack, bin, description, active, createdAt, updatedAt
        FROM inventory_locations_legacy_code;
      DROP TABLE inventory_locations_legacy_code;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_locations_code_unique
        ON inventory_locations(code)
        WHERE code IS NOT NULL AND code != '';
      COMMIT;
    `)
  } catch (error) {
    try {
      database.exec(`ROLLBACK;`)
    } catch {
      // The migration may have failed before a transaction started.
    }
    throw error
  } finally {
    database.exec(`PRAGMA foreign_keys = ON;`)
  }
}

function ensureOptionalSkuSchema(database: DatabaseSync) {
  const skuColumn = (database.prepare(`PRAGMA table_info(inventory_items)`).all() as unknown as TableInfoRow[]).find(
    (column) => column.name === 'sku',
  )
  if (!skuColumn || skuColumn.notnull === 0) {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku_unique
        ON inventory_items(sku)
        WHERE sku IS NOT NULL AND sku != '';
    `)
    return
  }

  database.exec(`PRAGMA foreign_keys = OFF;`)
  try {
    database.exec(`
      BEGIN TRANSACTION;
      ALTER TABLE inventory_items RENAME TO inventory_items_legacy_sku;
      CREATE TABLE inventory_items (
        id TEXT PRIMARY KEY,
        sku TEXT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        manufacturer TEXT,
        model TEXT,
        unit TEXT NOT NULL,
        minQuantity REAL NOT NULL DEFAULT 0,
        reorderQuantity REAL NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO inventory_items
        (id, sku, name, category, description, manufacturer, model, unit, minQuantity, reorderQuantity, active, createdAt, updatedAt)
        SELECT id, NULLIF(sku, ''), name, category, description, manufacturer, model, unit, minQuantity, reorderQuantity, active, createdAt, updatedAt
        FROM inventory_items_legacy_sku;
      DROP TABLE inventory_items_legacy_sku;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku_unique
        ON inventory_items(sku)
        WHERE sku IS NOT NULL AND sku != '';
      COMMIT;
    `)
  } catch (error) {
    try {
      database.exec(`ROLLBACK;`)
    } catch {
      // The migration may have failed before a transaction started.
    }
    throw error
  } finally {
    database.exec(`PRAGMA foreign_keys = ON;`)
  }
}

function tableCount(database: DatabaseSync, table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as CountRow).count
}

function seedIfEmpty(database: DatabaseSync) {
  if (tableCount(database, 'inventory_users') > 0) {
    return
  }

  if (process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD) {
    return
  }

  const createdAt = nowIso()
  insertUser(database, {
    id: 'inventory-user-admin',
    name: 'Admin',
    email: 'admin@inventory.local',
    role: 'admin',
    active: true,
    mustChangePassword: false,
    createdAt,
    updatedAt: createdAt,
  })
}

function ensureReferenceInventory(database: DatabaseSync) {
  const locationIds = new Map<string, string>()
  const itemIds = new Map<string, string>()
  database.exec('BEGIN TRANSACTION;')
  try {
    for (const location of referenceInventory.locations) {
      const existing = database
        .prepare(`SELECT id FROM inventory_locations WHERE id = ? OR (? != '' AND code = ?) LIMIT 1`)
        .get(location.id, location.code, location.code) as unknown as IdRow | undefined
      if (!existing) {
        insertLocation(database, location)
        locationIds.set(location.id, location.id)
      } else {
        locationIds.set(location.id, existing.id)
        if (location.id.startsWith('reference-location-container-row-') && location.parentId) {
          database
            .prepare(
              `UPDATE inventory_locations
               SET kind = 'container', parentId = ?, updatedAt = ?
               WHERE id = ? AND parentId LIKE 'inventory-fixture-%'`,
            )
            .run(location.parentId, nowIso(), existing.id)
        }
      }
    }

    for (const row of referenceInventory.rows) {
      const existingItem = database
        .prepare(`SELECT id FROM inventory_items WHERE id = ? OR sku = ? LIMIT 1`)
        .get(row.item.id, row.item.sku) as unknown as IdRow | undefined
      if (!existingItem) {
        insertItem(database, row.item)
        itemIds.set(row.item.id, row.item.id)
      } else {
        itemIds.set(row.item.id, existingItem.id)
        if (row.record.locationId.startsWith('reference-location-container-row-')) {
          database
            .prepare(
              `UPDATE inventory_items
               SET name = ?, updatedAt = ?
               WHERE id = ? AND (lower(name) LIKE '%bin label%' OR lower(name) LIKE 'bin labeled%')`,
            )
            .run(row.item.name, nowIso(), existingItem.id)
        }
      }

      const recordExists = database.prepare(`SELECT id FROM inventory_records WHERE id = ?`).get(row.record.id) as unknown as IdRow | undefined
      if (!recordExists) {
        insertRecord(database, {
          ...row.record,
          itemId: itemIds.get(row.record.itemId) ?? row.record.itemId,
          locationId: locationIds.get(row.record.locationId) ?? row.record.locationId,
        })
      } else {
        const targetLocation = referenceInventory.locations.find((location) => location.id === row.record.locationId)
        if (targetLocation?.parentId && row.record.locationId.startsWith('reference-location-container-row-')) {
          database
            .prepare(
              `UPDATE inventory_records
               SET locationId = ?, photoPath = CASE WHEN photoPath = ? THEN NULL ELSE photoPath END, updatedAt = ?, version = version + 1
               WHERE id = ? AND locationId = ?`,
            )
            .run(row.record.locationId, targetLocation.photoPath ?? null, nowIso(), row.record.id, targetLocation.parentId)
        }
        database
          .prepare(
            `UPDATE inventory_records
             SET label = ?, updatedAt = ?, version = version + 1
             WHERE id = ? AND COALESCE(label, '') != COALESCE(?, '')`,
          )
          .run(row.record.label ?? null, row.record.updatedAt, row.record.id, row.record.label ?? null)
      }
    }

    for (const removed of referenceInventory.removedInventoryRows ?? []) {
      database.prepare(`DELETE FROM inventory_records WHERE id = ? AND itemId = ?`).run(removed.recordId, removed.itemId)
      database
        .prepare(`DELETE FROM inventory_items WHERE id = ? AND NOT EXISTS (SELECT 1 FROM inventory_records WHERE itemId = ?)`)
        .run(removed.itemId, removed.itemId)
    }
    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function ensureBootstrapAdminFromEnv(database: DatabaseSync) {
  const password = process.env.INVENTORY_SYSTEM_ADMIN_PASSWORD
  if (!password) {
    return
  }

  const email = parseString(process.env.INVENTORY_SYSTEM_ADMIN_EMAIL, 180).toLowerCase() || 'admin@inventory.local'
  const name = parseString(process.env.INVENTORY_SYSTEM_ADMIN_NAME, 160) || 'Admin'
  const existing = userByEmailFromDatabase(database, email)
  const user = existing
    ? {
        ...existing,
        name,
        role: 'admin' as const,
        active: true,
        updatedAt: nowIso(),
      }
    : ({
        id: 'inventory-user-admin',
        name,
        email,
        role: 'admin',
        active: true,
        mustChangePassword: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } satisfies InventoryUser)

  if (existing) {
    updateUser(database, user)
  } else {
    insertUser(database, user)
  }

  const existingCredential = credentialForUserIdFromDatabase(database, user.id)
  if (!existingCredential || process.env.INVENTORY_SYSTEM_FORCE_ADMIN_PASSWORD === 'true') {
    setUserPassword(database, user.id, password, user, { allowUnsafe: process.env.INVENTORY_SYSTEM_ALLOW_UNSAFE_ADMIN_PASSWORD === 'true' })
  }
}

export function generateInventoryAdminPassword() {
  return generateInventoryPassword()
}

export function generateInventoryPassword() {
  return `Z9!a-${randomToken(24)}`
}

export function setInventoryAdminPassword({
  email = 'admin@inventory.local',
  name = 'Admin',
  password,
}: {
  email?: string
  name?: string
  password: string
}) {
  validatePassword(password, email, name)
  const database = connection()
  const normalizedEmail = parseString(email, 180).toLowerCase()
  const existing = userByEmailFromDatabase(database, normalizedEmail)
  const now = nowIso()
  const user = existing
    ? {
        ...existing,
        name: parseString(name, 160) || existing.name,
        role: 'admin' as const,
        active: true,
        updatedAt: now,
      }
    : ({
        id: 'inventory-user-admin',
        name: parseString(name, 160) || 'Admin',
        email: normalizedEmail,
        role: 'admin',
        active: true,
        mustChangePassword: false,
        createdAt: now,
        updatedAt: now,
      } satisfies InventoryUser)

  if (existing) {
    updateUser(database, user)
  } else {
    insertUser(database, user)
  }
  setUserPassword(database, user.id, password, user)
  return user
}

export function upsertInventoryUserWithPassword({
  name,
  email,
  role,
  password,
  active = true,
  mustChangePassword = true,
}: {
  name: string
  email: string
  role: InventoryRole
  password?: string
  active?: boolean
  mustChangePassword?: boolean
}) {
  const database = connection()
  const normalizedEmail = parseString(email, 180).toLowerCase()
  const existing = userByEmailFromDatabase(database, normalizedEmail)
  const now = nowIso()
  const user: InventoryUser = existing
    ? {
        ...existing,
        name: parseString(name, 160) || existing.name,
        role,
        active,
        mustChangePassword: password ? mustChangePassword : existing.mustChangePassword,
        updatedAt: now,
      }
    : {
        id: randomUUID(),
        name: parseString(name, 160),
        email: normalizedEmail,
        role,
        active,
        mustChangePassword,
        createdAt: now,
        updatedAt: now,
      }

  if (!user.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) {
    throw new Error('A valid user name and email are required.')
  }

  if (existing) {
    updateUser(database, user)
  } else {
    insertUser(database, user)
  }
  if (password) {
    setUserPassword(database, user.id, password, user)
  }
  return user
}

export interface SharedUserbaseUser {
  id: string
  name: string
  email: string
  role: string
  active: boolean
  mustChangePassword: boolean
  passwordSalt: string
  passwordHash: string
  passwordAlgorithm: string
}

export function importSharedUserbase(users: SharedUserbaseUser[]) {
  const database = connection()
  const now = nowIso()
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const source of users) {
    const email = parseString(source.email, 180).toLowerCase()
    const name = parseString(source.name, 160)
    if (!source.id || !email || !name || !source.passwordHash || !source.passwordSalt || source.passwordAlgorithm !== timePasswordAlgorithm) {
      skipped += 1
      continue
    }

    const existingByEmail = userByEmailFromDatabase(database, email)
    const existingById = existingByEmail ? undefined : userByIdFromDatabase(database, source.id)
    const existing = existingByEmail ?? existingById
    const role: InventoryRole = source.role === 'admin' ? 'admin' : existing?.role ?? 'viewer'
    const user: InventoryUser = existing
      ? {
          ...existing,
          name,
          email,
          role,
          active: source.active,
          mustChangePassword: source.mustChangePassword,
          updatedAt: now,
        }
      : {
          id: source.id,
          name,
          email,
          role,
          active: source.active,
          mustChangePassword: source.mustChangePassword,
          createdAt: now,
          updatedAt: now,
        }

    if (existing) {
      updateUser(database, user)
      updated += 1
    } else {
      insertUser(database, user)
      inserted += 1
    }
    setImportedTimePassword(database, user.id, source.passwordHash, source.passwordSalt)
  }

  return { inserted, updated, skipped }
}

function parseJsonDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function optionalText(value: string | null) {
  return value && value.length > 0 ? value : undefined
}

function rowToUser(row: InventoryUserRow): InventoryUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function userByEmailFromDatabase(database: DatabaseSync, email: string) {
  const row = database.prepare(`SELECT * FROM inventory_users WHERE email = ?`).get(email) as unknown as InventoryUserRow | undefined
  return row ? rowToUser(row) : undefined
}

function userByIdFromDatabase(database: DatabaseSync, id: string) {
  const row = database.prepare(`SELECT * FROM inventory_users WHERE id = ?`).get(id) as unknown as InventoryUserRow | undefined
  return row ? rowToUser(row) : undefined
}

function credentialForUserIdFromDatabase(database: DatabaseSync, userId: string) {
  return database
    .prepare(`SELECT * FROM inventory_user_credentials WHERE userId = ?`)
    .get(userId) as unknown as InventoryCredentialRow | undefined
}

function cleanupExpiredSessions(database: DatabaseSync) {
  database.prepare(`DELETE FROM inventory_sessions WHERE expiresAt <= ?`).run(nowIso())
  database.prepare(`DELETE FROM inventory_qr_login_grants WHERE expiresAt <= ? OR usedAt IS NOT NULL`).run(nowIso())
  database.prepare(`DELETE FROM inventory_qr_login_challenges WHERE expiresAt <= ? OR usedAt IS NOT NULL`).run(nowIso())
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('base64url')
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function passwordPolicyErrors(password: string, email = '', name = '') {
  const errors: string[] = []
  const lowerPassword = password.toLowerCase()
  const emailName = email.split('@')[0]?.toLowerCase() ?? ''
  const nameParts = name.toLowerCase().split(/\s+/).filter(Boolean)
  const weakFragments = ['password', 'passwort', 'inventory', 'inventar', 'admin', 'welcome', 'qwerty', '123456']

  if (password.length < 14) errors.push('Use at least 14 characters.')
  if (password.length > 256) errors.push('Use no more than 256 characters.')
  if (!/[a-z]/.test(password)) errors.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) errors.push('Add an uppercase letter.')
  if (!/\d/.test(password)) errors.push('Add a number.')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Add a symbol.')
  if (emailName && lowerPassword.includes(emailName)) errors.push('Do not include your email name.')
  if (nameParts.some((part) => part.length >= 3 && lowerPassword.includes(part))) {
    errors.push('Do not include your name.')
  }
  if (weakFragments.some((fragment) => lowerPassword.includes(fragment))) {
    errors.push('Avoid common password words.')
  }
  if (/([a-zA-Z0-9])\1{2,}/.test(password)) errors.push('Avoid repeated characters.')

  return errors
}

function validatePassword(password: string, email = '', name = '') {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) {
    throw new Error('Password must be between 14 and 256 characters.')
  }
  const errors = passwordPolicyErrors(password, email, name)
  if (errors.length > 0) {
    throw new Error(`Password is not strong enough: ${errors.join(' ')}`)
  }
}

function passwordFromBody(body: Record<string, unknown>, required: boolean, email = '', name = '') {
  const value = body.password
  if ((value === undefined || value === null || value === '') && !required) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Password is required.')
  }
  validatePassword(value, email, name)
  return value
}

function passwordHash(password: string, salt = randomToken(24)) {
  const hash = scryptSync(password, salt, passwordKeyLength, passwordScryptOptions).toString('base64url')
  return { hash, salt }
}

function setUserPassword(
  database: DatabaseSync,
  userId: string,
  password: string,
  user?: Pick<InventoryUser, 'email' | 'name'>,
  options: { allowUnsafe?: boolean } = {},
) {
  if (!options.allowUnsafe) {
    validatePassword(password, user?.email, user?.name)
  }
  const { hash, salt } = passwordHash(password)
  const updatedAt = nowIso()
  database
    .prepare(
      `INSERT INTO inventory_user_credentials
       (userId, passwordHash, passwordSalt, passwordAlgorithm, passwordUpdatedAt, failedAttempts, lockedUntil)
       VALUES (?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(userId) DO UPDATE SET
         passwordHash = excluded.passwordHash,
         passwordSalt = excluded.passwordSalt,
         passwordAlgorithm = excluded.passwordAlgorithm,
         passwordUpdatedAt = excluded.passwordUpdatedAt,
         failedAttempts = 0,
         lockedUntil = NULL`,
    )
    .run(userId, hash, salt, inventoryPasswordAlgorithm, updatedAt)
}

function setImportedTimePassword(database: DatabaseSync, userId: string, passwordHashValue: string, passwordSalt: string) {
  const updatedAt = nowIso()
  database
    .prepare(
      `INSERT INTO inventory_user_credentials
       (userId, passwordHash, passwordSalt, passwordAlgorithm, passwordUpdatedAt, failedAttempts, lockedUntil)
       VALUES (?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(userId) DO UPDATE SET
         passwordHash = excluded.passwordHash,
         passwordSalt = excluded.passwordSalt,
         passwordAlgorithm = excluded.passwordAlgorithm,
         passwordUpdatedAt = excluded.passwordUpdatedAt,
         failedAttempts = 0,
         lockedUntil = NULL`,
    )
    .run(userId, passwordHashValue, passwordSalt, timePasswordAlgorithm, updatedAt)
}

function verifyTimePassword(password: string, credential: InventoryCredentialRow) {
  const expected = Buffer.from(credential.passwordHash, 'hex')
  const current = pbkdf2Sync(password, credential.passwordSalt, 310_000, 32, 'sha256')
  const legacy = pbkdf2Sync(password, credential.passwordSalt, 100_000, 32, 'sha256')
  return (
    expected.length === current.length && timingSafeEqual(expected, current) ||
    expected.length === legacy.length && timingSafeEqual(expected, legacy)
  )
}

function verifyPassword(password: string, credential: InventoryCredentialRow) {
  if (credential.passwordAlgorithm === timePasswordAlgorithm) {
    return verifyTimePassword(password, credential)
  }

  const expected = Buffer.from(credential.passwordHash, 'base64url')
  const actual = Buffer.from(passwordHash(password, credential.passwordSalt).hash, 'base64url')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function performFakePasswordCheck(password: string) {
  scryptSync(password, 'inventory-system-missing-user', passwordKeyLength, passwordScryptOptions)
}

function readUsers() {
  return (connection().prepare(`SELECT * FROM inventory_users ORDER BY active DESC, role, name`).all() as unknown as InventoryUserRow[]).map(rowToUser)
}

function readLocations() {
  return (
    connection().prepare(`SELECT * FROM inventory_locations ORDER BY active DESC, name, code`).all() as unknown as InventoryLocationRow[]
  ).map(rowToLocation)
}

function rowToLocation(row: InventoryLocationRow): InventoryLocation {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? '',
    kind: inventoryLocationKinds.includes(row.kind) ? row.kind : 'room',
    parentId: optionalText(row.parentId),
    area: optionalText(row.area),
    rack: optionalText(row.rack),
    bin: optionalText(row.bin),
    description: optionalText(row.description),
    roomCode: optionalText(row.roomCode),
    roomName: optionalText(row.roomName),
    fixtureCode: optionalText(row.fixtureCode),
    fixtureType: optionalText(row.fixtureType),
    rowCode: optionalText(row.rowCode),
    planImagePath: optionalText(row.planImagePath),
    photoPath: optionalText(row.photoPath),
    highlightX: row.highlightX ?? undefined,
    highlightY: row.highlightY ?? undefined,
    highlightWidth: row.highlightWidth ?? undefined,
    highlightHeight: row.highlightHeight ?? undefined,
    active: Boolean(row.active),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function readItems() {
  const details = readCatalogDetails(connection())
  return (connection().prepare(`SELECT * FROM inventory_items ORDER BY active DESC, category, name`).all() as unknown as InventoryItemRow[]).map(
    (row): InventoryItemDefinition => ({
      ...details.get(row.id),
      id: row.id,
      sku: row.sku ?? '',
      name: row.name,
      category: row.category,
      description: optionalText(row.description),
      manufacturer: optionalText(row.manufacturer),
      model: optionalText(row.model),
      value: optionalText(row.value),
      manufacturerPartNumber: optionalText(row.manufacturerPartNumber),
      lcscPartNumber: optionalText(row.lcscPartNumber),
      packageForm: optionalText(row.packageForm),
      unit: row.unit,
      minQuantity: row.minQuantity,
      reorderQuantity: row.reorderQuantity,
      active: Boolean(row.active),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  )
}

function readRecords() {
  return (
    connection()
      .prepare(`SELECT * FROM inventory_records ORDER BY updatedAt DESC, state, createdAt DESC`)
      .all() as unknown as InventoryRecordRow[]
  ).map(rowToRecord)
}

function readActivityRange(fromIso: string, toIso: string, limit = 500) {
  return (
    connection()
      .prepare(`SELECT * FROM inventory_activity WHERE createdAt >= ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?`)
      .all(fromIso, toIso, limit) as unknown as InventoryActivityRow[]
  ).map(rowToActivity)
}

function readReceipts(fromIso = '0000-01-01T00:00:00.000Z', toIso = '9999-12-31T23:59:59.999Z', limit = 1000) {
  return (connection().prepare(
    `SELECT * FROM inventory_receipts WHERE receivedAt >= ? AND receivedAt < ? ORDER BY receivedAt DESC, createdAt DESC LIMIT ?`,
  ).all(fromIso, toIso, limit) as unknown as InventoryReceiptRow[]).map((row): InventoryReceipt => ({
    id: row.id,
    receivedAt: row.receivedAt,
    supplier: optionalText(row.supplier),
    orderReference: optionalText(row.orderReference),
    deliveryNoteNumber: optionalText(row.deliveryNoteNumber),
    receiverId: optionalText(row.receiverId),
    receiverLabel: optionalText(row.receiverLabel),
    notes: optionalText(row.notes),
    attachmentName: optionalText(row.attachmentName),
    attachmentPath: optionalText(row.attachmentPath),
    sourceReference: optionalText(row.sourceReference),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }))
}

function readReceiptLines(receiptIds?: string[]) {
  if (receiptIds && receiptIds.length === 0) return []
  const rows = receiptIds
    ? connection().prepare(`SELECT * FROM inventory_receipt_lines WHERE receiptId IN (${receiptIds.map(() => '?').join(',')}) ORDER BY createdAt DESC`).all(...receiptIds)
    : connection().prepare(`SELECT * FROM inventory_receipt_lines ORDER BY createdAt DESC LIMIT 5000`).all()
  return (rows as unknown as InventoryReceiptLineRow[]).map((row): InventoryReceiptLine => {
    const record = recordById(row.recordId)
    return {
      id: row.id,
      receiptId: row.receiptId,
      recordId: row.recordId,
      itemId: row.itemId,
      locationId: row.locationId,
      quantity: row.quantity,
      quantityLabel: optionalText(row.quantityLabel),
      condition: row.condition,
      discrepancy: inventoryReceiptDiscrepancies.includes(row.discrepancy) ? row.discrepancy : 'none',
      discrepancyQuantity: row.discrepancyQuantity ?? undefined,
      notes: optionalText(row.notes),
      barcode: optionalText(row.barcode),
      sourceReference: optionalText(row.sourceReference),
      reviewRequired: Boolean(row.reviewRequired),
      reversedByEventId: optionalText(row.reversedByEventId),
      releasedByEventId: optionalText(row.releasedByEventId),
      sourceRecordId: optionalText(row.sourceRecordId),
      currentVersion: record?.version ?? 0,
      quarantined: record?.quarantined ?? false,
      currentQuantity: record?.quantity,
      currentLocationId: record?.locationId,
      adjustments: (connection().prepare(`SELECT * FROM inventory_record_events WHERE recordId = ? AND eventType IN ('corrected','reversed') ORDER BY createdAt, id`).all(row.recordId) as unknown as InventoryRecordEventRow[]).map((event) => ({
        id: event.id, type: event.eventType as 'corrected' | 'reversed', createdAt: event.createdAt,
        quantityBefore: event.beforeJson ? parseOptionalNumber(parseJsonDetails(event.beforeJson).quantity) : undefined,
        quantityAfter: event.afterJson ? parseOptionalNumber(parseJsonDetails(event.afterJson).quantity) : undefined,
        reason: optionalText(event.reason), actor: optionalText(event.actorLabel),
      })),
      createdAt: row.createdAt,
    }
  })
}

function readRecordEvents(limit = 5000) {
  return (connection().prepare(`SELECT * FROM inventory_record_events ORDER BY createdAt DESC LIMIT ?`).all(limit) as unknown as InventoryRecordEventRow[])
    .map((row): InventoryRecordEvent => ({
      id: row.id,
      recordId: row.recordId,
      itemId: row.itemId,
      eventType: row.eventType,
      actorId: optionalText(row.actorId),
      actorLabel: optionalText(row.actorLabel),
      reason: optionalText(row.reason),
      before: row.beforeJson ? parseJsonDetails(row.beforeJson) : undefined,
      after: row.afterJson ? parseJsonDetails(row.afterJson) : undefined,
      receiptLineId: optionalText(row.receiptLineId),
      sourceReference: optionalText(row.sourceReference),
      createdAt: row.createdAt,
    }))
}

function readQrLabels() {
  return (connection().prepare(`SELECT * FROM inventory_qr_labels ORDER BY active DESC, updatedAt DESC, name`).all() as unknown as InventoryQrLabelRow[])
    .map((row): InventoryQrLabel => ({
      id: row.id,
      name: row.name,
      targetType: row.targetType,
      targetId: row.targetId,
      active: Boolean(row.active),
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
}

function rowToActivity(row: InventoryActivityRow): InventoryActivity {
  return {
    id: row.id,
    itemId: optionalText(row.itemId),
    recordId: optionalText(row.recordId),
    actorId: row.actorId,
    action: row.action,
    details: parseJsonDetails(row.details),
    createdAt: row.createdAt,
  }
}

function currentMonthRange() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { fromIso: start.toISOString(), toIso: end.toISOString() }
}

function readTags() {
  return (connection().prepare(`SELECT * FROM inventory_tags ORDER BY name`).all() as unknown as InventoryTagRow[]).map(
    (row): InventoryTag => ({
      id: row.id,
      name: row.name,
      color: row.color,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  )
}

function readCategoryTags() {
  return (
    connection().prepare(`SELECT * FROM inventory_category_tags ORDER BY category, tagId`).all() as unknown as InventoryCategoryTagRow[]
  ).map((row): InventoryCategoryTag => ({ category: row.category, tagId: row.tagId }))
}

function readRecordTags() {
  return (connection().prepare(`SELECT * FROM inventory_record_tags ORDER BY recordId, tagId`).all() as unknown as InventoryRecordTagRow[]).map(
    (row): InventoryRecordTag => ({ recordId: row.recordId, tagId: row.tagId }),
  )
}

function readProjects(): InventoryProject[] {
  const rows = connection().prepare('SELECT * FROM inventory_projects ORDER BY active DESC, name COLLATE NOCASE').all()
  return rows.map(row => ({ ...row, active: Boolean(row.active), description: optionalText(row.description as string | null) })) as unknown as InventoryProject[]
}

function readAssignments() {
  return (
    connection()
      .prepare(`SELECT * FROM inventory_assignments ORDER BY returnedAt IS NOT NULL, assignedAt DESC`)
      .all() as unknown as InventoryAssignmentRow[]
  ).map(
    (row): InventoryAssignment => ({
      id: row.id,
      recordId: row.recordId,
      userId: row.userId,
      projectId: optionalText(row.projectId),
      buildId: optionalText(row.buildId),
      requestId: optionalText(row.requestId),
      consumedQuantity: row.consumedQuantity,
      quantity: Math.max(0, Math.round((row.quantity - row.consumedQuantity) * 1e6) / 1e6),
      notes: optionalText(row.notes),
      assignedAt: row.assignedAt,
      returnedAt: optionalText(row.returnedAt),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  )
}

function tagById(id: string) {
  const row = connection().prepare(`SELECT * FROM inventory_tags WHERE id = ?`).get(id) as unknown as InventoryTagRow | undefined
  return row
    ? ({
        id: row.id,
        name: row.name,
        color: row.color,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies InventoryTag)
    : undefined
}

function parseTagIds(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return Array.from(new Set(value.map((item) => parseString(item, 120)).filter(Boolean))).filter((tagId) => tagById(tagId))
}

function setCategoryTags(database: DatabaseSync, category: string, tagIds: string[]) {
  database.prepare(`DELETE FROM inventory_category_tags WHERE category = ?`).run(category)
  const insert = database.prepare(`INSERT OR IGNORE INTO inventory_category_tags (category, tagId) VALUES (?, ?)`)
  tagIds.forEach((tagId) => insert.run(category, tagId))
}

function setRecordTags(database: DatabaseSync, recordId: string, tagIds: string[]) {
  database.prepare(`DELETE FROM inventory_record_tags WHERE recordId = ?`).run(recordId)
  const insert = database.prepare(`INSERT OR IGNORE INTO inventory_record_tags (recordId, tagId) VALUES (?, ?)`)
  tagIds.forEach((tagId) => insert.run(recordId, tagId))
}

function rowToRecord(row: InventoryRecordRow): InventoryRecord {
  return {
    id: row.id,
    version: row.version,
    quarantined: Boolean(row.quarantined),
    itemId: row.itemId,
    locationId: row.locationId,
    label: optionalText(row.label),
    groupName: optionalText(row.groupName),
    quantity: row.quantity,
    quantityLabel: optionalText(row.quantityLabel),
    state: row.state,
    condition: row.condition,
    assetTag: optionalText(row.assetTag),
    serialNumber: optionalText(row.serialNumber),
    lotNumber: optionalText(row.lotNumber),
    supplier: optionalText(row.supplier),
    orderReference: optionalText(row.orderReference),
    unitCost: row.unitCost ?? undefined,
    requestedBy: optionalText(row.requestedBy),
    orderedBy: optionalText(row.orderedBy),
    receivedBy: optionalText(row.receivedBy),
    lastCountedBy: optionalText(row.lastCountedBy),
    notes: optionalText(row.notes),
    photoPath: optionalText(row.photoPath),
    photoVerified: Boolean(row.photoVerified),
    sourceReference: optionalText(row.sourceReference),
    dueDate: optionalText(row.dueDate),
    requestedAt: optionalText(row.requestedAt),
    orderedAt: optionalText(row.orderedAt),
    deliveredAt: optionalText(row.deliveredAt),
    stockedAt: optionalText(row.stockedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function insertUser(database: DatabaseSync, user: InventoryUser) {
  database
    .prepare(
      `INSERT INTO inventory_users (id, name, email, role, active, mustChangePassword, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(user.id, user.name, user.email, user.role, user.active ? 1 : 0, user.mustChangePassword ? 1 : 0, user.createdAt, user.updatedAt)
}

function insertLocation(
  database: DatabaseSync,
  location: InventoryLocation | (Omit<InventoryLocation, 'kind' | 'parentId'> & { kind?: InventoryLocationKind; parentId?: string }),
) {
  const kind = inferredLocationKind({ ...location, parentId: location.parentId })
  database
    .prepare(
      `INSERT INTO inventory_locations
       (id, name, code, kind, parentId, area, rack, bin, description, roomCode, roomName, fixtureCode, fixtureType, rowCode,
        planImagePath, photoPath, highlightX, highlightY, highlightWidth, highlightHeight, active, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      location.id,
      location.name,
      location.code || null,
      kind,
      location.parentId ?? null,
      location.area ?? null,
      location.rack ?? null,
      location.bin ?? null,
      location.description ?? null,
      location.roomCode ?? null,
      location.roomName ?? null,
      location.fixtureCode ?? null,
      location.fixtureType ?? null,
      location.rowCode ?? null,
      location.planImagePath ?? null,
      location.photoPath ?? null,
      location.highlightX ?? null,
      location.highlightY ?? null,
      location.highlightWidth ?? null,
      location.highlightHeight ?? null,
      location.active ? 1 : 0,
      location.createdAt,
      location.updatedAt,
    )
}

function insertItem(database: DatabaseSync, item: InventoryItemDefinition) {
  database
    .prepare(
      `INSERT INTO inventory_items
       (id, sku, name, category, description, manufacturer, model, value, manufacturerPartNumber, lcscPartNumber, packageForm,
        unit, minQuantity, reorderQuantity, active, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.sku || null,
      item.name,
      item.category,
      item.description ?? null,
      item.manufacturer ?? null,
      item.model ?? null,
      item.value ?? null,
      item.manufacturerPartNumber ?? null,
      item.lcscPartNumber ?? null,
      item.packageForm ?? null,
      item.unit,
      item.minQuantity,
      item.reorderQuantity,
      item.active ? 1 : 0,
      item.createdAt,
      item.updatedAt,
    )
  writeCatalogDetails(database, item)
}

function insertRecord(database: DatabaseSync, record: InventoryRecord) {
  database
    .prepare(
      `INSERT INTO inventory_records
       (id, itemId, locationId, label, groupName, quantity, quantityLabel, state, condition, assetTag, serialNumber, lotNumber, supplier, orderReference, unitCost,
        requestedBy, orderedBy, receivedBy, lastCountedBy, notes, photoPath, photoVerified, sourceReference, dueDate, requestedAt, orderedAt, deliveredAt, stockedAt,
        createdAt, updatedAt, version, quarantined)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.itemId,
      record.locationId,
      record.label ?? null,
      record.groupName ?? null,
      record.quantity,
      record.quantityLabel ?? null,
      record.state,
      record.condition,
      record.assetTag ?? null,
      record.serialNumber ?? null,
      record.lotNumber ?? null,
      record.supplier ?? null,
      record.orderReference ?? null,
      record.unitCost ?? null,
      record.requestedBy ?? null,
      record.orderedBy ?? null,
      record.receivedBy ?? null,
      record.lastCountedBy ?? null,
      record.notes ?? null,
      record.photoPath ?? null,
      record.photoVerified ? 1 : 0,
      record.sourceReference ?? null,
      record.dueDate ?? null,
      record.requestedAt ?? null,
      record.orderedAt ?? null,
      record.deliveredAt ?? null,
      record.stockedAt ?? null,
      record.createdAt,
      record.updatedAt,
      1,
      record.quarantined ? 1 : 0,
    )
}

function insertActivity(database: DatabaseSync, activity: InventoryActivity) {
  database
    .prepare(
      `INSERT INTO inventory_activity (id, itemId, recordId, actorId, action, details, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      activity.id,
      activity.itemId ?? null,
      activity.recordId ?? null,
      activity.actorId,
      activity.action,
      JSON.stringify(activity.details),
      activity.createdAt,
    )
}

function insertRecordEvent(database: DatabaseSync, event: InventoryRecordEvent) {
  database.prepare(
    `INSERT INTO inventory_record_events
      (id, recordId, itemId, eventType, actorId, actorLabel, reason, beforeJson, afterJson, receiptLineId, sourceReference, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.recordId,
    event.itemId,
    event.eventType,
    event.actorId ?? null,
    event.actorLabel ?? null,
    event.reason ?? null,
    event.before ? JSON.stringify(event.before) : null,
    event.after ? JSON.stringify(event.after) : null,
    event.receiptLineId ?? null,
    event.sourceReference ?? null,
    event.createdAt,
  )
}

function auditRecordChange(
  database: DatabaseSync,
  actor: InventoryUser,
  eventType: InventoryRecordEvent['eventType'],
  record: InventoryRecord,
  before?: InventoryRecord,
  reason?: string,
  receiptLineId?: string,
) {
  const eventId = randomUUID()
  insertRecordEvent(database, {
    id: eventId,
    recordId: record.id,
    itemId: record.itemId,
    eventType,
    actorId: actor.id,
    actorLabel: actor.name,
    reason,
    before: before ? { ...before } : undefined,
    after: { ...record },
    receiptLineId,
    sourceReference: record.sourceReference,
    createdAt: nowIso(),
  })
  return eventId
}

function insertTag(database: DatabaseSync, tag: InventoryTag) {
  database
    .prepare(`INSERT INTO inventory_tags (id, name, color, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`)
    .run(tag.id, tag.name, tag.color, tag.createdAt, tag.updatedAt)
}

function insertAssignment(database: DatabaseSync, assignment: InventoryAssignment) {
  database
    .prepare(
      `INSERT INTO inventory_assignments
       (id, recordId, userId, projectId, quantity, notes, assignedAt, returnedAt, createdAt, updatedAt, buildId, requestId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      assignment.id,
      assignment.recordId,
      assignment.userId,
      assignment.projectId ?? null,
      assignment.quantity,
      assignment.notes ?? null,
      assignment.assignedAt,
      assignment.returnedAt ?? null,
      assignment.createdAt,
      assignment.updatedAt,
      assignment.buildId ?? null,
      assignment.requestId ?? null,
    )
}

function logActivity(
  database: DatabaseSync,
  actor: InventoryUser,
  action: string,
  details: Record<string, unknown>,
  itemId?: string,
  recordId?: string,
) {
  insertActivity(database, {
    id: randomUUID(),
    itemId,
    recordId,
    actorId: actor.id,
    action,
    details,
    createdAt: nowIso(),
  })
}

function parseString(value: unknown, maxLength = 220) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function parseOptionalString(value: unknown, maxLength = 500) {
  const parsed = parseString(value, maxLength)
  return parsed.length > 0 ? parsed : undefined
}

function parseNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === true || value === 'true' || value === '1' || value === 1) {
    return true
  }
  if (value === false || value === 'false' || value === '0' || value === 0) {
    return false
  }
  return fallback
}

function parseDate(value: unknown) {
  const parsed = parseString(value, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : undefined
}

function parseIsoDateTime(value: unknown, fallback: string) {
  const parsed = parseString(value, 40)
  if (!parsed) return fallback
  const date = new Date(parsed)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function parseHexColor(value: unknown) {
  const parsed = parseString(value, 20)
  return /^#[0-9a-f]{6}$/i.test(parsed) ? parsed.toLowerCase() : '#0f766e'
}

function parseRole(value: unknown, fallback: InventoryRole): InventoryRole {
  return inventoryRoles.includes(value as InventoryRole) ? (value as InventoryRole) : fallback
}

function parseState(value: unknown, fallback: InventoryState): InventoryState {
  return inventoryStates.includes(value as InventoryState) ? (value as InventoryState) : fallback
}

function parseCondition(value: unknown, fallback: InventoryCondition): InventoryCondition {
  return inventoryConditions.includes(value as InventoryCondition) ? (value as InventoryCondition) : fallback
}

function parseQrTargetType(value: unknown, fallback: InventoryQrTargetType = 'item'): InventoryQrTargetType {
  return ['record', 'item', 'category', 'place'].includes(value as string) ? value as InventoryQrTargetType : fallback
}

function parseCookies(value: string | undefined) {
  const cookies = new Map<string, string>()
  if (!value) {
    return cookies
  }
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const cookieValue = part.slice(separator + 1).trim()
    if (name) {
      cookies.set(name, cookieValue)
    }
  }
  return cookies
}

function requestIp(request: Request) {
  return parseString(request.header('x-forwarded-for')?.split(',')[0] ?? request.ip ?? request.socket.remoteAddress, 80) || 'unknown'
}

function loginRateKey(request: Request, email: string) {
  return `${requestIp(request)}:${email}`
}

function loginBucket(key: string) {
  const now = Date.now()
  const current = loginRateBuckets.get(key)
  if (!current || current.resetAt <= now) {
    const next = { attempts: 0, resetAt: now + loginWindowMs, lockedUntil: 0 }
    loginRateBuckets.set(key, next)
    return next
  }
  return current
}

function isLoginRateLimited(key: string) {
  const bucket = loginBucket(key)
  return bucket.lockedUntil > Date.now()
}

function registerLoginFailure(key: string) {
  const bucket = loginBucket(key)
  bucket.attempts += 1
  if (bucket.attempts >= maxLoginAttempts) {
    bucket.lockedUntil = Date.now() + loginWindowMs
  }
}

function clearLoginFailures(key: string) {
  loginRateBuckets.delete(key)
}

function credentialIsLocked(credential: InventoryCredentialRow) {
  return Boolean(credential.lockedUntil && new Date(credential.lockedUntil).getTime() > Date.now())
}

function registerCredentialFailure(database: DatabaseSync, credential: InventoryCredentialRow) {
  const failedAttempts = credential.failedAttempts + 1
  const lockedUntil = failedAttempts >= maxLoginAttempts ? new Date(Date.now() + loginWindowMs).toISOString() : null
  database
    .prepare(`UPDATE inventory_user_credentials SET failedAttempts = ?, lockedUntil = ? WHERE userId = ?`)
    .run(failedAttempts, lockedUntil, credential.userId)
}

function clearCredentialFailures(database: DatabaseSync, userId: string) {
  database.prepare(`UPDATE inventory_user_credentials SET failedAttempts = 0, lockedUntil = NULL WHERE userId = ?`).run(userId)
}

function secureCookieForRequest(request: Request) {
  const forwardedProto = request.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const host = request.header('host') ?? ''
  return (
    request.secure ||
    forwardedProto === 'https' ||
    (!host.startsWith('127.0.0.1') && !host.startsWith('localhost') && host.length > 0)
  )
}

function safeStringCompare(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

function signDigitalOfficeSsoPayload(encodedPayload: string) {
  return createHmac('sha256', digitalOfficeSsoSecret).update(encodedPayload).digest('base64url')
}

function digitalOfficeSsoCookieValue(user: InventoryUser, stayLoggedIn: boolean) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      email: user.email.toLowerCase(),
      stayLoggedIn,
      expiresAt: Date.now() + (stayLoggedIn ? persistentSessionDurationMs : sessionDurationMs),
    }),
  ).toString('base64url')
  return `v1.${encodedPayload}.${signDigitalOfficeSsoPayload(encodedPayload)}`
}

function digitalOfficeSsoCookie(request: Request, user: InventoryUser, stayLoggedIn: boolean) {
  return [
    `${digitalOfficeSsoCookieName}=${digitalOfficeSsoCookieValue(user, stayLoggedIn)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    digitalOfficeCookieDomain ? `Domain=${digitalOfficeCookieDomain}` : '',
    stayLoggedIn ? `Max-Age=${Math.floor(persistentSessionDurationMs / 1000)}` : '',
    secureCookieForRequest(request) ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function clearDigitalOfficeSsoCookie(request: Request) {
  return [
    `${digitalOfficeSsoCookieName}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    digitalOfficeCookieDomain ? `Domain=${digitalOfficeCookieDomain}` : '',
    'Max-Age=0',
    secureCookieForRequest(request) ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function digitalOfficeSsoForRequest(request: Request) {
  const token = parseCookies(request.header('cookie')).get(digitalOfficeSsoCookieName)
  const [version, encodedPayload, signature] = (token ?? '').split('.')
  if (version !== 'v1' || !encodedPayload || !signature) {
    return undefined
  }
  if (!safeStringCompare(signDigitalOfficeSsoPayload(encodedPayload), signature)) {
    return undefined
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      email?: unknown
      stayLoggedIn?: unknown
      expiresAt?: unknown
    }
    if (typeof payload.email !== 'string' || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
      return undefined
    }
    return {
      email: payload.email.toLowerCase(),
      stayLoggedIn: payload.stayLoggedIn === true,
    }
  } catch {
    return undefined
  }
}

function isInventoryMobileOrigin(request: Request) {
  const origin = request.header('origin')?.trim().replace(/\/+$/, '')
  return (
    origin === 'http://asset.localhost' ||
    origin === 'https://asset.localhost' ||
    origin === 'http://tauri.localhost' ||
    origin === 'https://tauri.localhost' ||
    origin === 'tauri://localhost' ||
    origin === 'capacitor://localhost' ||
    origin === 'http://localhost' ||
    origin === 'https://localhost'
  )
}

function isInventoryMobileAppRequest(request: Request) {
  return isInventoryMobileOrigin(request) || request.header('x-inventory-mobile-app') === '1'
}

function sessionCookie(token: string, request: Request, maxAgeSeconds?: number) {
  const mobileOrigin = isInventoryMobileOrigin(request)
  return [
    `${sessionCookieName}=${token}`,
    'HttpOnly',
    mobileOrigin ? 'SameSite=None' : 'SameSite=Lax',
    'Path=/',
    typeof maxAgeSeconds === 'number' ? `Max-Age=${maxAgeSeconds}` : '',
    secureCookieForRequest(request) || mobileOrigin ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

function clearSessionCookie(request: Request) {
  return sessionCookie('', request, 0)
}

function createSession(database: DatabaseSync, user: InventoryUser, request: Request, stayLoggedIn = false) {
  const token = randomToken()
  const createdAt = nowIso()
  const session: InventorySessionRow = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: hashToken(token),
    csrfToken: randomToken(),
    expiresAt: new Date(Date.now() + (stayLoggedIn ? persistentSessionDurationMs : sessionDurationMs)).toISOString(),
    createdAt,
    lastSeenAt: createdAt,
    userAgent: parseOptionalString(request.header('user-agent'), 500) ?? null,
    ipAddress: requestIp(request),
  }
  database
    .prepare(
      `INSERT INTO inventory_sessions
       (id, userId, tokenHash, csrfToken, expiresAt, createdAt, lastSeenAt, userAgent, ipAddress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      session.userId,
      session.tokenHash,
      session.csrfToken,
      session.expiresAt,
      session.createdAt,
      session.lastSeenAt,
      session.userAgent,
      session.ipAddress,
    )
  return { token, session }
}

function sessionTokenForRequest(request: Request) {
  const bearerToken = parseString(request.header('authorization')?.replace(/^Bearer\s+/i, ''), 240)
  return bearerToken || parseCookies(request.header('cookie')).get(sessionCookieName) || ''
}

function activeSessionContext(database: DatabaseSync, session: InventorySessionRow, sessionToken: string): InventorySessionContext | undefined {
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    database.prepare(`DELETE FROM inventory_sessions WHERE id = ?`).run(session.id)
    return undefined
  }

  const user = activeUserById(session.userId)
  if (!user) {
    database.prepare(`DELETE FROM inventory_sessions WHERE id = ?`).run(session.id)
    return undefined
  }

  const lastSeenAt = nowIso()
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString()
  database.prepare(`UPDATE inventory_sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?`).run(lastSeenAt, expiresAt, session.id)
  return { user, session: { ...session, lastSeenAt, expiresAt }, sessionToken }
}

function sessionContextFromMobileCsrf(request: Request): InventorySessionContext | undefined {
  if (!isInventoryMobileOrigin(request)) {
    return undefined
  }

  const csrfToken = parseString(request.header('x-inventory-csrf'), 180)
  if (!csrfToken) {
    return undefined
  }

  const database = connection()
  const session = database
    .prepare(`SELECT * FROM inventory_sessions WHERE csrfToken = ?`)
    .get(csrfToken) as unknown as InventorySessionRow | undefined
  return session ? activeSessionContext(database, session, '') : undefined
}

function sessionContextForRequest(request: Request): InventorySessionContext | undefined {
  const token = sessionTokenForRequest(request)
  if (!token) {
    return sessionContextFromMobileCsrf(request) ?? sessionContextFromSso(request)
  }

  const database = connection()
  const session = database
    .prepare(`SELECT * FROM inventory_sessions WHERE tokenHash = ?`)
    .get(hashToken(token)) as unknown as InventorySessionRow | undefined
  if (!session) {
    return sessionContextFromSso(request)
  }

  return activeSessionContext(database, session, token) ?? sessionContextFromSso(request)
}

function sessionContextFromSso(request: Request): InventorySessionContext | undefined {
  if (isInventoryMobileAppRequest(request)) {
    return undefined
  }

  const sso = digitalOfficeSsoForRequest(request)
  if (!sso) {
    return undefined
  }

  const database = connection()
  const user = userByEmailFromDatabase(database, sso.email)
  if (!user?.active) {
    return undefined
  }

  const { token, session } = createSession(database, user, request, sso.stayLoggedIn)
  return {
    user,
    session,
    sessionToken: token,
    setCookie: sessionCookie(token, request, sso.stayLoggedIn ? Math.floor(persistentSessionDurationMs / 1000) : undefined),
  }
}

function coreInventoryUser(identity: Awaited<ReturnType<typeof requireCoreIdentity>>): InventoryUser {
  const database = connection()
  const email = identity.email.toLowerCase()
  const link = database.prepare('SELECT userId FROM inventory_core_profiles WHERE coreUserId = ?').get(identity.id) as { userId: string } | undefined
  const emailMatch = userByEmailFromDatabase(database, email)
  const idMatch = userByIdFromDatabase(database, identity.id)
  const existing = link ? userByIdFromDatabase(database, link.userId) : emailMatch ?? idMatch
  const linkedOwner = existing ? database.prepare('SELECT coreUserId FROM inventory_core_profiles WHERE userId = ?').get(existing.id) as { coreUserId: string } | undefined : undefined
  if ((linkedOwner && linkedOwner.coreUserId !== identity.id) || (emailMatch && existing && emailMatch.id !== existing.id) || (!link && idMatch && (idMatch.email.toLowerCase() !== email || (emailMatch && emailMatch.id !== idMatch.id)))) {
    throw new CoreAuthError(409, 'This email or profile belongs to a different linked account. Contact an administrator.')
  }
  const user: InventoryUser = {
    id: existing?.id ?? identity.id,
    name: identity.name, email, active: identity.active,
    role: inventoryRoles.includes(identity.moduleRole as InventoryRole) ? identity.moduleRole as InventoryRole : 'viewer',
    mustChangePassword: identity.mustChangePassword,
    createdAt: existing?.createdAt ?? nowIso(), updatedAt: nowIso(),
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    if (existing) updateUser(database, user)
    else insertUser(database, user)
    if (!link) database.prepare('INSERT INTO inventory_core_profiles (coreUserId, userId) VALUES (?, ?)').run(identity.id, user.id)
    database.exec('COMMIT')
  } catch (error) { database.exec('ROLLBACK'); throw error }
  return user
}

async function coreSessionContext(request: Request): Promise<InventorySessionContext> {
  const identity = await requireCoreIdentity(request, 'inventory', {
    ...(request.path.startsWith('/auth/') ? { write: false } : {}),
    allowPasswordChange: request.path === '/state' || request.path.startsWith('/auth/'),
  })
  const user = coreInventoryUser(identity)
  const sessionToken = coreTokenForRequest(request)
  const timestamp = nowIso()
  return {
    user, sessionToken, coreReadOnly: identity.readOnly,
    session: { id: 'core', userId: user.id, tokenHash: hashToken(sessionToken), csrfToken: 'core-cookie-session', expiresAt: timestamp, createdAt: timestamp, lastSeenAt: timestamp, userAgent: null, ipAddress: null },
  }
}

function routeErrorStatus(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 400
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400
}

async function requireInventorySession(request: Request, response: Response, next: NextFunction) {
  if (coreEnabled()) {
    try {
      requestAuthContexts.set(request, await coreSessionContext(request))
      next()
    } catch (error) {
      response.status(routeErrorStatus(error)).json({ message: error instanceof Error ? error.message : 'Core sign-in is required.' })
    }
    return
  }
  const context = sessionContextForRequest(request)
  if (!context) {
    response.status(401).json({ message: 'Sign in to use the inventory system.' })
    return
  }
  if (context.setCookie) {
    response.setHeader('Set-Cookie', context.setCookie)
  }
  requestAuthContexts.set(request, context)
  next()
}

function requireInventoryCsrf(request: Request, response: Response, next: NextFunction) {
  // Core authenticates the bearer token or validates the browser origin on every write.
  if (coreEnabled()) { next(); return }
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    next()
    return
  }

  const session = requestAuthContexts.get(request)?.session
  const token = parseString(request.header('x-inventory-csrf'), 180)
  const expected = Buffer.from(session?.csrfToken ?? '')
  const actual = Buffer.from(token)
  if (!session || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    response.status(403).json({ message: 'Inventory session check failed. Refresh and try again.' })
    return
  }
  next()
}

function requireInventoryPasswordReady(request: Request, response: Response, next: NextFunction) {
  const user = requestAuthContexts.get(request)?.user
  if (user?.mustChangePassword) {
    response.status(428).json({ message: 'Password change required.' })
    return
  }
  next()
}

function destroySessionForRequest(request: Request) {
  const token = sessionTokenForRequest(request)
  if (token) {
    connection().prepare(`DELETE FROM inventory_sessions WHERE tokenHash = ?`).run(hashToken(token))
  }
}

function normalizeSku(value: unknown) {
  return parseString(value, 64)
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function activeUserById(userId: string | undefined) {
  const users = readUsers()
  return users.find((user) => user.id === userId && user.active)
}

function actorForRequest(request: Request) {
  return requestAuthContexts.get(request)?.user
}

function permissionsForRole(role: InventoryRole) {
  return rolePermissions[role]
}

function hasPermission(user: InventoryUser, permission: InventoryPermission) {
  return permissionsForRole(user.role).includes(permission)
}

function requirePermission(request: Request, response: Response, permission: InventoryPermission) {
  const actor = actorForRequest(request)
  if (!actor) {
    response.status(403).json({ message: 'No inventory user is available.' })
    return undefined
  }

  if (!hasPermission(actor, permission) || (requestAuthContexts.get(request)?.coreReadOnly && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))) {
    response.status(403).json({ message: 'This inventory account cannot perform this action.' })
    return undefined
  }

  return actor
}

function permissionForRecordState(state: InventoryState): InventoryPermission {
  if (state === 'requested' || state === 'approved') {
    return 'request_stock'
  }
  if (state === 'ordered' || state === 'cancelled') {
    return 'order_stock'
  }
  if (state === 'delivered') {
    return 'receive_stock'
  }
  if (state === 'in_stock') {
    return 'receive_stock'
  }
  return 'adjust_stock'
}

function canWriteRecordForState(user: InventoryUser, state: InventoryState) {
  if (hasPermission(user, 'adjust_stock') && ['in_stock', 'reserved', 'in_use', 'maintenance', 'damaged', 'retired'].includes(state)) {
    return true
  }
  return hasPermission(user, permissionForRecordState(state))
}

function requireRecordWritePermission(request: Request, response: Response, state: InventoryState) {
  const actor = actorForRequest(request)
  if (!actor) {
    response.status(403).json({ message: 'No inventory user is available.' })
    return undefined
  }
  if (!canWriteRecordForState(actor, state)) {
    response.status(403).json({ message: 'This inventory account cannot update that stock state.' })
    return undefined
  }

  return actor
}

const physicalRecordStates = new Set<InventoryState>(['in_stock', 'reserved', 'in_use', 'maintenance', 'damaged', 'retired'])
const procurementTransitions: Partial<Record<InventoryState, InventoryState[]>> = {
  requested: ['approved', 'ordered', 'cancelled'],
  approved: ['ordered', 'cancelled'],
  ordered: ['delivered', 'cancelled'],
  delivered: ['in_stock'],
}

function requireRecordTransitionPermission(request: Request, response: Response, existing: InventoryRecord, nextState: InventoryState, splitting = false) {
  const actor = requireRecordWritePermission(request, response, nextState)
  if (!actor) return undefined
  const allowedTransition = nextState === existing.state || (
    physicalRecordStates.has(existing.state)
      ? existing.state !== 'retired' && physicalRecordStates.has(nextState)
      : procurementTransitions[existing.state]?.includes(nextState)
  )
  const canChangeSource = splitting
    ? hasPermission(actor, 'adjust_stock') && physicalRecordStates.has(existing.state) && existing.state !== 'retired'
    : nextState === existing.state || !physicalRecordStates.has(existing.state) || hasPermission(actor, 'adjust_stock')
  if (!allowedTransition || !canChangeSource) {
    response.status(403).json({ message: 'This account cannot make that transition from the current stock state.' })
    return undefined
  }
  return actor
}

function assertAssignmentIntegrity(existing: InventoryRecord, updated: InventoryRecord) {
  const assigned = activeAssignmentQuantity(existing.id)
  if (updated.quantity < assigned) throw new Error('Return assigned units before reducing stock below the assigned quantity.')
  if (assigned > 0 && (updated.itemId !== existing.itemId || updated.state === 'retired' || updated.state === 'cancelled')) {
    throw new Error('Return all assigned units before changing the item or reversing this stock.')
  }
}

function assertExpectedVersion(expectedVersion: unknown, record: InventoryRecord) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== record.version) {
    throw Object.assign(new Error('This stock record has changed or needs to be refreshed. Refresh the inventory and review your changes before saving again.'), { status: 409 })
  }
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE;')
  try {
    const result = action()
    database.exec('COMMIT;')
    return result
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function itemById(id: string) {
  const row = connection().prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id) as unknown as InventoryItemRow | undefined
  return row
    ? ({
        ...readCatalogDetails(connection()).get(row.id),
        id: row.id,
        sku: row.sku ?? '',
        name: row.name,
        category: row.category,
        description: optionalText(row.description),
        manufacturer: optionalText(row.manufacturer),
        model: optionalText(row.model),
        value: optionalText(row.value),
        manufacturerPartNumber: optionalText(row.manufacturerPartNumber),
        lcscPartNumber: optionalText(row.lcscPartNumber),
        packageForm: optionalText(row.packageForm),
        unit: row.unit,
        minQuantity: row.minQuantity,
        reorderQuantity: row.reorderQuantity,
        active: Boolean(row.active),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies InventoryItemDefinition)
    : undefined
}

function locationById(id: string) {
  const row = connection()
    .prepare(`SELECT * FROM inventory_locations WHERE id = ?`)
    .get(id) as unknown as InventoryLocationRow | undefined
  return row ? rowToLocation(row) : undefined
}

function recordById(id: string) {
  const row = connection().prepare(`SELECT * FROM inventory_records WHERE id = ?`).get(id) as unknown as InventoryRecordRow | undefined
  return row ? rowToRecord(row) : undefined
}

function assignmentById(id: string) {
  const row = connection().prepare(`SELECT * FROM inventory_assignments WHERE id = ?`).get(id) as unknown as InventoryAssignmentRow | undefined
  return row
    ? ({
        id: row.id,
        recordId: row.recordId,
        userId: row.userId,
        projectId: optionalText(row.projectId),
        buildId: optionalText(row.buildId),
        requestId: optionalText(row.requestId),
        consumedQuantity: row.consumedQuantity,
        quantity: Math.max(0, Math.round((row.quantity - row.consumedQuantity) * 1e6) / 1e6),
        notes: optionalText(row.notes),
        assignedAt: row.assignedAt,
        returnedAt: optionalText(row.returnedAt),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies InventoryAssignment)
    : undefined
}

function activeAssignmentQuantity(recordId: string) {
  const row = connection()
    .prepare(`SELECT COALESCE(SUM(quantity - consumedQuantity), 0) AS count FROM inventory_assignments WHERE recordId = ? AND returnedAt IS NULL`)
    .get(recordId) as unknown as CountRow
  return row.count
}

function duplicateSkuExists(sku: string, currentId?: string) {
  if (!sku) {
    return false
  }

  const row = connection()
    .prepare(`SELECT id FROM inventory_items WHERE sku = ? AND id != ?`)
    .get(sku, currentId ?? '') as unknown as IdRow | undefined
  return Boolean(row)
}

function duplicateLocationCodeExists(code: string, currentId?: string) {
  if (!code) {
    return false
  }

  const row = connection()
    .prepare(`SELECT id FROM inventory_locations WHERE code = ? AND id != ?`)
    .get(code, currentId ?? '') as unknown as IdRow | undefined
  return Boolean(row)
}

function duplicateUserEmailExists(email: string, currentId?: string) {
  const row = connection()
    .prepare(`SELECT id FROM inventory_users WHERE email = ? AND id != ?`)
    .get(email, currentId ?? '') as unknown as IdRow | undefined
  return Boolean(row)
}

function itemRecordCount(itemId: string) {
  return (
    connection().prepare(`SELECT COUNT(*) AS count FROM inventory_records WHERE itemId = ?`).get(itemId) as unknown as CountRow
  ).count
}

function tagFromBody(body: Record<string, unknown>, existing?: InventoryTag): InventoryTag {
  const createdAt = existing?.createdAt ?? nowIso()
  const name = parseString(body.name ?? existing?.name, 80)
  if (!name) {
    throw new Error('Tag name is required.')
  }

  return {
    id: existing?.id ?? randomUUID(),
    name,
    color: parseHexColor(body.color ?? existing?.color),
    createdAt,
    updatedAt: nowIso(),
  }
}

function itemFromBody(body: Record<string, unknown>, existing?: InventoryItemDefinition): InventoryItemDefinition {
  const createdAt = existing?.createdAt ?? nowIso()
  const sku = normalizeSku(body.sku ?? existing?.sku)
  const name = parseString(body.name ?? existing?.name, 160)
  const category = parseString(body.category ?? existing?.category, 120) || 'General'
  const unit = catalogUnit(body.unit ?? existing?.unit, existing?.unit)
  const minQuantity = Math.max(0, parseNumber(body.minQuantity ?? existing?.minQuantity, 0))
  const reorderQuantity = Math.max(0, parseNumber(body.reorderQuantity ?? existing?.reorderQuantity, minQuantity))

  if (!name) {
    throw new Error('Item name is required.')
  }

  return {
    id: existing?.id ?? randomUUID(),
    sku,
    name,
    category,
    ...parseCatalogDetails(body, readProjects(), existing),
    description: parseOptionalString(body.description ?? existing?.description, 1000),
    manufacturer: parseOptionalString(body.manufacturer ?? existing?.manufacturer, 120),
    model: parseOptionalString(body.model ?? existing?.model, 120),
    value: parseOptionalString(body.value ?? existing?.value, 160),
    manufacturerPartNumber: parseOptionalString(body.manufacturerPartNumber ?? existing?.manufacturerPartNumber, 240),
    lcscPartNumber: parseOptionalString(body.lcscPartNumber ?? existing?.lcscPartNumber, 120),
    packageForm: parseOptionalString(body.packageForm ?? existing?.packageForm, 160),
    unit,
    minQuantity,
    reorderQuantity,
    active: parseBoolean(body.active, existing?.active ?? true),
    createdAt,
    updatedAt: nowIso(),
  }
}

function locationFromBody(body: Record<string, unknown>, existing?: InventoryLocation): InventoryLocation {
  const createdAt = existing?.createdAt ?? nowIso()
  const code = normalizeSku(body.code ?? existing?.code)
  const name = parseString(body.name ?? existing?.name, 160)
  if (!name) {
    throw new Error('Location name is required.')
  }

  const requestedKind = parseString(body.kind ?? existing?.kind, 20) as InventoryLocationKind
  const kind = inventoryLocationKinds.includes(requestedKind) ? requestedKind : existing?.kind ?? 'room'
  const parentId = kind === 'room' ? undefined : parseOptionalString(body.parentId ?? existing?.parentId, 120)
  if (existing && existing.kind !== kind) {
    const childCount = (
      connection().prepare(`SELECT COUNT(*) AS count FROM inventory_locations WHERE parentId = ?`).get(existing.id) as unknown as CountRow
    ).count
    if (childCount > 0) {
      throw new Error('A place with child locations cannot change its type.')
    }
  }
  if (kind !== 'room' && !parentId) {
    throw new Error(kind === 'fixture' ? 'Choose the room or area for this cabinet or shelf.' : 'Choose the cabinet or shelf for this box or compartment.')
  }

  const parent = parentId ? locationById(parentId) : undefined
  const expectedParentKind = kind === 'fixture' ? 'room' : kind === 'container' ? 'fixture' : undefined
  if (expectedParentKind && (!parent || parent.kind !== expectedParentKind || parent.id === existing?.id)) {
    throw new Error(kind === 'fixture' ? 'A cabinet or shelf must be inside a room or area.' : 'A box or compartment must be inside a cabinet or shelf.')
  }
  const room = kind === 'container' && parent?.parentId ? locationById(parent.parentId) : kind === 'fixture' ? parent : undefined
  if (kind === 'container' && (!room || room.kind !== 'room')) {
    throw new Error('The selected cabinet or shelf must belong to a room or area.')
  }

  return {
    id: existing?.id ?? randomUUID(),
    name,
    code,
    kind,
    parentId,
    area: room?.name ?? (kind === 'room' ? name : parent?.name),
    rack: kind === 'container' ? parent?.name : undefined,
    bin: kind === 'container' ? name : undefined,
    description: parseOptionalString(body.description ?? existing?.description, 1000),
    roomCode: kind === 'room' ? code : room?.code || room?.roomCode,
    roomName: kind === 'room' ? name : room?.name || room?.roomName,
    fixtureCode: kind === 'container' ? parent?.code || parent?.fixtureCode : kind === 'fixture' ? code : undefined,
    fixtureType: kind === 'container' ? parent?.name || parent?.fixtureType : kind === 'fixture' ? name : undefined,
    rowCode: kind === 'container' ? parseOptionalString(body.rowCode ?? existing?.rowCode, 20) : undefined,
    planImagePath: parseOptionalString(body.planImagePath ?? existing?.planImagePath, 500),
    photoPath: parseOptionalString(body.photoPath ?? existing?.photoPath, 500),
    highlightX: parseOptionalNumber(body.highlightX ?? existing?.highlightX),
    highlightY: parseOptionalNumber(body.highlightY ?? existing?.highlightY),
    highlightWidth: parseOptionalNumber(body.highlightWidth ?? existing?.highlightWidth),
    highlightHeight: parseOptionalNumber(body.highlightHeight ?? existing?.highlightHeight),
    active: parseBoolean(body.active, existing?.active ?? true),
    createdAt,
    updatedAt: nowIso(),
  }
}

function userFromBody(body: Record<string, unknown>, existing?: InventoryUser): InventoryUser {
  const createdAt = existing?.createdAt ?? nowIso()
  const name = parseString(body.name ?? existing?.name, 160)
  const email = parseString(body.email ?? existing?.email, 180).toLowerCase()
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid user name and email are required.')
  }

  return {
    id: existing?.id ?? randomUUID(),
    name,
    email,
    role: parseRole(body.role, existing?.role ?? 'viewer'),
    active: parseBoolean(body.active, existing?.active ?? true),
    mustChangePassword: parseBoolean(body.mustChangePassword, existing?.mustChangePassword ?? !existing),
    createdAt,
    updatedAt: nowIso(),
  }
}

function recordInputFromBody(body: Record<string, unknown>, actor: InventoryUser, existing?: InventoryRecord): InventoryRecordInput {
  const itemId = parseString(body.itemId ?? existing?.itemId, 120)
  const locationId = parseString(body.locationId ?? existing?.locationId, 120)
  const state = parseState(body.state, existing?.state ?? 'requested')
  const quantity = Math.max(0, parseNumber(body.quantity ?? existing?.quantity, 1))
  const updatedAt = nowIso()

  if (!itemById(itemId)) {
    throw new Error('Choose a valid item.')
  }
  if (!locationById(locationId)) {
    throw new Error('Choose a valid location.')
  }
  if (!existing && quantity <= 0) {
    throw new Error('Quantity must be greater than 0.')
  }

  const requestedAt = existing?.requestedAt ?? (state === 'requested' || state === 'approved' ? updatedAt : undefined)
  const orderedAt = existing?.orderedAt ?? (state === 'ordered' ? updatedAt : undefined)
  const deliveredAt = existing?.deliveredAt ?? (state === 'delivered' || state === 'in_stock' ? updatedAt : undefined)
  const stockedAt = existing?.stockedAt ?? (state === 'in_stock' ? updatedAt : undefined)

  return {
    itemId,
    locationId,
    label: parseOptionalString(body.label ?? existing?.label, 180),
    groupName: parseOptionalString(body.groupName ?? existing?.groupName, 180),
    quantity,
    quantityLabel: parseOptionalString(body.quantityLabel ?? existing?.quantityLabel, 160),
    state,
    condition: parseCondition(body.condition, existing?.condition ?? 'new'),
    assetTag: parseOptionalString(body.assetTag ?? existing?.assetTag, 120),
    serialNumber: parseOptionalString(body.serialNumber ?? existing?.serialNumber, 120),
    lotNumber: parseOptionalString(body.lotNumber ?? existing?.lotNumber, 120),
    supplier: parseOptionalString(body.supplier ?? existing?.supplier, 160),
    orderReference: parseOptionalString(body.orderReference ?? existing?.orderReference, 160),
    unitCost: parseOptionalNumber(body.unitCost ?? existing?.unitCost),
    requestedBy: existing?.requestedBy ?? (state === 'requested' || state === 'approved' ? actor.id : undefined),
    orderedBy: existing?.orderedBy ?? (state === 'ordered' ? actor.id : undefined),
    receivedBy: existing?.receivedBy ?? (state === 'delivered' || state === 'in_stock' ? actor.id : undefined),
    lastCountedBy: hasPermission(actor, 'adjust_stock') ? actor.id : existing?.lastCountedBy,
    notes: parseOptionalString(body.notes ?? existing?.notes, 2000),
    photoPath: parseOptionalString(body.photoPath ?? existing?.photoPath, 500),
    photoVerified: parseBoolean(body.photoVerified, existing?.photoVerified ?? false),
    sourceReference: parseOptionalString(body.sourceReference ?? existing?.sourceReference, 500),
    dueDate: parseDate(body.dueDate ?? existing?.dueDate),
    requestedAt,
    orderedAt: state === 'ordered' && existing?.state !== 'ordered' ? updatedAt : orderedAt,
    deliveredAt: (state === 'delivered' || state === 'in_stock') && existing?.state !== state ? updatedAt : deliveredAt,
    stockedAt: state === 'in_stock' && existing?.state !== 'in_stock' ? updatedAt : stockedAt,
  }
}

function assignmentFromBody(body: Record<string, unknown>, record: InventoryRecord): InventoryAssignment {
  if (record.quarantined || !['new', 'usable'].includes(record.condition) || !['in_stock', 'reserved', 'in_use'].includes(record.state)) {
    throw new Error('Only usable physical stock can be assigned.')
  }
  const quantity = body.quantity === undefined ? 1 : Number(body.quantity)
  if (!Number.isFinite(quantity)) throw new Error('Assignment quantity must be a finite number.')
  const userId = parseString(body.userId, 120)
  const projectId = parseOptionalString(body.projectId, 120)
  if (projectId && !readProjects().some(project => project.id === projectId && project.active)) {
    throw new Error('Choose a valid active inventory project.')
  }
  const assignedAt = parseIsoDateTime(body.assignedAt, nowIso())
  const user = activeUserById(userId)
  if (!user) {
    throw new Error('Choose a valid active user.')
  }
  if (quantity <= 0) {
    throw new Error('Assignment quantity must be greater than 0.')
  }

  const availableQuantity = Math.max(0, record.quantity - activeAssignmentQuantity(record.id))
  if (quantity > availableQuantity) {
    throw new Error('Assignment quantity is higher than the available quantity for this record.')
  }

  return {
    id: randomUUID(),
    recordId: record.id,
    userId,
    projectId,
    quantity,
    notes: parseOptionalString(body.notes, 1000),
    assignedAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function updateUser(database: DatabaseSync, user: InventoryUser) {
  database
    .prepare(`UPDATE inventory_users SET name = ?, email = ?, role = ?, active = ?, mustChangePassword = ?, updatedAt = ? WHERE id = ?`)
    .run(user.name, user.email, user.role, user.active ? 1 : 0, user.mustChangePassword ? 1 : 0, user.updatedAt, user.id)
}

function updateLocation(database: DatabaseSync, location: InventoryLocation) {
  database
    .prepare(
      `UPDATE inventory_locations
       SET name = ?, code = ?, kind = ?, parentId = ?, area = ?, rack = ?, bin = ?, description = ?, roomCode = ?, roomName = ?, fixtureCode = ?,
           fixtureType = ?, rowCode = ?, planImagePath = ?, photoPath = ?, highlightX = ?, highlightY = ?, highlightWidth = ?,
           highlightHeight = ?, active = ?, updatedAt = ?
       WHERE id = ?`,
    )
    .run(
      location.name,
      location.code || null,
      location.kind,
      location.parentId ?? null,
      location.area ?? null,
      location.rack ?? null,
      location.bin ?? null,
      location.description ?? null,
      location.roomCode ?? null,
      location.roomName ?? null,
      location.fixtureCode ?? null,
      location.fixtureType ?? null,
      location.rowCode ?? null,
      location.planImagePath ?? null,
      location.photoPath ?? null,
      location.highlightX ?? null,
      location.highlightY ?? null,
      location.highlightWidth ?? null,
      location.highlightHeight ?? null,
      location.active ? 1 : 0,
      location.updatedAt,
      location.id,
    )
  synchronizeLocationDescendants(database, location)
}

function synchronizeLocationDescendants(database: DatabaseSync, location: InventoryLocation) {
  if (location.kind === 'room') {
    database
      .prepare(
        `UPDATE inventory_locations
         SET area = ?, roomCode = ?, roomName = ?, updatedAt = ?
         WHERE parentId = ? OR parentId IN (SELECT id FROM inventory_locations WHERE parentId = ?)`,
      )
      .run(location.name, location.code || null, location.name, location.updatedAt, location.id, location.id)
    return
  }

  if (location.kind === 'fixture') {
    database
      .prepare(
        `UPDATE inventory_locations
         SET area = ?, rack = ?, roomCode = ?, roomName = ?, fixtureCode = ?, fixtureType = ?, updatedAt = ?
         WHERE parentId = ?`,
      )
      .run(
        location.area ?? null,
        location.name,
        location.roomCode ?? null,
        location.roomName ?? null,
        location.code || null,
        location.name,
        location.updatedAt,
        location.id,
      )
  }
}

function updateItem(database: DatabaseSync, item: InventoryItemDefinition) {
  database
    .prepare(
      `UPDATE inventory_items
       SET sku = ?, name = ?, category = ?, description = ?, manufacturer = ?, model = ?, value = ?, manufacturerPartNumber = ?,
           lcscPartNumber = ?, packageForm = ?, unit = ?,
           minQuantity = ?, reorderQuantity = ?, active = ?, updatedAt = ?
       WHERE id = ?`,
    )
    .run(
      item.sku || null,
      item.name,
      item.category,
      item.description ?? null,
      item.manufacturer ?? null,
      item.model ?? null,
      item.value ?? null,
      item.manufacturerPartNumber ?? null,
      item.lcscPartNumber ?? null,
      item.packageForm ?? null,
      item.unit,
      item.minQuantity,
      item.reorderQuantity,
      item.active ? 1 : 0,
      item.updatedAt,
      item.id,
    )
  writeCatalogDetails(database, item)
}

function updateRecord(database: DatabaseSync, record: InventoryRecord) {
  const result = database
    .prepare(
      `UPDATE inventory_records
       SET itemId = ?, locationId = ?, label = ?, groupName = ?, quantity = ?, quantityLabel = ?, state = ?, condition = ?, assetTag = ?, serialNumber = ?,
           lotNumber = ?, supplier = ?, orderReference = ?, unitCost = ?, requestedBy = ?, orderedBy = ?,
           receivedBy = ?, lastCountedBy = ?, notes = ?, photoPath = ?, photoVerified = ?, sourceReference = ?, dueDate = ?, requestedAt = ?, orderedAt = ?,
           deliveredAt = ?, stockedAt = ?, updatedAt = ?, quarantined = ?, version = version + 1
       WHERE id = ? AND version = ? AND version < 9007199254740991`,
    )
    .run(
      record.itemId,
      record.locationId,
      record.label ?? null,
      record.groupName ?? null,
      record.quantity,
      record.quantityLabel ?? null,
      record.state,
      record.condition,
      record.assetTag ?? null,
      record.serialNumber ?? null,
      record.lotNumber ?? null,
      record.supplier ?? null,
      record.orderReference ?? null,
      record.unitCost ?? null,
      record.requestedBy ?? null,
      record.orderedBy ?? null,
      record.receivedBy ?? null,
      record.lastCountedBy ?? null,
      record.notes ?? null,
      record.photoPath ?? null,
      record.photoVerified ? 1 : 0,
      record.sourceReference ?? null,
      record.dueDate ?? null,
      record.requestedAt ?? null,
      record.orderedAt ?? null,
      record.deliveredAt ?? null,
      record.stockedAt ?? null,
      record.updatedAt,
      record.quarantined ? 1 : 0,
      record.id,
      record.version,
    )
  if (result.changes !== 1) throw Object.assign(new Error('This stock record changed while saving. Refresh the inventory and review your changes.'), { status: 409 })
  record.version += 1
}

function itemTotals(items: InventoryItemDefinition[], records: InventoryRecord[], assignments: InventoryAssignment[] = []) {
  const activeAssignedByRecordId = new Map<string, number>()
  for (const assignment of assignments) {
    if (assignment.returnedAt) continue
    activeAssignedByRecordId.set(assignment.recordId, (activeAssignedByRecordId.get(assignment.recordId) ?? 0) + assignment.quantity)
  }
  const availableQuantity = (record: InventoryRecord) => record.quarantined || !['new', 'usable'].includes(record.condition) ? 0 : Math.max(0, record.quantity - (activeAssignedByRecordId.get(record.id) ?? 0))

  return items.map((item): InventoryItemTotals => {
    const itemRecords = records.filter((record) => record.itemId === item.id)
    const requestedQuantity = sumQuantities(itemRecords, ['requested', 'approved'])
    const orderedQuantity = sumQuantities(itemRecords, ['ordered'])
    const deliveredQuantity = sumQuantities(itemRecords, ['delivered'])
    const inStockQuantity = sumAvailableQuantities(itemRecords, ['in_stock'], availableQuantity)
    const usableQuantity = sumAvailableQuantities(itemRecords, ['in_stock', 'reserved'], availableQuantity)
    const totalTrackedQuantity = sumQuantities(itemRecords, [
      'requested',
      'approved',
      'ordered',
      'delivered',
      'in_stock',
      'reserved',
      'in_use',
      'maintenance',
      'damaged',
    ])

    return {
      itemId: item.id,
      requestedQuantity,
      orderedQuantity,
      deliveredQuantity,
      inStockQuantity,
      usableQuantity,
      totalTrackedQuantity,
      belowMinimum: inStockQuantity < item.minQuantity,
    }
  })
}

function sumQuantities(records: InventoryRecord[], states: InventoryState[]) {
  const stateSet = new Set(states)
  return records.filter((record) => stateSet.has(record.state)).reduce((total, record) => total + record.quantity, 0)
}

function sumAvailableQuantities(records: InventoryRecord[], states: InventoryState[], availableQuantity: (record: InventoryRecord) => number) {
  const stateSet = new Set(states)
  return records.filter((record) => stateSet.has(record.state)).reduce((total, record) => total + availableQuantity(record), 0)
}

function itemCategories(items: InventoryItemDefinition[]) {
  return Array.from(new Set(items.map((item) => item.category.trim()).filter(Boolean))).sort((first, second) =>
    first.localeCompare(second),
  )
}

function minimalUser(user: InventoryUser, currentUser: InventoryUser): InventoryUser {
  if (user.id === currentUser.id || hasPermission(currentUser, 'manage_users')) {
    return user
  }

  return {
    ...user,
    email: '',
    mustChangePassword: false,
  }
}

function visibleUsersForState(currentUser: InventoryUser, users: InventoryUser[]) {
  if (hasPermission(currentUser, 'manage_users')) {
    return users
  }
  return users.filter((user) => user.active || user.id === currentUser.id).map((user) => minimalUser(user, currentUser))
}

function redactActivityDetails(details: Record<string, unknown>) {
  const allowed = new Set([
    'active',
    'code',
    'expiresAt',
    'forced',
    'label',
    'name',
    'previousQuantity',
    'previousState',
    'quantity',
    'role',
    'sourceQuantity',
    'splitQuantity',
    'state',
    'userId',
  ])
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => allowed.has(key) && !key.toLowerCase().includes('password') && key.toLowerCase() !== 'email'),
  )
}

function visibleActivityForState(currentUser: InventoryUser, activity: InventoryActivity[]) {
  if (hasPermission(currentUser, 'manage_users')) {
    return activity
  }
  return activity.map((entry) => ({ ...entry, details: redactActivityDetails(entry.details) }))
}

function mobileSessionTokenForPayload(request: Request, token: string) {
  // Client-controlled mobile headers must never expose an ambient HttpOnly credential.
  if (coreEnabled() && coreCookieTokenForRequest(request) !== undefined) return undefined
  return isInventoryMobileAppRequest(request) ? token : undefined
}

function statePayload(currentUser: InventoryUser, csrfToken = '', sessionToken?: string, readOnly = false): InventoryStatePayload {
  if (currentUser.mustChangePassword) {
    return {
      currentUser,
      csrfToken,
      sessionToken,
      usersManagedByCore: coreEnabled(), coreLoginUrl: coreEnabled() ? process.env.DCO_CORE_LOGIN_URL || '/' : undefined,
      users: [currentUser],
      locations: [],
      items: [],
      categories: [],
      tags: [],
      categoryTags: [],
      recordTags: [],
      records: [],
      assignments: [],
      projects: [],
      activity: [],
      receipts: [],
      receiptLines: [],
      recordEvents: [],
      qrLabels: [],
      permissions: permissionsForRole(currentUser.role),
      totals: [],
      referenceRooms: [],
      generatedAt: nowIso(),
    }
  }

  const items = readItems()
  const records = readRecords()
  const users = readUsers()
  const assignments = readAssignments()
  const activityRange = currentMonthRange()
  const receipts = readReceipts()
  return {
    currentUser,
    csrfToken,
    sessionToken,
    usersManagedByCore: coreEnabled(), coreLoginUrl: coreEnabled() ? process.env.DCO_CORE_LOGIN_URL || '/' : undefined,
    users: visibleUsersForState(currentUser, users),
    locations: readLocations(),
    items,
    categories: itemCategories(items),
    tags: readTags(),
    categoryTags: readCategoryTags(),
    recordTags: readRecordTags(),
    records,
    assignments,
    projects: readProjects(),
    workflows: readWorkflowState(connection()),
    activity:
      hasPermission(currentUser, 'manage_users') || hasPermission(currentUser, 'adjust_stock')
        ? visibleActivityForState(currentUser, readActivityRange(activityRange.fromIso, activityRange.toIso))
        : [],
    receipts,
    receiptLines: readReceiptLines(receipts.map((receipt) => receipt.id)),
    recordEvents:
      hasPermission(currentUser, 'manage_users') || hasPermission(currentUser, 'adjust_stock') || hasPermission(currentUser, 'receive_stock')
        ? readRecordEvents()
        : [],
    qrLabels: readQrLabels(),
    permissions: readOnly ? permissionsForRole(currentUser.role).filter((permission) => ['read_inventory', 'export_inventory'].includes(permission)) : permissionsForRole(currentUser.role),
    totals: itemTotals(items, records, assignments),
    referenceRooms: referenceInventory.rooms,
    generatedAt: nowIso(),
  }
}

function sendUpdatedState(request: Request, response: Response, actor: InventoryUser, status = 200) {
  const context = requestAuthContexts.get(request)
  response
    .status(status)
    .json(statePayload(activeUserById(actor.id) ?? actor, context?.session.csrfToken ?? '', mobileSessionTokenForPayload(request, context?.sessionToken ?? ''), context?.coreReadOnly))
}

function handleRoute(response: Response, action: () => void | Promise<void>) {
  try {
    const result = action()
    if (result instanceof Promise) {
      void result.catch((error) => {
        if (!response.headersSent) {
          response.status(routeErrorStatus(error)).json({ message: error instanceof Error ? error.message : 'Inventory request failed.' })
        }
      })
    }
  } catch (error) {
    response.status(routeErrorStatus(error)).json({ message: error instanceof Error ? error.message : 'Inventory request failed.' })
  }
}

function csvEscape(value: unknown) {
  const raw = value === undefined || value === null ? '' : String(value)
  return /[",;\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function exportRows() {
  const projectsById = new Map(readProjects().map(project => [project.id, project]))
  const usersById = new Map(readUsers().map((user) => [user.id, user]))
  const itemsById = new Map(readItems().map((item) => [item.id, item]))
  const locationsById = new Map(readLocations().map((location) => [location.id, location]))
  const tagsById = new Map(readTags().map((tag) => [tag.id, tag]))
  const categoryTags = readCategoryTags()
  const recordTags = readRecordTags()
  const assignments = readAssignments()
  return readRecords().map((record) => {
    const item = itemsById.get(record.itemId)
    const location = locationsById.get(record.locationId)
    const tagNames = new Set<string>()
    recordTags.filter((tag) => tag.recordId === record.id).forEach((tag) => tagNames.add(tagsById.get(tag.tagId)?.name ?? ''))
    categoryTags.filter((tag) => tag.category === item?.category).forEach((tag) => tagNames.add(tagsById.get(tag.tagId)?.name ?? ''))
    const holders = assignments
      .filter((assignment) => assignment.recordId === record.id && !assignment.returnedAt && assignment.quantity > 0)
      .map((assignment) => usersById.get(assignment.userId)?.name)
      .filter(Boolean)
      .join('; ')
    return {
      recordId: record.id,
      sku: item?.sku ?? '',
      label: record.label ?? '',
      groupName: record.groupName ?? '',
      itemName: item?.name ?? '',
      category: item?.category ?? '',
      manufacturer: item?.manufacturer ?? '',
      model: item?.model ?? '',
      assetTag: record.assetTag ?? '',
      serialNumber: record.serialNumber ?? '',
      lotNumber: record.lotNumber ?? '',
      state: record.state,
      condition: record.condition,
      quantity: record.quantity,
      unit: item?.unit ?? '',
      locationCode: location?.code ?? '',
      locationName: location?.name ?? '',
      area: location?.area ?? '',
      rack: location?.rack ?? '',
      bin: location?.bin ?? '',
      supplier: record.supplier ?? '',
      orderReference: record.orderReference ?? '',
      unitCost: record.unitCost ?? '',
      requestedBy: usersById.get(record.requestedBy ?? '')?.name ?? '',
      orderedBy: usersById.get(record.orderedBy ?? '')?.name ?? '',
      receivedBy: usersById.get(record.receivedBy ?? '')?.name ?? '',
      lastCountedBy: usersById.get(record.lastCountedBy ?? '')?.name ?? '',
      activeHolders: holders,
      activeProjects: assignments.filter(assignment => assignment.recordId === record.id && assignment.projectId && !assignment.returnedAt && assignment.quantity > 0)
        .map(assignment => `${projectsById.get(assignment.projectId!)?.code}: ${projectsById.get(assignment.projectId!)?.name} (${assignment.quantity})`).join('; '),
      tags: Array.from(tagNames).filter(Boolean).join('; '),
      dueDate: record.dueDate ?? '',
      requestedAt: record.requestedAt ?? '',
      orderedAt: record.orderedAt ?? '',
      deliveredAt: record.deliveredAt ?? '',
      stockedAt: record.stockedAt ?? '',
      notes: record.notes ?? '',
      updatedAt: record.updatedAt,
    }
  })
}

function exportCsv() {
  const rows = exportRows()
  const headers = [
    'recordId',
    'sku',
    'label',
    'groupName',
    'itemName',
    'category',
    'manufacturer',
    'model',
    'assetTag',
    'serialNumber',
    'lotNumber',
    'state',
    'condition',
    'quantity',
    'unit',
    'locationCode',
    'locationName',
    'area',
    'rack',
    'bin',
    'supplier',
    'orderReference',
    'unitCost',
    'requestedBy',
    'orderedBy',
    'receivedBy',
    'lastCountedBy',
    'activeHolders',
    'activeProjects',
    'tags',
    'dueDate',
    'requestedAt',
    'orderedAt',
    'deliveredAt',
    'stockedAt',
    'notes',
    'updatedAt',
  ] as const
  return [headers.join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')
}

function normalizeLookup(value: string) {
  return value.trim().toLocaleLowerCase('de-DE').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
}

function matchImportedRows(rows: ReceivingImportRow[]) {
  const items = readItems()
  const locations = readLocations()
  const users = readUsers()
  const itemLookup = new Map<string, InventoryItemDefinition>()
  for (const item of items) {
    ;[item.id, item.sku, item.name, item.manufacturerPartNumber, item.lcscPartNumber].filter(Boolean)
      .forEach((value) => itemLookup.set(normalizeLookup(String(value)), item))
  }
  const locationLookup = new Map<string, InventoryLocation>()
  for (const location of locations) {
    ;[location.id, location.code, location.name].filter(Boolean)
      .forEach((value) => locationLookup.set(normalizeLookup(String(value)), location))
  }
  const userLookup = new Map<string, InventoryUser>()
  for (const user of users) {
    userLookup.set(normalizeLookup(user.name), user)
    const initials = user.name.split(/\s+/).map((part) => part[0]).join('')
    if (initials) userLookup.set(normalizeLookup(initials), user)
  }
  return rows.map((row) => {
    const item = itemLookup.get(normalizeLookup(row.itemName))
    const location = locationLookup.get(normalizeLookup(row.locationName))
    const receiver = row.receiverLabel ? userLookup.get(normalizeLookup(row.receiverLabel)) : undefined
    const warnings = [...row.warnings]
    if (!item) warnings.push('Item is new and will be added to the catalog after confirmation.')
    if (!location) warnings.push('Location is new and will be added after confirmation.')
    if (row.receiverLabel && !receiver) warnings.push('Receiver initials could not be matched; the original initials will be retained.')
    return { ...row, itemId: item?.id, locationId: location?.id, receiverId: receiver?.id, warnings }
  })
}

async function importMatrices(fileName: string, contentBase64: string) {
  const safeName = basename(fileName).slice(0, 180)
  const buffer = Buffer.from(contentBase64, 'base64')
  if (!safeName || buffer.length === 0 || buffer.length > 4 * 1024 * 1024) throw new Error('Import file must be between 1 byte and 4 MB.')
  const extension = extname(safeName).toLowerCase()
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    return rowsFromMatrix(parseCsv(buffer.toString('utf8').replace(/^\uFEFF/, '')), safeName)
  }
  if (extension !== '.xlsx') throw new Error('Only CSV, TSV, and XLSX files are supported.')
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as never)
  const rows: ReceivingImportRow[] = []
  workbook.eachSheet((sheet) => {
    const matrix: unknown[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      matrix.push((row.values as unknown[]).slice(1).map((value) => {
        if (value && typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text)
        if (value && typeof value === 'object' && 'result' in value) return (value as { result: unknown }).result
        return value
      }))
    })
    try {
      rows.push(...rowsFromMatrix(matrix, safeName, sheet.name))
    } catch {
      // Monthly workbooks often contain helper sheets; only sheets with a recognizable receipt table are imported.
    }
  })
  if (rows.length === 0) throw new Error('No recognizable receipt rows were found in the workbook.')
  return rows
}

function persistAttachment(body: Record<string, unknown>, receiptId: string) {
  const fileName = parseString(body.attachmentName, 180)
  const contentBase64 = parseString(body.attachmentBase64, 6_000_000)
  if (!fileName && !contentBase64) return undefined
  if (!fileName || !contentBase64) throw new Error('Attachment name and content are both required.')
  const extension = extname(fileName).toLowerCase()
  if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('Delivery note attachments must be PDF, PNG, JPG, or WebP.')
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) throw new Error('Delivery note attachment must be no larger than 4 MB.')
  mkdirSync(inventoryMediaPath, { recursive: true })
  const storedName = `${receiptId}${extension}`
  writeFileSync(join(inventoryMediaPath, storedName), bytes, { flag: 'wx', mode: 0o600 })
  return { attachmentName: basename(fileName), attachmentPath: `api/inventorySystem/receipts/${receiptId}/attachment` }
}

function importItem(database: DatabaseSync, row: ReceivingImportRow) {
  const existing = row.itemId ? itemById(row.itemId) : undefined
  if (existing) return existing
  const timestamp = nowIso()
  const item: InventoryItemDefinition = {
    id: randomUUID(), sku: '', name: parseString(row.itemName, 220), category: 'Imported receipts', unit: 'pcs', minQuantity: 0,
    reorderQuantity: 0, active: true, createdAt: timestamp, updatedAt: timestamp,
  }
  insertItem(database, item)
  return item
}

function importLocation(database: DatabaseSync, row: ReceivingImportRow) {
  const existing = row.locationId ? locationById(row.locationId) : undefined
  if (existing) return existing
  const timestamp = nowIso()
  const location: InventoryLocation = {
    id: randomUUID(), name: parseString(row.locationName, 180), code: '', kind: 'room', active: true,
    description: 'Created from a reviewed goods-receipt import.', createdAt: timestamp, updatedAt: timestamp,
  }
  insertLocation(database, location)
  return location
}

function qrTargetExists(targetType: InventoryQrTargetType, targetId: string) {
  if (targetType === 'item') return Boolean(itemById(targetId))
  if (targetType === 'record') return Boolean(recordById(targetId))
  if (targetType === 'place') return Boolean(locationById(targetId))
  return itemCategories(readItems()).includes(targetId)
}

function qrLabelById(id: string) {
  const row = connection().prepare(`SELECT * FROM inventory_qr_labels WHERE id = ?`).get(id) as unknown as InventoryQrLabelRow | undefined
  return row ? readQrLabels().find((label) => label.id === row.id) : undefined
}

function qrLabelFromBody(body: Record<string, unknown>, actor: InventoryUser, existing?: InventoryQrLabel): InventoryQrLabel {
  const id = existing?.id ?? parseString(body.id, 80)
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('A valid QR label id is required.')
  const targetType = parseQrTargetType(body.targetType, existing?.targetType ?? 'item')
  const targetId = parseString(body.targetId ?? existing?.targetId, 220)
  const name = parseString(body.name ?? existing?.name, 180)
  if (!name || !targetId) throw new Error('Label name and destination are required.')
  if (!qrTargetExists(targetType, targetId)) throw new Error('The selected QR destination no longer exists.')
  const timestamp = nowIso()
  return {
    id,
    name,
    targetType,
    targetId,
    active: parseBoolean(body.active, existing?.active ?? true),
    createdBy: existing?.createdBy ?? actor.id,
    updatedBy: actor.id,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
}

function receiptCsv(receipts: InventoryReceipt[], lines: InventoryReceiptLine[]) {
  const items = new Map(readItems().map((item) => [item.id, item]))
  const locations = new Map(readLocations().map((location) => [location.id, location]))
  const headers = ['Date', 'Article', 'SKU', 'Original quantity', 'Packaging description', 'Original location', 'Receiver', 'Supplier', 'Order reference', 'Delivery note', 'Discrepancy', 'Discrepancy quantity', 'Notes', 'Source', 'Needs review', 'Status', 'Current record quantity', 'Current record location', 'Entry date', 'Entry type', 'Quantity before', 'Quantity after', 'Reason', 'Actor', 'Quantity change']
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]))
  const rows = lines.flatMap((line) => {
    const receipt = receiptsById.get(line.receiptId)
    const record = recordById(line.recordId)
    const events = connection().prepare(`SELECT * FROM inventory_record_events WHERE recordId = ? AND eventType IN ('corrected', 'reversed') ORDER BY createdAt, id`).all(line.recordId) as unknown as InventoryRecordEventRow[]
    const corrected = events.some((event) => event.eventType === 'corrected')
    const status = line.reversedByEventId ? 'reversed' : record?.quarantined ? 'quarantined' : line.releasedByEventId ? 'released' : corrected ? 'corrected' : line.reviewRequired ? 'review' : 'posted'
    const needsReview = !line.reversedByEventId && (record?.quarantined || (line.reviewRequired && !corrected && !line.releasedByEventId))
    const original = [receipt?.receivedAt.slice(0, 10), items.get(line.itemId)?.name, items.get(line.itemId)?.sku, line.quantity, line.quantityLabel, locations.get(line.locationId)?.name, receipt?.receiverLabel, receipt?.supplier, receipt?.orderReference, receipt?.deliveryNoteNumber, line.discrepancy, line.discrepancyQuantity, line.notes, line.sourceReference, needsReview ? 'yes' : 'no', status, record?.quantity, record ? locations.get(record.locationId)?.name : '']
    return [[...original, receipt?.createdAt, 'received', '', line.quantity, receipt?.notes, receipt?.receiverLabel, line.quantity], ...events.map((event) => {
      const before = event.beforeJson ? parseOptionalNumber(parseJsonDetails(event.beforeJson).quantity) : undefined
      const after = event.afterJson ? parseOptionalNumber(parseJsonDetails(event.afterJson).quantity) : undefined
      const adjustment = [...original]
      adjustment[3] = undefined
      adjustment[16] = undefined
      adjustment[17] = undefined
      return [...adjustment, event.createdAt, event.eventType, before, after, event.reason, event.actorLabel, before === undefined || after === undefined ? '' : after - before]
    })]
  })
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvEscape).join(';')).join('\r\n')}`
}

inventorySystemRouter.get('/health', (_request, response) => {
  response.json({ ok: true, dataFile: inventorySystemDataFilePath() })
})

inventorySystemRouter.post('/auth/login', (request, response) => {
  if (coreEnabled()) {
    if (!isInventoryMobileAppRequest(request)) {
      response.status(409).json({ message: 'Sign in through Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' })
      return
    }
    handleRoute(response, async () => {
      const body = request.body as Record<string, unknown>
      const login = await loginWithCore(request, parseString(body.email, 180), typeof body.password === 'string' ? body.password : '', body.stayLoggedIn === true)
      request.headers.authorization = `Bearer ${login.sessionToken}`
      delete request.headers.cookie
      const context = await coreSessionContext(request)
      requestAuthContexts.set(request, context)
      response.json(statePayload(context.user, context.session.csrfToken, context.sessionToken, context.coreReadOnly))
    })
    return
  }
  if (process.env.DISABLE_LOCAL_WEB_LOGIN === 'true' && !isInventoryMobileAppRequest(request)) {
    response.status(409).json({
      message: 'Sign in through Digital Core Office.',
      loginUrl: process.env.DCO_CORE_LOGIN_URL || '/',
    })
    return
  }
  handleRoute(response, () => {
    const body = request.body as Record<string, unknown>
    const email = parseString(body.email, 180).toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    const stayLoggedIn = parseBoolean(body.stayLoggedIn, false)
    const key = loginRateKey(request, email)
    if (!email || !password || isLoginRateLimited(key)) {
      if (password) performFakePasswordCheck(password)
      response.status(401).json({ message: 'Email or password is incorrect.' })
      return
    }

    const database = connection()
    const user = userByEmailFromDatabase(database, email)
    const credential = user ? credentialForUserIdFromDatabase(database, user.id) : undefined
    if (!user || !user.active || !credential) {
      performFakePasswordCheck(password)
      registerLoginFailure(key)
      response.status(401).json({ message: 'Email or password is incorrect.' })
      return
    }

    if (credentialIsLocked(credential)) {
      response.status(429).json({ message: 'Too many sign-in attempts. Try again later.' })
      return
    }

    if (!verifyPassword(password, credential)) {
      registerLoginFailure(key)
      registerCredentialFailure(database, credential)
      response.status(401).json({ message: 'Email or password is incorrect.' })
      return
    }

    clearLoginFailures(key)
    clearCredentialFailures(database, user.id)
    const { token, session } = createSession(database, user, request, stayLoggedIn)
    const cookies = [sessionCookie(token, request, stayLoggedIn ? Math.floor(persistentSessionDurationMs / 1000) : undefined)]
    if (!isInventoryMobileAppRequest(request)) {
      cookies.push(digitalOfficeSsoCookie(request, user, stayLoggedIn))
    }
    response.setHeader('Set-Cookie', cookies)
    logActivity(database, user, 'user_login', { email: user.email })
    response.json(statePayload(user, session.csrfToken, mobileSessionTokenForPayload(request, token)))
  })
})

inventorySystemRouter.post('/auth/qr-login/claim', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Use Core sign-in or sign in to the mobile app with your Core account.' }); return }
  handleRoute(response, () => {
    const token = parseString((request.body as Record<string, unknown>).token, 240)
    if (!token) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    const database = connection()
    cleanupExpiredSessions(database)
    const grant = database
      .prepare(`SELECT * FROM inventory_qr_login_grants WHERE tokenHash = ?`)
      .get(hashToken(token)) as unknown as InventoryQrLoginGrantRow | undefined
    if (!grant || grant.usedAt || new Date(grant.expiresAt).getTime() <= Date.now()) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    const user = activeUserById(grant.userId)
    if (!user) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    database.prepare(`UPDATE inventory_qr_login_grants SET usedAt = ? WHERE id = ?`).run(nowIso(), grant.id)
    const { token: sessionToken, session } = createSession(database, user, request)
    const cookies = [sessionCookie(sessionToken, request)]
    if (!isInventoryMobileAppRequest(request)) {
      cookies.push(digitalOfficeSsoCookie(request, user, false))
    }
    response.setHeader('Set-Cookie', cookies)
    logActivity(database, user, 'qr_login_claimed', {})
    response.json(statePayload(user, session.csrfToken, mobileSessionTokenForPayload(request, sessionToken)))
  })
})

inventorySystemRouter.post('/auth/qr-login/challenges', (_request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Create QR sign-in challenges through Digital Core Office.' }); return }
  handleRoute(response, () => {
    const database = connection()
    cleanupExpiredSessions(database)
    const token = randomToken(32)
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + qrLoginGrantDurationMs).toISOString()
    database
      .prepare(
        `INSERT INTO inventory_qr_login_challenges
         (id, tokenHash, approvedByUserId, approvedAt, expiresAt, usedAt, createdAt)
         VALUES (?, ?, NULL, NULL, ?, NULL, ?)`,
      )
      .run(randomUUID(), hashToken(token), expiresAt, createdAt)
    response.status(201).json({ token, expiresAt })
  })
})

inventorySystemRouter.post('/auth/qr-login/challenges/claim', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Claim QR sign-in through Digital Core Office.' }); return }
  handleRoute(response, () => {
    const token = parseString((request.body as Record<string, unknown>).token, 240)
    if (!token) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    const database = connection()
    cleanupExpiredSessions(database)
    const challenge = database
      .prepare(`SELECT * FROM inventory_qr_login_challenges WHERE tokenHash = ?`)
      .get(hashToken(token)) as unknown as InventoryQrLoginChallengeRow | undefined
    if (!challenge || challenge.usedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }
    if (!challenge.approvedByUserId) {
      response.status(202).json({ pending: true, expiresAt: challenge.expiresAt })
      return
    }

    const user = activeUserById(challenge.approvedByUserId)
    if (!user) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    database.prepare(`UPDATE inventory_qr_login_challenges SET usedAt = ? WHERE id = ?`).run(nowIso(), challenge.id)
    const { token: sessionToken, session } = createSession(database, user, request)
    const cookies = [sessionCookie(sessionToken, request)]
    if (!isInventoryMobileAppRequest(request)) {
      cookies.push(digitalOfficeSsoCookie(request, user, false))
    }
    response.setHeader('Set-Cookie', cookies)
    logActivity(database, user, 'qr_login_claimed', { challenge: true })
    response.json(statePayload(user, session.csrfToken, mobileSessionTokenForPayload(request, sessionToken)))
  })
})

inventorySystemRouter.use(requireInventorySession)
inventorySystemRouter.use(requireInventoryCsrf)

inventorySystemRouter.post('/auth/logout', (request, response) => {
  if (coreEnabled()) {
    handleRoute(response, async () => { await logoutFromCore(request); response.setHeader('Set-Cookie', [clearSessionCookie(request), coreSessionCookie(request, '')]); response.json({ ok: true }) })
    return
  }
  destroySessionForRequest(request)
  response.setHeader('Set-Cookie', [clearSessionCookie(request), clearDigitalOfficeSsoCookie(request)])
  response.json({ ok: true })
})

inventorySystemRouter.post('/auth/password', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Manage your password in Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' }); return }
  handleRoute(response, () => {
    const actor = actorForRequest(request)
    if (!actor) {
      response.status(401).json({ message: 'Sign in to use the inventory system.' })
      return
    }

    const body = request.body as Record<string, unknown>
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    const database = connection()
    const credential = credentialForUserIdFromDatabase(database, actor.id)
    if (!credential || !currentPassword || !verifyPassword(currentPassword, credential)) {
      response.status(403).json({ message: 'Current password is incorrect.' })
      return
    }

    validatePassword(newPassword, actor.email, actor.name)
    setUserPassword(database, actor.id, newPassword, actor)
    const updatedUser: InventoryUser = { ...actor, mustChangePassword: false, updatedAt: nowIso() }
    updateUser(database, updatedUser)
    logActivity(database, updatedUser, 'password_changed', { forced: actor.mustChangePassword })
    requestAuthContexts.set(request, { ...requestAuthContexts.get(request)!, user: updatedUser })
    if (!isInventoryMobileAppRequest(request)) {
      response.setHeader('Set-Cookie', digitalOfficeSsoCookie(request, updatedUser, true))
    }
    sendUpdatedState(request, response, updatedUser)
  })
})

inventorySystemRouter.post('/auth/qr-login', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Create QR sign-in through Digital Core Office.' }); return }
  handleRoute(response, () => {
    const actor = actorForRequest(request)
    if (!actor) {
      response.status(401).json({ message: 'Sign in to use the inventory system.' })
      return
    }
    if (actor.mustChangePassword) {
      response.status(428).json({ message: 'Password change required.' })
      return
    }
    const database = connection()
    cleanupExpiredSessions(database)
    const token = randomToken(32)
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + qrLoginGrantDurationMs).toISOString()
    database
      .prepare(`INSERT INTO inventory_qr_login_grants (id, userId, tokenHash, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(randomUUID(), actor.id, hashToken(token), expiresAt, createdAt)
    logActivity(database, actor, 'qr_login_created', { expiresAt })
    response.status(201).json({ token, expiresAt })
  })
})

inventorySystemRouter.get('/state', (request, response) => {
  const actor = actorForRequest(request)
  if (!actor) {
    response.status(401).json({ message: 'Sign in to use the inventory system.' })
    return
  }
  const context = requestAuthContexts.get(request)
  response.json(statePayload(actor, context?.session.csrfToken ?? '', mobileSessionTokenForPayload(request, context?.sessionToken ?? ''), context?.coreReadOnly))
})

inventorySystemRouter.use(requireInventoryPasswordReady)

inventorySystemRouter.post('/auth/qr-login/challenges/approve', (request, response) => {
  handleRoute(response, async () => {
    const actor = requirePermission(request, response, 'read_inventory')
    if (!actor) return
    const token = parseString((request.body as Record<string, unknown>).token, 240)
    if (!token) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }

    if (coreEnabled()) {
      response.json(await approveCoreQr(request, token))
      return
    }

    const database = connection()
    cleanupExpiredSessions(database)
    const challenge = database
      .prepare(`SELECT * FROM inventory_qr_login_challenges WHERE tokenHash = ?`)
      .get(hashToken(token)) as unknown as InventoryQrLoginChallengeRow | undefined
    if (!challenge) {
      response.status(401).json({ message: 'QR sign-in is invalid or expired.' })
      return
    }
    if (challenge.usedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) {
      response.status(401).json({ message: 'QR login is invalid or expired.' })
      return
    }
    if (challenge.approvedByUserId && challenge.approvedByUserId !== actor.id) {
      response.status(409).json({ message: 'This QR login was already approved.' })
      return
    }

    const approvedAt = nowIso()
    database
      .prepare(`UPDATE inventory_qr_login_challenges SET approvedByUserId = ?, approvedAt = ? WHERE id = ?`)
      .run(actor.id, approvedAt, challenge.id)
    logActivity(database, actor, 'qr_login_approved', { challenge: true, expiresAt: challenge.expiresAt })
    response.json({ ok: true, expiresAt: challenge.expiresAt })
  })
})

inventorySystemRouter.get('/activity', (request, response) => {
  const actor = requirePermission(request, response, 'read_inventory')
  if (!actor) return
  if (!hasPermission(actor, 'manage_users') && !hasPermission(actor, 'adjust_stock')) {
    response.json({ activity: [] })
    return
  }

  const from = parseIsoDateTime(request.query.from, currentMonthRange().fromIso)
  const to = parseIsoDateTime(request.query.to, currentMonthRange().toIso)
  response.json({ activity: visibleActivityForState(actor, readActivityRange(from, to)) })
})

inventorySystemRouter.post('/qr-labels', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'read_inventory')
    if (!actor) return
    const label = qrLabelFromBody(request.body as Record<string, unknown>, actor)
    if (qrLabelById(label.id)) { response.status(409).json({ message: 'QR label already exists.' }); return }
    connection().prepare(
      `INSERT INTO inventory_qr_labels (id, name, targetType, targetId, active, createdBy, updatedBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(label.id, label.name, label.targetType, label.targetId, 1, label.createdBy, label.updatedBy, label.createdAt, label.updatedAt)
    logActivity(connection(), actor, 'qr_label_created', { labelId: label.id, name: label.name, targetType: label.targetType, targetId: label.targetId })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/qr-labels/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'read_inventory')
    if (!actor) return
    const existing = qrLabelById(request.params.id)
    if (!existing) { response.status(404).json({ message: 'QR label not found.' }); return }
    const label = qrLabelFromBody(request.body as Record<string, unknown>, actor, existing)
    connection().prepare(
      `UPDATE inventory_qr_labels SET name = ?, targetType = ?, targetId = ?, active = ?, updatedBy = ?, updatedAt = ? WHERE id = ?`,
    ).run(label.name, label.targetType, label.targetId, label.active ? 1 : 0, label.updatedBy, label.updatedAt, label.id)
    logActivity(connection(), actor, 'qr_label_updated', {
      labelId: label.id,
      previousName: existing.name,
      name: label.name,
      previousTargetType: existing.targetType,
      targetType: label.targetType,
      previousTargetId: existing.targetId,
      targetId: label.targetId,
      active: label.active,
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.delete('/qr-labels/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'read_inventory')
    if (!actor) return
    const existing = qrLabelById(request.params.id)
    if (!existing) { response.status(404).json({ message: 'QR label not found.' }); return }
    connection().prepare(`UPDATE inventory_qr_labels SET active = 0, updatedBy = ?, updatedAt = ? WHERE id = ?`).run(actor.id, nowIso(), existing.id)
    logActivity(connection(), actor, 'qr_label_deactivated', { labelId: existing.id, name: existing.name, targetType: existing.targetType, targetId: existing.targetId })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/tags', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_catalog')
    if (!actor) return

    const tag = tagFromBody(request.body as Record<string, unknown>)
    const database = connection()
    insertTag(database, tag)
    logActivity(database, actor, 'tag_created', { tagId: tag.id, name: tag.name })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.delete('/tags/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_catalog')
    if (!actor) return
    const tag = tagById(request.params.id)
    if (!tag) {
      response.status(404).json({ message: 'Tag not found.' })
      return
    }
    const database = connection()
    database.prepare(`DELETE FROM inventory_tags WHERE id = ?`).run(tag.id)
    logActivity(database, actor, 'tag_deleted', { tagId: tag.id, name: tag.name })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/users', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Manage users and Inventory roles in Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' }); return }
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_users')
    if (!actor) return

    const body = request.body as Record<string, unknown>
    const user = userFromBody(body)
    const password = passwordFromBody(body, true, user.email, user.name)
    if (!password) {
      throw new Error('Password is required.')
    }
    if (duplicateUserEmailExists(user.email)) {
      response.status(409).json({ message: 'A user with this email already exists.' })
      return
    }

    const database = connection()
    insertUser(database, user)
    setUserPassword(database, user.id, password, user)
    logActivity(database, actor, 'user_created', { userId: user.id, role: user.role })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/users/:id', (request, response) => {
  if (coreEnabled()) { response.status(409).json({ message: 'Manage users and Inventory roles in Digital Core Office.', loginUrl: process.env.DCO_CORE_LOGIN_URL || '/' }); return }
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_users')
    if (!actor) return

    const existing = readUsers().find((user) => user.id === request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Inventory user not found.' })
      return
    }

    const body = request.body as Record<string, unknown>
    const user = userFromBody(body, existing)
    const password = passwordFromBody(body, false, user.email, user.name)
    if (duplicateUserEmailExists(user.email, user.id)) {
      response.status(409).json({ message: 'A user with this email already exists.' })
      return
    }

    const database = connection()
    updateUser(database, user)
    if (password) {
      setUserPassword(database, user.id, password, user)
    }
    logActivity(database, actor, 'user_updated', { userId: user.id, role: user.role, active: user.active, passwordChanged: Boolean(password) })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/locations', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_locations')
    if (!actor) return

    const location = locationFromBody(request.body as Record<string, unknown>)
    if (duplicateLocationCodeExists(location.code)) {
      response.status(409).json({ message: 'A location with this code already exists.' })
      return
    }

    const database = connection()
    insertLocation(database, location)
    logActivity(database, actor, 'location_created', { code: location.code, name: location.name })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/locations/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_locations')
    if (!actor) return

    const existing = locationById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Location not found.' })
      return
    }

    const location = locationFromBody(request.body as Record<string, unknown>, existing)
    if (duplicateLocationCodeExists(location.code, location.id)) {
      response.status(409).json({ message: 'A location with this code already exists.' })
      return
    }

    const database = connection()
    updateLocation(database, location)
    logActivity(database, actor, 'location_updated', { code: location.code, name: location.name })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/items', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_catalog')
    if (!actor) return

    const body = request.body as Record<string, unknown>
    const item = itemFromBody(body)
    if (duplicateSkuExists(item.sku)) {
      response.status(409).json({ message: 'An item with this SKU already exists.' })
      return
    }

    const database = connection()
    transaction(database, () => {
    insertItem(database, item)
    saveCatalogPhoto(database, item, body.photoData)
    setCategoryTags(database, item.category, parseTagIds(body.categoryTagIds))
    logActivity(database, actor, 'item_created', { sku: item.sku, name: item.name, projectIds: item.projectIds }, item.id)
    })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/items/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_catalog')
    if (!actor) return

    const existing = itemById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Item not found.' })
      return
    }

    const body = request.body as Record<string, unknown>
    const item = itemFromBody(body, existing)
    if (duplicateSkuExists(item.sku, item.id)) {
      response.status(409).json({ message: 'An item with this SKU already exists.' })
      return
    }

    const database = connection()
    transaction(database, () => {
    updateItem(database, item)
    saveCatalogPhoto(database, item, body.photoData)
    if ('categoryTagIds' in body) {
      setCategoryTags(database, item.category, parseTagIds(body.categoryTagIds))
    }
    logActivity(database, actor, 'item_updated', { sku: item.sku, name: item.name, active: item.active, projectIds: item.projectIds }, item.id)
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.delete('/items/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_catalog')
    if (!actor) return
    const existing = itemById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Item not found.' })
      return
    }
    if (itemRecordCount(existing.id) > 0 || workflowUsesItem(connection(), existing.id)) {
      response.status(409).json({ message: 'This item has stock records. Delete or move those records before deleting the catalog item.' })
      return
    }
    const database = connection()
    database.prepare(`DELETE FROM inventory_items WHERE id = ?`).run(existing.id)
    logActivity(database, actor, 'item_deleted', { sku: existing.sku, name: existing.name }, existing.id)
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/records', (request, response) => {
  handleRoute(response, () => {
    const body = request.body as Record<string, unknown>
    const state = parseState(body.state, 'requested')
    const actor = requireRecordWritePermission(request, response, state)
    if (!actor) return

    const input = recordInputFromBody(body, actor)
    const tagIds = parseTagIds(body.tagIds)
    const individualize = parseBoolean(body.individualize, false) && Number.isInteger(input.quantity) && input.quantity > 1
    const createdAt = nowIso()
    const recordsToCreate: InventoryRecord[] = individualize
      ? Array.from({ length: input.quantity }, (_, index) => ({
          id: randomUUID(),
          version: 1,
          quarantined: false,
          ...input,
          label: `${input.label ?? itemById(input.itemId)?.name ?? 'Piece'} ${index + 1}`,
          quantity: 1,
          createdAt,
          updatedAt: createdAt,
        }))
      : [
          {
            id: randomUUID(),
            version: 1,
            quarantined: false,
            ...input,
            createdAt,
            updatedAt: createdAt,
          },
        ]
    const database = connection()
    database.exec(`BEGIN TRANSACTION;`)
    try {
      for (const record of recordsToCreate) {
        insertRecord(database, record)
        setRecordTags(database, record.id, tagIds)
        auditRecordChange(database, actor, 'created', record, undefined, parseOptionalString(body.changeReason, 500) ?? 'Record created.')
        logActivity(database, actor, 'record_created', { state: record.state, quantity: record.quantity, label: record.label }, record.itemId, record.id)
      }
      database.exec(`COMMIT;`)
    } catch (error) {
      database.exec(`ROLLBACK;`)
      throw error
    }
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.post('/records/:id/split', (request, response) => {
  handleRoute(response, () => {
    const existing = recordById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Inventory record not found.' })
      return
    }

    const body = request.body as Record<string, unknown>
    const tagIds = parseTagIds(body.tagIds)
    const nextState = parseState(body.state, existing.state)
    const actor = requireRecordTransitionPermission(request, response, existing, nextState, true)
    if (!actor) return
    assertExpectedVersion(body.expectedVersion, existing)
    if (existing.quarantined) throw new Error('Release this receipt from quarantine before splitting it.')

    const splitQuantity = parseNumber(body.quantity, 0)
    if (splitQuantity <= 0 || splitQuantity >= existing.quantity) {
      response.status(400).json({ message: 'Split quantity must be greater than 0 and smaller than the source quantity.' })
      return
    }

    const input = recordInputFromBody(
      {
        ...existing,
        ...body,
        itemId: existing.itemId,
        quantity: splitQuantity,
      },
      actor,
      existing,
    )
    const updatedAt = nowIso()
    const sourceRecord: InventoryRecord = {
      ...existing,
      quantity: existing.quantity - splitQuantity,
      updatedAt,
    }
    assertAssignmentIntegrity(existing, sourceRecord)
    const splitRecord: InventoryRecord = {
      ...existing,
      ...input,
      id: randomUUID(),
      version: 1,
      createdAt: updatedAt,
      updatedAt,
    }

    const database = connection()
    database.exec(`BEGIN TRANSACTION;`)
    try {
      updateRecord(database, sourceRecord)
      insertRecord(database, splitRecord)
      auditRecordChange(database, actor, 'changed', sourceRecord, existing, parseOptionalString(body.changeReason, 500) ?? 'Record split.')
      auditRecordChange(database, actor, 'created', splitRecord, undefined, parseOptionalString(body.changeReason, 500) ?? 'Created by splitting another record.')
      if ('tagIds' in body) {
        setRecordTags(database, splitRecord.id, tagIds)
      }
      logActivity(
        database,
        actor,
        'record_split',
        {
          sourceRecordId: sourceRecord.id,
          splitRecordId: splitRecord.id,
          sourceQuantity: sourceRecord.quantity,
          splitQuantity: splitRecord.quantity,
          state: splitRecord.state,
          label: splitRecord.label,
        },
        splitRecord.itemId,
        splitRecord.id,
      )
      database.exec(`COMMIT;`)
    } catch (error) {
      database.exec(`ROLLBACK;`)
      throw error
    }
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/records/:id', (request, response) => {
  handleRoute(response, () => {
    const existing = recordById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Inventory record not found.' })
      return
    }

    const nextState = parseState((request.body as Record<string, unknown>).state, existing.state)
    const actor = requireRecordTransitionPermission(request, response, existing, nextState)
    if (!actor) return
    if (nextState === 'in_stock' && ['ordered', 'delivered'].includes(existing.state)) {
      response.status(409).json({ message: 'Use goods receiving with this source order to move it into stock.' })
      return
    }

    const body = request.body as Record<string, unknown>
    const input = recordInputFromBody(body, actor, existing)
    assertExpectedVersion(body.expectedVersion, existing)
    if (existing.quarantined && (input.state !== existing.state || input.condition !== existing.condition || input.itemId !== existing.itemId)) {
      throw new Error('Use the receipt review and release action to change quarantined stock availability or item classification.')
    }
    const record: InventoryRecord = {
      ...existing,
      ...input,
      updatedAt: nowIso(),
    }
    assertAssignmentIntegrity(existing, record)

    const changedFields = Object.keys(record).filter((key) => key !== 'updatedAt' && JSON.stringify(record[key as keyof InventoryRecord]) !== JSON.stringify(existing[key as keyof InventoryRecord]))
    const changeReason = parseOptionalString(body.changeReason, 500)
    const consequentialFields = changedFields.filter((key) => !['state', 'requestedBy', 'orderedBy', 'receivedBy', 'requestedAt', 'orderedAt', 'deliveredAt', 'stockedAt'].includes(key))
    if (['delivered', 'in_stock', 'reserved', 'in_use', 'maintenance', 'damaged'].includes(existing.state) && (consequentialFields.length > 0 || record.state === 'retired') && !changeReason) {
      response.status(400).json({ message: 'A correction reason is required when received stock details are changed.' })
      return
    }

    const database = connection()
    transaction(database, () => {
      updateRecord(database, record)
      auditRecordChange(database, actor, consequentialFields.length > 0 ? 'corrected' : 'changed', record, existing, changeReason ?? `State changed from ${existing.state} to ${record.state}.`)
    if ('tagIds' in body) {
      setRecordTags(database, record.id, parseTagIds(body.tagIds))
    }
    logActivity(
      database,
      actor,
      'record_updated',
      { previousState: existing.state, state: record.state, previousQuantity: existing.quantity, quantity: record.quantity },
      record.itemId,
      record.id,
    )
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/projects', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_projects')
    if (!actor) return
    const body = request.body as Record<string, unknown>
    const name = parseString(body.name, 200)
    const code = parseString(body.code, 80)
    if (!name || !code) throw new Error('Enter a project name and code.')
    if (readProjects().some(project => project.code.toLowerCase() === code.toLowerCase())) throw new Error('This project code is already in use.')
    const project: InventoryProject = { id: randomUUID(), name, code, description: parseOptionalString(body.description, 2000), active: true, createdAt: nowIso(), updatedAt: nowIso() }
    const database = connection()
    transaction(database, () => {
      database.prepare('INSERT INTO inventory_projects (id, name, code, description, active, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(project.id, project.name, project.code, project.description ?? null, project.createdAt, project.updatedAt)
      logActivity(database, actor, 'project_created', { projectId: project.id, name, code })
    })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.patch('/projects/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'manage_projects')
    if (!actor) return
    const existing = readProjects().find(project => project.id === request.params.id)
    if (!existing) { response.status(404).json({ message: 'Inventory project not found.' }); return }
    const body = request.body as Record<string, unknown>
    if (body.expectedUpdatedAt !== existing.updatedAt) throw Object.assign(new Error('This project changed. Reopen it and review the current values.'), { status: 409 })
    const name = body.name === undefined ? existing.name : parseString(body.name, 200)
    const code = body.code === undefined ? existing.code : parseString(body.code, 80)
    if (!name || !code) throw new Error('Enter a project name and code.')
    if (readProjects().some(project => project.id !== existing.id && project.code.toLowerCase() === code.toLowerCase())) throw new Error('This project code is already in use.')
    if (body.active !== undefined && typeof body.active !== 'boolean') throw new Error('Project active state must be a boolean.')
    const active = body.active === undefined ? existing.active : body.active
    if (!active && readAssignments().some(assignment => assignment.projectId === existing.id && !assignment.returnedAt && assignment.quantity > 0)) {
      throw new Error('Return all project items before archiving this project.')
    }
    const description = body.description === undefined ? existing.description : parseOptionalString(body.description, 2000)
    const workflow = readWorkflowState(connection())
    if (!active && (workflow.builds.some(build => build.projectId === existing.id && !build.cancelled && build.completedQuantity < build.quantity) || workflow.requests.some(request => request.projectId === existing.id && !['cancelled', 'fulfilled'].includes(request.status)))) throw new Error('Close open builds, requests and deliveries before archiving this project.')
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString()
    const database = connection()
    transaction(database, () => {
      database.prepare('UPDATE inventory_projects SET name = ?, code = ?, description = ?, active = ?, updatedAt = ? WHERE id = ?')
        .run(name, code, description ?? null, active ? 1 : 0, updatedAt, existing.id)
      logActivity(database, actor, 'project_updated', { projectId: existing.id, name, code, active })
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/records/:id/assignments', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'adjust_stock')
    if (!actor) return
    const record = recordById(request.params.id)
    if (!record) {
      response.status(404).json({ message: 'Inventory record not found.' })
      return
    }

    const body = request.body as Record<string, unknown>
    assertExpectedVersion(body.expectedVersion, record)
    const assignment = assignmentFromBody(body, record)
    const database = connection()
    transaction(database, () => {
      insertAssignment(database, assignment)
    const activeQuantity = activeAssignmentQuantity(record.id)
    updateRecord(database, { ...record, state: activeQuantity >= record.quantity && record.state === 'in_stock' ? 'in_use' : record.state, updatedAt: nowIso() })
    logActivity(database, actor, 'record_assigned', { userId: assignment.userId, projectId: assignment.projectId, quantity: assignment.quantity }, record.itemId, record.id)
    })
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.post('/assignments/:id/return', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'adjust_stock')
    if (!actor) return
    const assignment = assignmentById(request.params.id)
    if (!assignment) {
      response.status(404).json({ message: 'Assignment not found.' })
      return
    }
    if (assignment.returnedAt) {
      sendUpdatedState(request, response, actor)
      return
    }
    const record = recordById(assignment.recordId)
    if (!record) throw new Error('Assigned stock record not found.')
    assertExpectedVersion((request.body as Record<string, unknown>).expectedVersion, record)
    const returnedAt = nowIso()
    const database = connection()
    transaction(database, () => {
    database.prepare(`UPDATE inventory_assignments SET returnedAt = ?, updatedAt = ? WHERE id = ?`).run(returnedAt, returnedAt, assignment.id)
    updateRecord(database, { ...record, state: activeAssignmentQuantity(record.id) <= 0 && record.state === 'in_use' ? 'in_stock' : record.state, updatedAt: nowIso() })
    logActivity(database, actor, 'record_returned', { userId: assignment.userId, projectId: assignment.projectId, quantity: assignment.quantity }, record?.itemId, record?.id)
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.delete('/records/:id', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'adjust_stock')
    if (!actor) return

    const existing = recordById(request.params.id)
    if (!existing) {
      response.status(404).json({ message: 'Inventory record not found.' })
      return
    }

    const reason = parseOptionalString((request.body as Record<string, unknown>).reason, 500)
    if (!reason) {
      response.status(400).json({ message: 'A reason is required. Received stock is reversed, never silently deleted.' })
      return
    }
    assertExpectedVersion((request.body as Record<string, unknown>).expectedVersion, existing)
    const database = connection()
    const reversed: InventoryRecord = { ...existing, quantity: 0, state: 'retired', updatedAt: nowIso() }
    assertAssignmentIntegrity(existing, reversed)
    transaction(database, () => {
    updateRecord(database, reversed)
    const eventId = randomUUID()
    insertRecordEvent(database, {
      id: eventId,
      recordId: existing.id,
      itemId: existing.itemId,
      eventType: 'reversed',
      actorId: actor.id,
      actorLabel: actor.name,
      reason,
      before: { ...existing },
      after: { ...reversed },
      sourceReference: existing.sourceReference,
      createdAt: nowIso(),
    })
    database.prepare(`UPDATE inventory_receipt_lines SET reversedByEventId = ? WHERE recordId = ? AND reversedByEventId IS NULL`).run(eventId, existing.id)
    logActivity(database, actor, 'record_reversed', { state: existing.state, quantity: existing.quantity, reason }, existing.itemId, existing.id)
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/receipts/import/preview', async (request, response) => {
  const actor = requirePermission(request, response, 'receive_stock')
  if (!actor) return
  try {
    const body = request.body as Record<string, unknown>
    const fileName = parseString(body.fileName, 180)
    const contentBase64 = parseString(body.contentBase64, 6_000_000)
    const rows = matchImportedRows(await importMatrices(fileName, contentBase64))
    response.json({
      rows,
      summary: {
        rows: rows.length,
        valid: rows.filter((row) => row.errors.length === 0).length,
        needsReview: rows.filter((row) => row.warnings.length > 0).length,
        errors: rows.reduce((total, row) => total + row.errors.length, 0),
      },
    })
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'Import preview failed.' })
  }
})

inventorySystemRouter.post('/receipts', (request, response) => {
  handleRoute(response, () => {
    const actor = requirePermission(request, response, 'receive_stock')
    if (!actor) return
    const body = request.body as Record<string, unknown>
    const rawLines = Array.isArray(body.lines) ? body.lines as Array<Record<string, unknown>> : []
    if (rawLines.length === 0 || rawLines.length > 500) throw new Error('Add between 1 and 500 receipt lines.')
    const database = connection()
    const requestKey = parseOptionalString(body.idempotencyKey, 160)
    const requestHash = hashToken(JSON.stringify({ ...body, idempotencyKey: undefined }))
    if (requestKey) {
      const previous = database.prepare('SELECT requestHash FROM inventory_receipt_requests WHERE actorId = ? AND requestKey = ?').get(actor.id, requestKey) as { requestHash: string } | undefined
      if (previous) {
        if (previous.requestHash !== requestHash) { response.status(409).json({ message: 'This receipt request key was already used for different data.' }); return }
        sendUpdatedState(request, response, actor)
        return
      }
    }
    const defaultReceivedAt = parseIsoDateTime(body.receivedAt, '')
    const defaultSupplier = parseOptionalString(body.supplier, 220)
    const defaultOrderReference = parseOptionalString(body.orderReference, 220)
    const defaultDeliveryNoteNumber = parseOptionalString(body.deliveryNoteNumber, 220)
    const defaultReceiverLabel = parseOptionalString(body.receiverLabel, 160) ?? actor.name
    const parsedRows: ReceivingImportRow[] = rawLines.map((line, index) => ({
      rowNumber: index + 1,
      receivedAt: parseIsoDateTime(line.receivedAt, defaultReceivedAt),
      itemName: parseString(line.itemName, 220) || itemById(parseString(line.itemId, 100))?.name || '',
      itemId: parseOptionalString(line.itemId, 100),
      quantity: parseOptionalNumber(line.quantity),
      quantityLabel: parseOptionalString(line.quantityLabel, 220),
      locationName: parseString(line.locationName, 220) || locationById(parseString(line.locationId, 100))?.name || '',
      locationId: parseOptionalString(line.locationId, 100),
      notes: parseOptionalString(line.notes, 2000),
      receiverLabel: parseOptionalString(line.receiverLabel, 160) ?? defaultReceiverLabel,
      supplier: parseOptionalString(line.supplier, 220) ?? defaultSupplier,
      orderReference: parseOptionalString(line.orderReference, 220) ?? defaultOrderReference,
      deliveryNoteNumber: parseOptionalString(line.deliveryNoteNumber, 220) ?? defaultDeliveryNoteNumber,
      barcode: parseOptionalString(line.barcode, 220),
      sourceReference: parseOptionalString(line.sourceReference, 500),
      errors: Array.isArray(line.errors) ? line.errors.map((value) => parseString(value, 300)).filter(Boolean) : [],
      warnings: Array.isArray(line.warnings) ? line.warnings.map((value) => parseString(value, 300)).filter(Boolean) : [],
    }))
    if (parsedRows.some((row) => !row.receivedAt || !row.itemName || !row.locationName || row.errors.length > 0)) {
      throw new Error('Resolve all date, article, and location errors before saving.')
    }
    const matchedRows = matchImportedRows(parsedRows)
    database.exec(`BEGIN IMMEDIATE;`)
    try {
      // Validate each line against the same initial source revision; one batch may
      // legitimately consume several lines from one order before it commits.
      const sourceVersions = new Map<string, InventoryRecord>()
      for (const line of rawLines) {
        const sourceId = parseOptionalString(line.sourceRecordId, 120)
        if (!sourceId) continue
        const source = sourceVersions.get(sourceId) ?? recordById(sourceId)
        if (!source) throw new Error('The source order was not found. Refresh the inventory.')
        assertExpectedVersion(line.sourceExpectedVersion, source)
        sourceVersions.set(sourceId, source)
      }
      if (requestKey) database.prepare('INSERT INTO inventory_receipt_requests (actorId, requestKey, requestHash, createdAt) VALUES (?, ?, ?, ?)').run(actor.id, requestKey, requestHash, nowIso())
      const grouped = new Map<string, ReceivingImportRow[]>()
      for (const row of matchedRows) {
        const key = [row.receivedAt, row.supplier, row.orderReference, row.deliveryNoteNumber, row.receiverLabel].join('\u0000')
        grouped.set(key, [...(grouped.get(key) ?? []), row])
      }
      for (const rows of grouped.values()) {
        const first = rows[0]
        const receiptId = randomUUID()
        const attachment = grouped.size === 1 ? persistAttachment(body, receiptId) : undefined
        const createdAt = nowIso()
        database.prepare(
          `INSERT INTO inventory_receipts
            (id, receivedAt, supplier, orderReference, deliveryNoteNumber, receiverId, receiverLabel, notes, attachmentName, attachmentPath, sourceReference, createdAt, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          receiptId, first.receivedAt, first.supplier ?? null, first.orderReference ?? null, first.deliveryNoteNumber ?? null,
          actor.id, first.receiverLabel ?? actor.name, parseOptionalString(body.notes, 2000) ?? null,
          attachment?.attachmentName ?? null, attachment?.attachmentPath ?? null, first.sourceReference ?? null, createdAt, actor.id,
        )
        for (const row of rows) {
          const originalLine = rawLines[row.rowNumber - 1]
          const item = importItem(database, row)
          const location = importLocation(database, row)
          const quantity = row.quantity && row.quantity > 0 ? row.quantity : 0
          const discrepancy = inventoryReceiptDiscrepancies.includes(parseString(originalLine.discrepancy, 30) as InventoryReceiptDiscrepancy)
            ? parseString(originalLine.discrepancy, 30) as InventoryReceiptDiscrepancy
            : 'none'
          const condition = discrepancy === 'damaged' ? 'damaged' : discrepancy === 'wrong_item' ? 'needs_check' : parseCondition(originalLine.condition, 'new')
          const quarantined = !['new', 'usable'].includes(condition)
          const sourceRecordId = parseOptionalString(originalLine.sourceRecordId, 120)
          if (sourceRecordId) {
            const order = recordById(sourceRecordId)
            if (!order || order.itemId !== item.id || !['ordered', 'delivered'].includes(order.state) || quantity <= 0 || quantity > order.quantity) {
              throw new Error('The source order must match the item and contain enough unreceived units. Refresh the order before receiving it.')
            }
            if (discrepancy !== 'wrong_item') {
              const remaining = order.quantity - quantity
              const updatedOrder: InventoryRecord = { ...order, quantity: remaining, state: remaining > 0 ? order.state : 'cancelled', updatedAt: nowIso() }
              assertAssignmentIntegrity(order, updatedOrder)
              updateRecord(database, updatedOrder)
              auditRecordChange(database, actor, 'changed', updatedOrder, order, `Goods receipt ${receiptId} consumed ${quantity} units from source order ${sourceRecordId}.`)
            }
          }
          const record: InventoryRecord = {
            id: randomUUID(), version: 1, quarantined, itemId: item.id, locationId: location.id, quantity, quantityLabel: row.quantityLabel,
            state: quarantined ? condition === 'damaged' ? 'damaged' : 'maintenance' : 'in_stock', condition, supplier: row.supplier, orderReference: row.orderReference,
            receivedBy: actor.id, notes: row.notes, sourceReference: row.sourceReference, stockedAt: row.receivedAt,
            createdAt, updatedAt: createdAt,
          }
          insertRecord(database, record)
          const lineId = randomUUID()
          database.prepare(
            `INSERT INTO inventory_receipt_lines
              (id, receiptId, recordId, itemId, locationId, quantity, quantityLabel, condition, discrepancy, discrepancyQuantity, notes, barcode, sourceReference, reviewRequired, createdAt, sourceRecordId)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            lineId, receiptId, record.id, item.id, location.id, quantity, row.quantityLabel ?? null, record.condition, discrepancy,
            parseOptionalNumber(originalLine.discrepancyQuantity) ?? null,
            row.notes ?? null, row.barcode ?? null, row.sourceReference ?? null, quarantined || row.warnings.length > 0 || quantity <= 0 ? 1 : 0, createdAt, sourceRecordId ?? null,
          )
          auditRecordChange(database, actor, 'received', record, undefined, `Goods receipt ${receiptId}.`, lineId)
          logActivity(database, actor, 'goods_received', { receiptId, quantity, quantityLabel: row.quantityLabel, location: location.name, orderReference: row.orderReference }, item.id, record.id)
        }
      }
      database.exec(`COMMIT;`)
    } catch (error) {
      database.exec(`ROLLBACK;`)
      throw error
    }
    sendUpdatedState(request, response, actor, 201)
  })
})

inventorySystemRouter.post('/receipt-lines/:id/correct', (request, response) => {
  handleRoute(response, () => {
    const actor = actorForRequest(request)
    if (!actor || (!hasPermission(actor, 'adjust_stock') && !hasPermission(actor, 'receive_stock'))) {
      response.status(403).json({ message: 'This inventory account cannot correct received stock.' })
      return
    }
    const line = (connection().prepare(`SELECT * FROM inventory_receipt_lines WHERE id = ?`).get(request.params.id) as unknown as InventoryReceiptLineRow | undefined)
    if (!line) { response.status(404).json({ message: 'Receipt line not found.' }); return }
    if (line.reversedByEventId) throw new Error('A reversed receipt cannot be corrected. Record a new goods receipt instead.')
    const existing = recordById(line.recordId)
    if (!existing) { response.status(404).json({ message: 'Stock record not found.' }); return }
    const body = request.body as Record<string, unknown>
    const reason = parseOptionalString(body.reason, 500)
    if (!reason) throw new Error('A correction reason is required.')
    assertExpectedVersion(body.expectedVersion, existing)
    const quantity = parseOptionalNumber(body.quantity)
    const locationId = parseOptionalString(body.locationId, 100) ?? existing.locationId
    if (quantity === undefined || quantity < 0) throw new Error('Corrected quantity must be zero or greater.')
    if (!locationById(locationId)) throw new Error('Corrected storage location was not found.')
    const corrected: InventoryRecord = {
      ...existing,
      quantity,
      quantityLabel: parseOptionalString(body.quantityLabel, 220) ?? existing.quantityLabel,
      locationId,
      notes: parseOptionalString(body.notes, 2000) ?? existing.notes,
      updatedAt: nowIso(),
    }
    assertAssignmentIntegrity(existing, corrected)
    const database = connection()
    transaction(database, () => {
      updateRecord(database, corrected)
      auditRecordChange(database, actor, 'corrected', corrected, existing, reason, line.id)
      logActivity(database, actor, 'receipt_corrected', { reason, previousQuantity: existing.quantity, quantity }, corrected.itemId, corrected.id)
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.post('/receipt-lines/:id/release', (request, response) => {
  handleRoute(response, () => {
    const actor = actorForRequest(request)
    if (!actor || (!hasPermission(actor, 'adjust_stock') && !hasPermission(actor, 'receive_stock'))) {
      response.status(403).json({ message: 'This inventory account cannot release received stock.' })
      return
    }
    const database = connection()
    const line = database.prepare('SELECT * FROM inventory_receipt_lines WHERE id = ?').get(request.params.id) as unknown as InventoryReceiptLineRow | undefined
    if (!line) { response.status(404).json({ message: 'Receipt line not found.' }); return }
    const existing = recordById(line.recordId)
    if (!existing) { response.status(404).json({ message: 'Stock record not found.' }); return }
    const body = request.body as Record<string, unknown>
    assertExpectedVersion(body.expectedVersion, existing)
    if (line.reversedByEventId || line.releasedByEventId || !existing.quarantined || existing.quantity <= 0) {
      throw new Error('Only positive stock awaiting quarantine review can be released.')
    }
    const reason = parseOptionalString(body.reason, 500)
    const item = itemById(parseString(body.itemId, 120))
    if (!reason || !item?.active || !['new', 'usable'].includes(String(body.condition))) {
      throw new Error('Confirm the actual active item, a usable condition, and a review reason before releasing this receipt.')
    }
    const released: InventoryRecord = { ...existing, itemId: item.id, state: 'in_stock', condition: body.condition as InventoryCondition, quarantined: false, updatedAt: nowIso() }
    assertAssignmentIntegrity(existing, released)
    transaction(database, () => {
      updateRecord(database, released)
      const eventId = auditRecordChange(database, actor, 'corrected', released, existing, `Quarantine release: ${reason}`, line.id)
      database.prepare('UPDATE inventory_receipt_lines SET releasedByEventId = ? WHERE id = ?').run(eventId, line.id)
      logActivity(database, actor, 'receipt_released', { reason, previousItemId: existing.itemId, itemId: item.id, condition: released.condition }, released.itemId, released.id)
    })
    sendUpdatedState(request, response, actor)
  })
})

inventorySystemRouter.get('/receipts/:id/attachment', (request, response) => {
  const actor = requirePermission(request, response, 'read_inventory')
  if (!actor) return
  const receipt = connection().prepare(`SELECT * FROM inventory_receipts WHERE id = ?`).get(request.params.id) as unknown as InventoryReceiptRow | undefined
  if (!receipt?.attachmentPath || !receipt.attachmentName) { response.status(404).json({ message: 'Attachment not found.' }); return }
  const storedPath = join(inventoryMediaPath, `${receipt.id}${extname(receipt.attachmentName).toLowerCase()}`)
  if (!existsSync(storedPath)) { response.status(404).json({ message: 'Attachment not found.' }); return }
  response.download(storedPath, receipt.attachmentName)
})

inventorySystemRouter.get('/receipts/export', (request, response) => {
  const actor = requirePermission(request, response, 'export_inventory')
  if (!actor) return
  const month = parseString(request.query.month, 7)
  const start = /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-01T00:00:00.000Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  const receipts = readReceipts(start.toISOString(), end.toISOString(), 10000)
  const lines = readReceiptLines(receipts.map((receipt) => receipt.id))
  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="goods-receipts-${start.toISOString().slice(0, 7)}.csv"`)
  response.send(receiptCsv(receipts, lines))
})

inventorySystemRouter.get('/exports', (request, response) => {
  const actor = requirePermission(request, response, 'export_inventory')
  if (!actor) return

  const format = parseString(request.query.format, 20).toLowerCase()
  const date = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    response.setHeader('Content-Disposition', `attachment; filename="inventory-${date}.json"`)
    response.json({
      exportedAt: nowIso(),
      exportedBy: actor.name,
      items: readItems(),
      locations: readLocations(),
      records: exportRows(),
      projects: readProjects(),
      assignments: readAssignments(),
      workflows: readWorkflowState(connection()),
    })
    return
  }

  response.setHeader('Content-Type', 'text/csv; charset=utf-8')
  response.setHeader('Content-Disposition', `attachment; filename="inventory-${date}.csv"`)
  response.send(exportCsv())
})

registerCatalogRoutes(inventorySystemRouter, { connection, requirePermission, handleRoute, transaction, readItems, readProjects, itemFromBody, insertItem, logActivity, sendUpdatedState })

registerInventoryWorkflows(inventorySystemRouter, {
  connection, requirePermission, handleRoute, sendUpdatedState, transaction, itemById, recordById, locationById,
  readProjects, readRecords, readAssignments, insertItem, insertRecord, updateRecord, insertAssignment, auditRecordChange, logActivity,
})

export const inventoryClickUp = registerInventoryClickUp(inventorySystemRouter, {
  connection, requirePermission, hasPermission, handleRoute, readProjects, activeUserById, logActivity,
  async authorizedIntegrationUsers(userIds) {
    if (!coreEnabled()) return new Set(userIds.filter(id => { const user = activeUserById(id); return user && !user.mustChangePassword && user.role !== 'viewer' }))
    const rows = connection().prepare('SELECT coreUserId, userId FROM inventory_core_profiles').all().filter(row => userIds.includes(String(row.userId)))
    const allowed = new Set(await coreInventoryIntegrationUsers(rows.map(row => String(row.coreUserId))))
    return new Set(rows.filter(row => allowed.has(String(row.coreUserId))).map(row => String(row.userId)))
  },
})
