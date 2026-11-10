import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response, Router } from 'express'
import type { InventoryPermission, InventoryProject, InventoryUser } from '../shared/inventory.ts'
import { clickUpDescription, clickUpReference, clickUpReport, clickUpRequestGroup, clickUpRequestKey } from '../shared/clickup.ts'
import { readWorkflowState } from './workflows.ts'

interface Host {
  connection(): DatabaseSync
  requirePermission(req: Request, res: Response, permission: InventoryPermission): InventoryUser | undefined
  hasPermission(user: InventoryUser, permission: InventoryPermission): boolean
  handleRoute(res: Response, action: () => void | Promise<void>): void
  readProjects(): InventoryProject[]
  activeUserById(id: string): InventoryUser | undefined
  authorizedIntegrationUsers(userIds: string[]): Promise<Set<string>>
  logActivity(db: DatabaseSync, actor: InventoryUser, action: string, details: Record<string, unknown>): void
}
interface Connection { userId: string; secret: string; name: string }
interface Link { groupKey: string; requestId: string; listId: string; taskId: string | null; ownerId: string; managed: number; lastHash: string | null; lastSyncedAt: string | null; error: string | null; retryAt: number }
interface RemoteList { id: string; name: string; archived?: boolean; space: { id: string; name: string }; folder?: { id: string; name: string; hidden?: boolean } }
interface RemoteTask { id: string; name: string; status?: { status: string }; list: { id: string }; markdown_description?: string; description?: string }
interface RemoteOption { id: string | number; name: string }
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }) }
function id(value: unknown) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('Ungültige ClickUp-ID.'); return value }
function message(error: unknown) { return error instanceof Error ? error.message : 'ClickUp ist momentan nicht erreichbar.' }
function key() {
  const value = Buffer.from(process.env.INVENTORY_CLICKUP_TOKEN_KEY ?? '', 'base64')
  return value.length === 32 ? value : undefined
}
export function sealClickUpToken(token: string, userId: string) {
  const secret = key(); if (!secret) fail('Die ClickUp-Verbindung ist auf dem Server noch nicht eingerichtet.', 503)
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, nonce)
  cipher.setAAD(Buffer.from(userId))
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return [nonce, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join('.')
}
function openToken(connection: Connection) {
  try {
    const secret = key(); if (!secret) throw new Error()
    const [nonce, tag, encrypted] = connection.secret.split('.').map(b => Buffer.from(b, 'base64'))
    const cipher = createDecipheriv('aes-256-gcm', secret, nonce); cipher.setAAD(Buffer.from(connection.userId)); cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8')
  } catch { fail('Bitte ClickUp erneut verbinden. Der gespeicherte Zugang kann nicht gelesen werden.', 409) }
}
export function ensureClickUpSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_clickup_connections (userId TEXT PRIMARY KEY REFERENCES inventory_users(id), secret TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_clickup_lists (projectId TEXT NOT NULL REFERENCES inventory_projects(id), listId TEXT NOT NULL, workspaceId TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(projectId,listId));
    CREATE TABLE IF NOT EXISTS inventory_clickup_tasks (groupKey TEXT NOT NULL, requestId TEXT NOT NULL, listId TEXT NOT NULL, taskId TEXT, ownerId TEXT NOT NULL REFERENCES inventory_users(id), managed INTEGER NOT NULL, lastHash TEXT, lastSyncedAt TEXT, error TEXT, retryAt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(groupKey,listId));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clickup_managed_task ON inventory_clickup_tasks(taskId) WHERE managed=1 AND taskId IS NOT NULL;
  `)
}

// Fixed API origin, no redirects, bounded requests; never echo upstream responses or credentials.
async function clickUp<T>(token: string, path: string, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
  let response: globalThis.Response
  try { response = await fetch(`https://api.clickup.com/api/v2${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) }
  catch { fail('ClickUp ist momentan nicht erreichbar. Bitte später erneut versuchen.', 502) }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : [401, 403, 404].includes(response.status) ? 403 : 502
    const text = response.status === 429 ? 'ClickUp-Anfragelimit erreicht. Bitte in einer Minute erneut versuchen.' : status === 403 ? 'Kein ClickUp-Zugriff. Bitte Zugang und Berechtigungen in ClickUp prüfen.' : response.status >= 500 ? 'ClickUp ist momentan nicht erreichbar.' : 'ClickUp konnte die Änderung nicht übernehmen. Bitte die Liste und ihre Pflichtfelder prüfen.'
    throw Object.assign(new Error(text), { status, rejected: response.status >= 400 && response.status < 500 })
  }
  try { return await response.json() as T } catch { fail('ClickUp hat eine unvollständige Antwort geliefert.', 502) }
}
export function registerInventoryClickUp(router: Router, h: Host) {
  const locked = new Set<string>()
  let stopped = false, syncing = false
  const connection = (userId: string) => h.connection().prepare('SELECT * FROM inventory_clickup_connections WHERE userId = ?').get(userId) as unknown as Connection | undefined
  function token(userId: string) { const value = connection(userId); if (!value) fail('Bitte zuerst dein ClickUp-Konto verbinden.', 409); return openToken(value) }
  function requireProject(projectId: string) { if (!h.readProjects().some(p => p.id === projectId && p.active)) fail('Dieses Inventarprojekt ist nicht verfügbar.', 404) }
  function context(requestId: string, actor?: InventoryUser) {
    const state = readWorkflowState(h.connection()), group = clickUpRequestGroup(state, requestId)
    if (!group.length) fail('Diese Anfrage ist nicht mehr vorhanden.', 404)
    if (actor && !(h.hasPermission(actor, 'order_stock') || (h.hasPermission(actor, 'request_stock') && group[0].requesterId === actor.id))) fail('Nur die anfragende Person oder der Einkauf kann diese Anfrage mit ClickUp verbinden.', 403)
    const projectName = h.readProjects().find(p => p.id === group[0].projectId)?.name ?? 'Allgemeiner Bedarf'
    const report = clickUpReport(state, group, projectName)
    return { group, projectName, groupKey: clickUpRequestKey(group[0]), report, hash: createHash('sha256').update(report).digest('hex') }
  }
  function links(groupKey: string) { return h.connection().prepare('SELECT * FROM inventory_clickup_tasks WHERE groupKey = ?').all(groupKey) as unknown as Link[] }
  function route(method: 'get' | 'post', path: string, permission: InventoryPermission, action: (req: Request, res: Response, actor: InventoryUser) => Promise<void>) {
    router[method](`/clickup${path}`, (req, res) => h.handleRoute(res, async () => {
      res.setHeader('Cache-Control', 'no-store')
      const actor = h.requirePermission(req, res, permission); if (!actor) return
      await action(req, res, actor)
    }))
  }
  const options = (items: RemoteOption[]) => items.map(item => ({ id: String(item.id), name: item.name }))
  route('get', '/connection', 'read_inventory', async (_req, res, actor) => {
    const value = connection(actor.id); res.json({ configured: !!key(), connected: !!value, name: value?.name })
  })
  route('post', '/connect', 'read_inventory', async (req, res, actor) => {
    const value = req.body?.token
    if (typeof value !== 'string' || !/^pk_[a-zA-Z0-9_-]{10,250}$/.test(value.trim())) fail('Bitte einen persönlichen ClickUp-API-Token eingeben.')
    const secret = sealClickUpToken(value.trim(), actor.id)
    const { user } = await clickUp<{ user: { username: string } }>(value.trim(), '/user')
    const name = String(user.username).slice(0, 200)
    h.connection().prepare('INSERT INTO inventory_clickup_connections VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET secret=excluded.secret,name=excluded.name').run(actor.id, secret, name)
    h.logActivity(h.connection(), actor, 'clickup.connected', {})
    res.json({ configured: true, connected: true, name })
  })
  route('post', '/disconnect', 'read_inventory', async (_req, res, actor) => {
    h.connection().prepare('DELETE FROM inventory_clickup_connections WHERE userId = ?').run(actor.id)
    h.logActivity(h.connection(), actor, 'clickup.disconnected', {})
    res.json({ configured: !!key(), connected: false })
  })
  route('get', '/browse', 'read_inventory', async (req, res, actor) => {
    const access = token(actor.id), kind = req.query.kind
    if (kind === 'workspaces') { res.json({ options: options((await clickUp<{ teams: RemoteOption[] }>(access, '/team')).teams) }); return }
    const parent = id(req.query.parent)
    const endpoints = { spaces: [`/team/${parent}/space?archived=false`, 'spaces'], folders: [`/space/${parent}/folder?archived=false`, 'folders'], lists: [`/${req.query.folder === 'true' ? 'folder' : 'space'}/${parent}/list?archived=false`, 'lists'] }
    if (typeof kind !== 'string' || !Object.hasOwn(endpoints, kind)) fail('Ungültige ClickUp-Auswahl.')
    const [path, field] = endpoints[kind as keyof typeof endpoints]
    const data = await clickUp<Record<string, RemoteOption[]>>(access, path)
    res.json({ options: options(data[field]) })
  })
  route('get', '/projects/:id/lists', 'read_inventory', async (req, res, actor) => {
    const projectId = id(req.params.id); requireProject(projectId)
    if (!connection(actor.id)) { res.json({ lists: [], setup: 'disconnected' }); return }
    const rows = h.connection().prepare('SELECT * FROM inventory_clickup_lists WHERE projectId = ? ORDER BY path,listId').all(projectId)
    const lists = []
    for (const row of rows) {
      try {
        await clickUp<RemoteList>(token(actor.id), `/list/${id(row.listId)}`)
        lists.push({ projectId, listId: row.listId, path: row.path })
      } catch (error) { if ((error as { status?: number }).status !== 403) throw error }
    }
    res.json({ lists, setup: rows.length === 0 ? 'unmapped' : lists.length === 0 ? 'inaccessible' : 'ready' })
  })
  route('post', '/projects/:id/lists', 'manage_projects', async (req, res, actor) => {
    const projectId = id(req.params.id), listId = id(req.body?.listId), workspaceId = id(req.body?.workspaceId)
    requireProject(projectId)
    const access = token(actor.id)
    const teams = await clickUp<{ teams: RemoteOption[] }>(access, '/team')
    const workspace = teams.teams.find(t => String(t.id) === workspaceId); if (!workspace) fail('Dieser ClickUp-Workspace ist nicht verfügbar.', 403)
    const list = await clickUp<RemoteList>(access, `/list/${listId}`)
    const spaces = await clickUp<{ spaces: RemoteOption[] }>(access, `/team/${workspaceId}/space?archived=false`)
    if (list.archived || !spaces.spaces.some(s => String(s.id) === String(list.space.id))) fail('Diese Liste gehört nicht zum gewählten Workspace.', 400)
    const path = [workspace.name, list.space.name, !list.folder?.hidden ? list.folder?.name : '', list.name].filter(Boolean).join(' / ')
    const count = h.connection().prepare('SELECT COUNT(*) AS count FROM inventory_clickup_lists WHERE projectId = ?').get(projectId)!
    if (Number(count.count) >= 30 && !h.connection().prepare('SELECT 1 FROM inventory_clickup_lists WHERE projectId=? AND listId=?').get(projectId, listId)) fail('Dieses Projekt hat bereits 30 ClickUp-Listen.')
    h.connection().prepare('INSERT INTO inventory_clickup_lists VALUES (?,?,?,?) ON CONFLICT(projectId,listId) DO UPDATE SET workspaceId=excluded.workspaceId,path=excluded.path').run(projectId, listId, workspaceId, path)
    h.logActivity(h.connection(), actor, 'clickup.project_linked', { projectId, listId })
    res.json({ ok: true })
  })
  route('post', '/projects/:id/unlink', 'manage_projects', async (req, res, actor) => {
    const projectId = id(req.params.id), listId = id(req.body?.listId)
    await clickUp(token(actor.id), `/list/${listId}`)
    h.connection().prepare('DELETE FROM inventory_clickup_lists WHERE projectId = ? AND listId = ?').run(projectId, listId)
    h.logActivity(h.connection(), actor, 'clickup.project_unlinked', { projectId, listId }); res.json({ ok: true })
  })
  route('get', '/lists/:id/tasks', 'read_inventory', async (req, res, actor) => {
    const listId = id(req.params.id), page = Number(req.query.page ?? 0)
    if (!Number.isInteger(page) || page < 0 || page > 10000) fail('Ungültige Aufgabenseite.')
    const data = await clickUp<{ tasks: RemoteTask[]; last_page?: boolean }>(token(actor.id), `/list/${listId}/task?page=${page}&include_closed=true&subtasks=true`)
    res.json({ tasks: data.tasks.map(t => ({ id: t.id, name: t.name, status: t.status?.status })), more: data.last_page === false || (data.last_page === undefined && data.tasks.length === 100) })
  })
  route('get', '/requests/:id', 'read_inventory', async (req, res, actor) => {
    const ctx = context(id(req.params.id))
    if (!connection(actor.id)) { res.json({ links: [] }); return }
    const result = []
    for (const link of links(ctx.groupKey)) {
      const canRemove = actor.id === link.ownerId || h.hasPermission(actor, 'order_stock')
      try {
        // Check the viewing user's current ClickUp access, not the creator's token.
        if (!link.taskId) {
          if (canRemove) result.push({ listId: link.listId, managed: !!link.managed, pending: true, canRemove: false, error: link.error ?? 'Erstellung läuft. Bei unklarem Ergebnis die Aufgabe in ClickUp prüfen und hier verknüpfen.' })
          continue
        }
        const task = await clickUp<RemoteTask>(token(actor.id), `/task/${id(link.taskId)}`)
        const paused = link.managed && !connection(link.ownerId)
        result.push({ listId: link.listId, taskId: task.id, name: task.name, url: `https://app.clickup.com/t/${encodeURIComponent(task.id)}`, status: task.status?.status, managed: !!link.managed, pending: false, canRemove, lastSyncedAt: link.lastSyncedAt, error: paused ? 'Statusübertragung pausiert: Die verknüpfende Person muss ClickUp erneut verbinden.' : link.error })
      } catch (error) { if ((error as { status?: number }).status !== 403) throw error }
    }
    res.json({ links: result })
  })
  route('post', '/requests/:id/link', 'read_inventory', async (req, res, actor) => {
    const requestId = id(req.params.id), ctx = context(requestId, actor), listId = id(req.body?.listId)
    const lock = `${ctx.groupKey}:${listId}`
    if (locked.has(lock)) fail('Diese Verknüpfung wird gerade bearbeitet.', 409)
    locked.add(lock)
    try {
      const existing = links(ctx.groupKey).find(l => l.listId === listId)
      if (existing?.taskId) { res.json({ ok: true }); return }
      const projectId = ctx.group[0].projectId
      if (!projectId || !h.connection().prepare('SELECT 1 FROM inventory_clickup_lists WHERE projectId=? AND listId=?').get(projectId, listId)) fail('Bitte diese ClickUp-Liste zuerst mit dem Inventarprojekt verbinden.')
      const access = token(actor.id)
      await clickUp<RemoteList>(access, `/list/${listId}`)
      const taskId = req.body?.taskId ? id(req.body.taskId) : undefined
      if (!taskId && existing) fail('Die vorherige Erstellung hat ein unklares Ergebnis. Bitte in ClickUp prüfen und die vorhandene Aufgabe hier auswählen, damit keine doppelte Aufgabe entsteht.', 409)
      if (taskId) {
        const task = await clickUp<RemoteTask>(access, `/task/${taskId}?include_markdown_description=true`)
        if (String(task.list.id) !== listId) fail('Die Aufgabe gehört nicht zur gewählten Liste.')
        const managed = existing?.managed && (task.markdown_description ?? task.description ?? '').includes(`[DCO-INVENTORY:${ctx.groupKey}]`) ? 1 : 0
        if (managed && h.connection().prepare('SELECT 1 FROM inventory_clickup_tasks WHERE taskId=? AND managed=1').get(taskId)) fail('Für diese Aufgabe besteht bereits eine automatische Statusübertragung.', 409)
        h.connection().prepare('INSERT INTO inventory_clickup_tasks (groupKey,requestId,listId,taskId,ownerId,managed) VALUES (?,?,?,?,?,?) ON CONFLICT(groupKey,listId) DO UPDATE SET taskId=excluded.taskId,ownerId=excluded.ownerId,managed=excluded.managed,error=NULL,retryAt=0').run(ctx.groupKey, requestId, listId, task.id, actor.id, managed)
      } else {
        // Persist BEFORE the POST: an ambiguous timeout/restart must never blindly create another task.
        h.connection().prepare('INSERT INTO inventory_clickup_tasks (groupKey,requestId,listId,ownerId,managed) VALUES (?,?,?,?,1)').run(ctx.groupKey, requestId, listId, actor.id)
        try {
          const task = await clickUp<RemoteTask>(access, `/list/${listId}/task`, { name: `${ctx.projectName} · ${clickUpReference(ctx.group[0])} · ${ctx.group.length} Inventarpositionen`.slice(0, 200), markdown_content: clickUpDescription('', ctx.groupKey, ctx.report), notify_all: false, check_required_custom_fields: true })
          id(task.id)
          h.connection().prepare('UPDATE inventory_clickup_tasks SET taskId=?,lastHash=?,lastSyncedAt=? WHERE groupKey=? AND listId=?').run(task.id, ctx.hash, new Date().toISOString(), ctx.groupKey, listId)
        } catch (error) {
          if ((error as { rejected?: boolean }).rejected) h.connection().prepare('DELETE FROM inventory_clickup_tasks WHERE groupKey=? AND listId=? AND taskId IS NULL').run(ctx.groupKey, listId)
          else h.connection().prepare('UPDATE inventory_clickup_tasks SET error=? WHERE groupKey=? AND listId=?').run('Erstellung nicht bestätigt. Bitte in ClickUp nach der Anfragenummer suchen und die Aufgabe hier verknüpfen.', ctx.groupKey, listId)
          throw error
        }
      }
      h.logActivity(h.connection(), actor, 'clickup.request_linked', { requestId, listId, created: !taskId })
      res.json({ ok: true })
    } finally { locked.delete(lock) }
  })
  route('post', '/requests/:id/unlink', 'read_inventory', async (req, res, actor) => {
    const ctx = context(id(req.params.id), actor), listId = id(req.body?.listId), lock = `${ctx.groupKey}:${listId}`
    if (locked.has(lock)) fail('Diese Verknüpfung wird gerade bearbeitet.', 409)
    const link = links(ctx.groupKey).find(l => l.listId === listId)
    if (!link || !link.taskId || !(link.ownerId === actor.id || h.hasPermission(actor, 'order_stock'))) fail('Diese Verknüpfung kann nicht entfernt werden.', 403)
    await clickUp(token(actor.id), `/task/${id(link.taskId)}`)
    if (locked.has(lock)) fail('Diese Verknüpfung wird gerade bearbeitet.', 409)
    h.connection().prepare('DELETE FROM inventory_clickup_tasks WHERE groupKey=? AND listId=?').run(ctx.groupKey, listId)
    h.logActivity(h.connection(), actor, 'clickup.request_unlinked', { requestId: link.requestId, listId }); res.json({ ok: true })
  })
  route('post', '/requests/:id/retry-create', 'read_inventory', async (req, res, actor) => {
    const ctx = context(id(req.params.id), actor), listId = id(req.body?.listId), lock = `${ctx.groupKey}:${listId}`
    if (req.body?.confirmedMissing !== true) fail('Bitte zuerst in ClickUp prüfen, ob die Aufgabe bereits angelegt wurde.')
    if (locked.has(lock)) fail('Die Erstellung läuft noch.', 409)
    const link = links(ctx.groupKey).find(l => l.listId === listId)
    if (!link || link.taskId || link.ownerId !== actor.id) fail('Diese Erstellung kann nicht zurückgesetzt werden.', 403)
    await clickUp(token(actor.id), `/list/${listId}`)
    if (locked.has(lock)) fail('Die Erstellung läuft noch.', 409)
    h.connection().prepare('DELETE FROM inventory_clickup_tasks WHERE groupKey=? AND listId=? AND taskId IS NULL').run(ctx.groupKey, listId)
    h.logActivity(h.connection(), actor, 'clickup.creation_retry_enabled', { requestId: link.requestId, listId })
    res.json({ ok: true })
  })
  async function sync() {
    if (stopped || syncing || !key()) return
    syncing = true
    try {
      const rows = h.connection().prepare('SELECT * FROM inventory_clickup_tasks WHERE managed=1 AND taskId IS NOT NULL AND retryAt<=? ORDER BY retryAt LIMIT 20').all(Date.now()) as unknown as Link[]
      if (!rows.length) return
      let authorized: Set<string>
      try { authorized = await h.authorizedIntegrationUsers([...new Set(rows.map(row => row.ownerId))]) }
      catch {
        for (const link of rows) h.connection().prepare('UPDATE inventory_clickup_tasks SET error=?,retryAt=? WHERE groupKey=? AND listId=?').run('Statusübertragung pausiert: Die Inventarberechtigung konnte nicht geprüft werden.', Date.now() + 60_000, link.groupKey, link.listId)
        return
      }
      for (const link of rows) {
        if (stopped) break
        const lock = `${link.groupKey}:${link.listId}`, owner = h.activeUserById(link.ownerId), saved = connection(link.ownerId)
        if (locked.has(lock)) continue
        // Rotate checked/paused entries so a large queue cannot starve later links.
        h.connection().prepare('UPDATE inventory_clickup_tasks SET retryAt=? WHERE groupKey=? AND listId=?').run(Date.now() + 60_000, link.groupKey, link.listId)
        if (!authorized.has(link.ownerId)) {
          h.connection().prepare('UPDATE inventory_clickup_tasks SET error=? WHERE groupKey=? AND listId=?').run('Statusübertragung pausiert: Die verknüpfende Person hat keinen aktiven Inventarzugang.', link.groupKey, link.listId)
          continue
        }
        if (!owner || !h.hasPermission(owner, 'read_inventory') || !saved) continue
        locked.add(lock)
        try {
          const ctx = context(link.requestId)
          if (ctx.hash === link.lastHash) {
            h.connection().prepare('UPDATE inventory_clickup_tasks SET error=NULL WHERE groupKey=? AND listId=?').run(link.groupKey, link.listId)
            continue
          }
          const access = openToken(saved), task = await clickUp<RemoteTask>(access, `/task/${id(link.taskId)}?include_markdown_description=true`)
          if (String(task.list.id) !== link.listId) fail('Aufgabe wurde in eine andere Liste verschoben. Verknüpfung bitte prüfen.', 409)
          if (stopped || connection(link.ownerId)?.secret !== saved.secret) continue
          const markdown = clickUpDescription(task.markdown_description ?? task.description ?? '', link.groupKey, ctx.report)
          await clickUp(access, `/task/${id(link.taskId)}`, { markdown_content: markdown }, 'PUT')
          h.connection().prepare('UPDATE inventory_clickup_tasks SET lastHash=?,lastSyncedAt=?,error=NULL WHERE groupKey=? AND listId=?').run(ctx.hash, new Date().toISOString(), link.groupKey, link.listId)
        } catch (error) {
          h.connection().prepare('UPDATE inventory_clickup_tasks SET error=?,retryAt=? WHERE groupKey=? AND listId=?').run(message(error), Date.now() + 5 * 60_000, link.groupKey, link.listId)
        } finally { locked.delete(lock) }
      }
    } finally { syncing = false }
  }
  const timer = setInterval(() => { void sync().catch(() => { /* Individual task failures are persisted and shown in the UI. */ }) }, 60_000)
  timer.unref()
  return { sync, stop: () => { stopped = true; clearInterval(timer) } }
}
