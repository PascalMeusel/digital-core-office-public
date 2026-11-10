import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response, Router } from 'express'
import type { InventoryActivity, InventoryItemDefinition, InventoryProject, InventoryUser } from '../shared/inventory.ts'
import { catalogLink, euroPrice } from '../shared/catalog.ts'
import { parseCsv } from './receivingImport.ts'
import { readWorkflowState } from './workflows.ts'

type Body = Record<string, unknown>
type Details = Pick<InventoryItemDefinition, 'supplierUrl' | 'estimatedUnitCost' | 'projectIds' | 'photoPath'>
export function ensureCatalogSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_item_details (itemId TEXT PRIMARY KEY REFERENCES inventory_items(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS inventory_item_photos (itemId TEXT PRIMARY KEY REFERENCES inventory_items(id) ON DELETE CASCADE, mime TEXT NOT NULL, content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_catalog_operations (actorId TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(actorId,key));`)
}
export function readCatalogDetails(db: DatabaseSync) {
  return new Map(db.prepare('SELECT itemId, data FROM inventory_item_details').all().map(row => [String(row.itemId), JSON.parse(String(row.data)) as Details]))
}
export function writeCatalogDetails(db: DatabaseSync, item: InventoryItemDefinition) {
  const { supplierUrl, estimatedUnitCost, projectIds, photoPath } = item
  db.prepare('INSERT INTO inventory_item_details VALUES (?,?) ON CONFLICT(itemId) DO UPDATE SET data=excluded.data').run(item.id, JSON.stringify({ supplierUrl, estimatedUnitCost, projectIds, photoPath }))
}
export function parseProjectIds(value: unknown, projects: InventoryProject[], existing: string[] = []) {
  if (value === undefined) return existing
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== 'string' || !projects.some(p => p.id === id && (p.active || existing.includes(id))))) throw new Error('Choose valid projects.')
  return [...new Set(value)] as string[]
}
export function parseCatalogDetails(body: Body, projects: InventoryProject[], existing?: InventoryItemDefinition): Details {
  return {
    supplierUrl: body.supplierUrl === undefined ? existing?.supplierUrl : catalogLink(body.supplierUrl),
    estimatedUnitCost: body.estimatedUnitCost === undefined ? existing?.estimatedUnitCost : euroPrice(body.estimatedUnitCost),
    projectIds: parseProjectIds(body.projectIds, projects, existing?.projectIds), photoPath: existing?.photoPath,
  }
}
export function saveCatalogPhoto(db: DatabaseSync, item: InventoryItemDefinition, value: unknown) {
  if (value === undefined) return
  if (value === '') { db.prepare('DELETE FROM inventory_item_photos WHERE itemId=?').run(item.id); item.photoPath = undefined; writeCatalogDetails(db, item); return }
  if (typeof value !== 'string' || value.length > 5_600_000) throw new Error('Photo must be PNG, JPEG or WebP, at most 4 MB.')
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('Photo must be PNG, JPEG or WebP.')
  const content = Buffer.from(match[2], 'base64')
  const valid = match[1] === 'png' ? content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : match[1] === 'jpeg' ? content[0] === 255 && content[1] === 216 && content[2] === 255 : content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP'
  if (!valid || content.length < 12 || content.length > 4 * 1024 * 1024) throw new Error('Invalid photo or photo larger than 4 MB.')
  db.prepare('INSERT INTO inventory_item_photos VALUES (?,?,?) ON CONFLICT(itemId) DO UPDATE SET mime=excluded.mime,content=excluded.content').run(item.id, `image/${match[1]}`, content)
  item.photoPath = `/api/inventorySystem/items/${item.id}/photo?v=${createHash('sha256').update(content).digest('hex').slice(0, 16)}`
  writeCatalogDetails(db, item)
}

interface Host {
  connection(): DatabaseSync
  requirePermission(req: Request, res: Response, permission: 'manage_catalog' | 'read_inventory'): InventoryUser | undefined
  handleRoute(res: Response, action: () => void | Promise<void>): void
  transaction<T>(db: DatabaseSync, action: () => T): T
  readItems(): InventoryItemDefinition[]
  readProjects(): InventoryProject[]
  itemFromBody(body: Body, existing?: InventoryItemDefinition): InventoryItemDefinition
  insertItem(db: DatabaseSync, item: InventoryItemDefinition): void
  logActivity(db: DatabaseSync, actor: InventoryUser, action: string, details: Body, itemId?: string): void
  sendUpdatedState(req: Request, res: Response, actor: InventoryUser, status?: number): void
}
const headers: Record<string, string[]> = {
  name: ['name', 'article', 'artikel', 'item', 'part', 'bezeichnung', 'itemname'], sku: ['sku', 'artikelnummer', 'partnumber'], category: ['category', 'kategorie'], unit: ['unit', 'einheit'],
  supplierUrl: ['link', 'url', 'supplierurl', 'lieferantenlink'], estimatedUnitCost: ['preis', 'price', 'priceeur', 'preiseur', 'estimatedunitcost'], value: ['value', 'wert', 'bauteilwert'], description: ['description', 'beschreibung'], manufacturerPartNumber: ['manufacturerpartnumber', 'mpn'],
}
const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
export function catalogRows(matrix: unknown[][]) {
  if (!matrix.length) throw new Error('Empty file.')
  const indexes = Object.fromEntries(Object.entries(headers).map(([key, names]) => [key, matrix[0].findIndex(v => names.includes(normalize(v)))]))
  if (indexes.name < 0) throw new Error('A Name / Artikel column is required.')
  if (matrix.length > 1001) throw new Error('Import at most 1,000 articles at a time.')
  return matrix.slice(1).flatMap((row, i) => row.some(value => String(value ?? '').trim()) ? [{ rowNumber: i + 2, ...Object.fromEntries(Object.entries(indexes).filter(([, index]) => index >= 0).map(([key, index]) => [key, String(row[index] ?? '').trim()])) }] : [])
}
async function importRows(body: Body) {
  if (typeof body.text === 'string') {
    if (body.text.length > 2_000_000) throw new Error('List is too large.')
    return catalogRows(parseCsv(body.text.replace(/^\uFEFF/, '')))
  }
  if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > 5_600_000) throw new Error('Choose a file up to 4 MB.')
  const buffer = Buffer.from(body.contentBase64, 'base64')
  if (!String(body.fileName).toLowerCase().endsWith('.xlsx')) return catalogRows(parseCsv(buffer.toString('utf8').replace(/^\uFEFF/, '')))
  const ExcelJS = await import('exceljs'); const book = new ExcelJS.default.Workbook()
  await book.xlsx.load(buffer as never)
  const sheet = book.worksheets[0]
  if (!sheet || sheet.rowCount > 1001 || sheet.columnCount > 100) throw new Error('Use the first sheet, with at most 1,000 articles and 100 columns.')
  const matrix: unknown[][] = []
  sheet.eachRow({ includeEmpty: true }, row => { const values: unknown[] = []; row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cell.text }); matrix.push(values) })
  return catalogRows(matrix)
}
export function registerCatalogRoutes(router: Router, h: Host) {
  function preview(rows: Body[]) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('Use 1–1,000 articles.')
    const existing = h.readItems(), seen = new Set<string>()
    return rows.map((body, index) => {
      let item: InventoryItemDefinition | undefined; let existingId: string | undefined; const errors: string[] = []
      try {
        item = h.itemFromBody(body)
        const key = (item.sku || item.name).toLocaleLowerCase()
        if (seen.has(key)) throw new Error('Duplicate row / Doppelte Zeile.')
        seen.add(key)
        const same = existing.filter(i => item!.sku ? i.sku.toLowerCase() === item!.sku.toLowerCase() : i.name.toLowerCase() === item!.name.toLowerCase())
        if (same.length > 1 || (same[0] && (same[0].name.toLowerCase() !== item.name.toLowerCase() || same[0].unit !== item.unit))) throw new Error('Existing article differs; review name, SKU and unit.')
        existingId = same[0]?.id
      } catch (error) { errors.push((error as Error).message) }
      return { rowNumber: body.rowNumber ?? index + 2, input: body, item, existingId, errors }
    })
  }
  function mutation(path: string, action: (body: Body, actor: InventoryUser, db: DatabaseSync) => void) {
    router.post(path, (req, res) => h.handleRoute(res, () => {
      const actor = h.requirePermission(req, res, 'manage_catalog'); if (!actor) return
      const db = h.connection(), body = req.body as Body
      h.transaction(db, () => {
        const key = String(body.idempotencyKey ?? '').slice(0, 160)
        if (!key) throw new Error('A submission key is required.')
        const hash = createHash('sha256').update(path + JSON.stringify(body)).digest('hex')
        const previous = db.prepare('SELECT hash FROM inventory_catalog_operations WHERE actorId=? AND key=?').get(actor.id, key)
        if (previous) { if (previous.hash !== hash) throw new Error('Submission key was already used.'); return }
        action(body, actor, db)
        db.prepare('INSERT INTO inventory_catalog_operations VALUES (?,?,?)').run(actor.id, key, hash)
      })
      h.sendUpdatedState(req, res, actor)
    }))
  }
  router.post('/catalog/import/preview', (req, res) => h.handleRoute(res, async () => {
    if (!h.requirePermission(req, res, 'manage_catalog')) return
    res.json({ rows: preview(await importRows(req.body)) })
  }))
  mutation('/catalog/import', (body, actor, db) => {
    const rows = preview(body.rows as Body[])
    if (rows.some(row => row.errors.length)) throw new Error('Correct the highlighted rows before importing.')
    for (const row of rows) if (!row.existingId && row.item) { h.insertItem(db, row.item); h.logActivity(db, actor, 'item_created', { name: row.item.name, source: 'catalog_import', projectIds: row.item.projectIds }, row.item.id) }
  })
  mutation('/catalog/projects', (body, actor, db) => {
    const projects = parseProjectIds(body.projectIds, h.readProjects())
    const ids = body.itemIds
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !projects.length || !['add', 'remove'].includes(String(body.mode))) throw new Error('Select articles and projects.')
    const items = h.readItems()
    for (const id of new Set(ids)) {
      const item = items.find(i => i.id === id); if (!item) throw new Error('Article no longer exists.')
      item.projectIds = body.mode === 'remove' ? (item.projectIds ?? []).filter(id => !projects.includes(id)) : [...new Set([...(item.projectIds ?? []), ...projects])]
      writeCatalogDetails(db, item)
      h.logActivity(db, actor, 'item_projects_updated', { name: item.name, projectIds: projects, mode: body.mode }, item.id)
    }
  })
  router.get('/items/:id/photo', (req, res) => {
    if (!h.requirePermission(req, res, 'read_inventory')) return
    const photo = h.connection().prepare('SELECT mime,content FROM inventory_item_photos WHERE itemId=?').get(String(req.params.id))
    if (!photo) { res.status(404).json({ message: 'Photo not found.' }); return }
    res.setHeader('Cache-Control', 'private, no-cache'); res.type(String(photo.mime)).send(Buffer.from(photo.content as Uint8Array))
  })
  router.get('/catalog/history', (req, res) => h.handleRoute(res, () => {
    if (!h.requirePermission(req, res, 'read_inventory')) return
    const itemId = String(req.query.itemId ?? ''), projectId = String(req.query.projectId ?? '')
    if (!itemId && !projectId) throw new Error('Choose an article or project.')
    const db = h.connection(), w = readWorkflowState(db)
    const requests = new Set(w.requests.filter(r => itemId ? r.itemId === itemId : r.projectId === projectId).map(r => r.id))
    const orders = new Set(w.orders.filter(o => o.lines.some(l => itemId ? l.itemId === itemId : l.projectId === projectId)).map(o => o.id))
    const scopedLines = w.orders.flatMap(order => order.lines.filter(line => itemId ? line.itemId === itemId : line.projectId === projectId))
    const receipts = new Set(scopedLines.flatMap(line => line.receipts.map(receipt => receipt.receiptId)))
    if (itemId) for (const row of db.prepare('SELECT receiptId FROM inventory_receipt_lines WHERE itemId=?').all(itemId)) receipts.add(String(row.receiptId))
    const builds = new Set(w.builds.filter(b => itemId ? b.outputItemId === itemId || b.parts.some(p => p.itemId === itemId) : b.projectId === projectId).map(b => b.id))
    const assignments = new Set(db.prepare('SELECT a.id FROM inventory_assignments a JOIN inventory_records r ON r.id=a.recordId WHERE r.itemId=? OR a.projectId=?').all(itemId, projectId).map(r => r.id))
    const records = new Set(db.prepare('SELECT r.id FROM inventory_records r LEFT JOIN inventory_assignments a ON a.recordId=r.id WHERE r.itemId=? OR a.projectId=?').all(itemId, projectId).map(r => r.id))
    const items = new Map(h.readItems().map(item => [item.id, item.name]))
    const actors = new Map(db.prepare('SELECT id,name FROM inventory_users').all().map(u => [String(u.id), String(u.name)]))
    const rows = db.prepare('SELECT * FROM inventory_activity ORDER BY createdAt DESC,id DESC').all()
    const matching = rows.flatMap(row => {
      if (!/^(item_|project_|record_|request_|supplier_order_|workflow_delivery_|stock_|build_|goods_received|receipt_)/.test(String(row.action))) return []
      const details = JSON.parse(String(row.details)) as Body
      const belongs = (itemId && row.itemId === itemId) || (projectId && (details.projectId === projectId || Array.isArray(details.projectIds) && details.projectIds.includes(projectId))) || requests.has(String(details.requestId)) || (row.action === 'workflow_delivery_received' ? receipts.has(String(details.receiptId)) : orders.has(String(details.orderId))) || builds.has(String(details.buildId)) || assignments.has(String(details.assignmentId)) || records.has(String(row.recordId ?? details.recordId))
      if (!belongs) return []
      const safe = Object.fromEntries(Object.entries(details).filter(([key]) => ['name', 'quantity', 'state', 'status', 'reference', 'reason', 'decisionNote', 'mode'].includes(key)))
      safe.name ??= items.get(String(row.itemId)) ?? w.requests.find(r => r.id === details.requestId)?.itemName ?? w.orders.find(o => o.id === details.orderId)?.lines.filter(l => (itemId ? l.itemId === itemId : l.projectId === projectId) && (row.action !== 'workflow_delivery_received' || l.receipts.some(r => r.receiptId === details.receiptId))).map(l => l.itemName).join(', ')
      return [{ id: String(row.id), actorId: String(row.actorId), actorName: actors.get(String(row.actorId)) ?? 'Former user', action: String(row.action), details: safe, createdAt: String(row.createdAt) } satisfies InventoryActivity & { actorName: string }]
    })
    const offset = Math.max(0, Number(req.query.offset) || 0)
    res.json({ activity: matching.slice(offset, offset + 100), hasMore: matching.length > offset + 100 })
  }))
}
