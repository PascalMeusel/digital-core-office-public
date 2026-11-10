import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import { clickUpDescription } from '../shared/clickup.ts'

const directory = mkdtempSync(join(tmpdir(), 'dco-clickup-')), databasePath = join(directory, 'inventory.sqlite'), password = 'L7!nRf4*Kw9#pUv8'
Object.assign(process.env, { INVENTORY_SYSTEM_DATA: databasePath, INVENTORY_MEDIA_DIR: join(directory, 'media'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'none.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'admin@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password, DISABLE_LOCAL_WEB_LOGIN: 'false', INVENTORY_CLICKUP_TOKEN_KEY: Buffer.alloc(32, 19).toString('base64') })
delete process.env.DCO_CORE_URL
const originalFetch = globalThis.fetch
const tokens = { admin: 'pk_admin_test_123456', sw: 'pk_software_test_123456', viewer: 'pk_viewer_test_123456' }
type Task = { id: string; name: string; list: { id: string }; markdown_description: string; status: { status: string } }
const tasks = new Map<string, Task>(), writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
let createMode = '', updatesBlocked = false
const lists = {
  '101': { id: '101', name: 'DemoDevice', space: { id: '11', name: 'Hardware' }, folder: { id: '21', name: 'Projects' } },
  '102': { id: '102', name: 'DemoDevice', space: { id: '12', name: 'Software' }, folder: { id: '22', name: 'hidden', hidden: true } },
}
globalThis.fetch = (async (input, options) => {
  const url = new URL(String(input))
  if (url.hostname !== 'api.clickup.com') return originalFetch(input, options)
  assert.equal(url.origin, 'https://api.clickup.com'); assert.equal(options?.redirect, 'error')
  const path = url.pathname.replace('/api/v2', ''), token = new Headers(options?.headers).get('Authorization'), method = options?.method ?? 'GET'
  const response = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }))
  if (!Object.values(tokens).includes(token!)) return response({ token, err: 'Unauthorized' }, 401)
  if (path === '/user') return response({ user: { username: token === tokens.sw ? 'Developer' : 'Administrator' } })
  if (path === '/team') return response({ teams: [{ id: '7', name: 'ExampleCompany' }, { id: '8', name: 'Other workspace' }] })
  if (path === '/team/7/space') return response({ spaces: [{ id: '11', name: 'Hardware' }, { id: '12', name: 'Software' }] })
  if (path === '/team/8/space') return response({ spaces: [] })
  if (path === '/space/11/folder') return response({ folders: [{ id: '21', name: 'Projects' }] })
  if (path === '/space/12/folder') return response({ folders: [] })
  if (path === '/folder/21/list') return response({ lists: [lists['101']] })
  if (path === '/space/12/list') return response({ lists: [lists['102']] })
  if (token === tokens.viewer && (path.startsWith('/task/') || path === '/list/101')) return response({ err: 'Private' }, 403)
  if (/^\/list\/\d+$/.test(path)) return response(lists[path.split('/')[2] as keyof typeof lists] ?? {}, lists[path.split('/')[2] as keyof typeof lists] ? 200 : 404)
  if (/^\/list\/\d+\/task$/.test(path)) {
    const listId = path.split('/')[2]
    if (method === 'GET') return response({ tasks: url.searchParams.get('page') === '1' ? [] : [...tasks.values()].filter(t => t.list.id === listId), last_page: url.searchParams.get('page') === '1' })
    const body = JSON.parse(String(options?.body)); writes.push({ method, path, body })
    if (createMode === 'reject') return response({ err: 'Required field', token }, 400)
    const task = { id: `task${tasks.size + 1}`, name: body.name, list: { id: listId }, markdown_description: body.markdown_content, status: { status: 'open' } }
    tasks.set(task.id, task)
    if (createMode === 'ambiguous') throw new Error('Socket closed after server created the task')
    return response(task)
  }
  if (path.startsWith('/task/')) {
    const task = tasks.get(path.split('/')[2]); if (!task) return response({}, 404)
    if (method === 'PUT') {
      if (updatesBlocked) return response({ token, err: 'Forbidden' }, 403)
      const body = JSON.parse(String(options?.body)); writes.push({ method, path, body }); task.markdown_description = body.markdown_content
    }
    return response(task)
  }
  throw new Error(`Unexpected ClickUp mock route: ${method} ${path}`)
}) as typeof fetch
const { inventorySystemRouter, closeInventorySystemDatabase, inventoryClickUp } = await import('../server/inventorySystem.ts')
const app = express(); app.use(express.json()); app.use('/api', inventorySystemRouter)
const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address(); assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}/api`
type Session = { cookie: string; csrf: string; id: string }
async function call(path: string, body?: object, session?: Session) {
  const response = await originalFetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
async function login(email: string) { const r = await call('/auth/login', { email, password }); assert.equal(r.status, 200); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('inventory_session='))!.split(';')[0], csrf: r.data.csrfToken, id: r.data.currentUser.id } }
const admin = await login('admin@example.test')
async function ok(path: string, body?: object, session = admin) { const r = await call(path, body, session); assert.ok(r.status >= 200 && r.status < 300, `${path}: ${r.status} ${r.data.message}`); return r.data }
for (const [name, role] of [['sw', 'software_developer'], ['viewer', 'viewer']]) await ok('/users', { name, email: `${name}@example.test`, role, password, mustChangePassword: false })
const sw = await login('sw@example.test'), viewer = await login('viewer@example.test')
const project = (await ok('/projects', { name: 'DemoDevice', code: 'DEMO' })).projects[0]
const item = (await ok('/items', { name: 'DemoDevice board', sku: 'DEMO-BOARD', unit: 'pcs' })).items[0]
const room = (await ok('/locations', { name: 'Lab', code: 'LAB', kind: 'room' })).locations[0]
const db = new DatabaseSync(databasePath)
async function sync() { db.exec('UPDATE inventory_clickup_tasks SET retryAt=0'); await inventoryClickUp.sync() }
async function purchase() { return (await ok('/workflows/requests', { kind: 'purchase', itemId: item.id, projectId: project.id, quantity: 2, estimatedUnitCost: 3 }, sw)).workflows.requests[0] }
after(async () => { inventoryClickUp.stop(); globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); closeInventorySystemDatabase(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) })

test('ClickUp access is authenticated, CSRF protected, per-user and encrypted', async () => {
  assert.equal((await call('/clickup/connection')).status, 401)
  assert.equal((await call('/clickup/connect', { token: tokens.admin }, { ...admin, csrf: '' })).status, 403)
  const invalid = await call('/clickup/connect', { token: 'pk_wrong_but_valid_format' }, admin)
  assert.equal(invalid.status, 403); assert.ok(!JSON.stringify(invalid.data).includes('pk_'))
  for (const [session, token] of [[admin, tokens.admin], [sw, tokens.sw], [viewer, tokens.viewer]] as const) await ok('/clickup/connect', { token }, session)
  const saved = db.prepare('SELECT * FROM inventory_clickup_connections').all()
  assert.equal(saved.length, 3); assert.ok(saved.every(row => !String(row.secret).includes('pk_')))
  assert.equal((await ok('/clickup/connection', undefined, sw)).name, 'Developer')
  const original = saved.find(row => row.userId === sw.id)!.secret
  db.prepare('UPDATE inventory_clickup_connections SET secret=? WHERE userId=?').run(saved.find(row => row.userId === admin.id)!.secret, sw.id)
  assert.equal((await call('/clickup/browse?kind=workspaces', undefined, sw)).status, 409, 'Ciphertext is bound to the inventory user')
  db.prepare('UPDATE inventory_clickup_connections SET secret=? WHERE userId=?').run(original, sw.id)
})

test('same-name lists in different teams remain separate and are checked against workspace membership', async () => {
  assert.deepEqual(await ok(`/clickup/projects/${project.id}/lists`, undefined, sw), { lists: [], setup: 'unmapped' })
  assert.equal((await ok('/clickup/browse?kind=workspaces')).options.length, 2)
  assert.equal((await ok('/clickup/browse?kind=spaces&parent=7')).options.length, 2)
  assert.equal((await call(`/clickup/projects/${project.id}/lists`, { workspaceId: '8', listId: '101' }, admin)).status, 400)
  assert.equal((await call(`/clickup/projects/${project.id}/lists`, { workspaceId: '7', listId: '101' }, sw)).status, 403)
  for (const listId of ['101', '102']) await ok(`/clickup/projects/${project.id}/lists`, { workspaceId: '7', listId })
  const result = await ok(`/clickup/projects/${project.id}/lists`)
  assert.equal(result.setup, 'ready')
  assert.deepEqual(result.lists.map((l: { listId: string }) => l.listId), ['101', '102'])
  assert.match(result.lists[0].path, /ExampleCompany \/ Hardware \/ Projects \/ DemoDevice/)
  assert.match(result.lists[1].path, /ExampleCompany \/ Software \/ DemoDevice/)
  assert.equal((await ok(`/clickup/projects/${project.id}/lists`, undefined, viewer)).lists.length, 1, 'Private list is hidden from another user')
  const privateProject = (await ok('/projects', { name: 'Private mappings', code: 'PRIVATE' })).projects.find((p: { code: string }) => p.code === 'PRIVATE')
  await ok(`/clickup/projects/${privateProject.id}/lists`, { workspaceId: '7', listId: '101' })
  assert.deepEqual(await ok(`/clickup/projects/${privateProject.id}/lists`, undefined, viewer), { lists: [], setup: 'inaccessible' }, 'Setup hint must not leak private list IDs or paths')
})

test('one ClickUp task contains the entire batch, deferred positions and partial delivery progress', async () => {
  const state = await ok('/workflows/requests/batch', { projectId: project.id, lines: [{ itemId: item.id, quantity: 2, estimatedUnitCost: 3 }, { itemName: 'IMU cable', quantity: 3, estimatedUnitCost: 1 }] }, sw)
  const group = state.workflows.requests.filter((r: { batchId?: string }) => !!r.batchId), first = group[0]
  assert.equal((await call(`/clickup/requests/${first.id}/link`, { listId: '101' }, viewer)).status, 403)
  const before = writes.length
  await ok(`/clickup/requests/${first.id}/link`, { listId: '101' }, sw)
  await ok(`/clickup/requests/${group[1].id}/link`, { listId: '101' }, sw)
  assert.equal(writes.length, before + 1, 'Duplicate submission through another position does not create another task')
  assert.equal(writes.at(-1)!.body.check_required_custom_fields, true)
  const task = [...tasks.values()].at(-1)!
  assert.match(task.markdown_description, /DemoDevice board/); assert.match(task.markdown_description, /IMU cable/)
  task.markdown_description = `Team notes **keep these**\n\n${task.markdown_description}\n\nOther notes`
  await ok(`/workflows/request-batches/${first.batchId}/review`, { lines: group.map((r: { id: string; version: number }, i: number) => ({ requestId: r.id, expectedVersion: r.version, decision: i === 0 ? 'approve' : 'defer', note: 'Later phase' })) })
  await sync(); assert.match(task.markdown_description, /Freigegeben/); assert.match(task.markdown_description, /Zurückgestellt/)
  assert.ok(task.markdown_description.startsWith('Team notes **keep these**')); assert.ok(task.markdown_description.endsWith('Other notes'))
  const approved = (await ok('/state')).workflows.requests.find((r: { id: string }) => r.id === first.id)
  const order = (await ok('/workflows/orders', { supplier: 'Supplier', reference: 'CU-1', shipping: 2, lines: [{ requestId: approved.id, expectedVersion: approved.version, unitCost: approved.estimatedUnitCost }] })).workflows.orders[0]
  await ok(`/workflows/orders/${order.id}/receive`, { expectedVersion: order.version, lines: [{ lineId: order.lines[0].id, quantity: 1, locationId: room.id, condition: 'new' }] })
  await sync(); assert.match(task.markdown_description, /1 von .* eingegangen/)
  assert.equal(task.status.status, 'open', 'Team workflow status is not guessed or overwritten')
  const sent = writes.length; await sync(); assert.equal(writes.length, sent, 'Unchanged report does not write again')
  assert.equal((await ok(`/clickup/requests/${first.id}`, undefined, viewer)).links.length, 0)
})

test('existing task links are read-only, require matching lists and may be reused by another request', async () => {
  tasks.set('existing', { id: 'existing', name: 'Software development', list: { id: '102' }, markdown_description: 'Existing team content', status: { status: 'in progress' } })
  const request = await purchase(), before = writes.length
  assert.equal((await call(`/clickup/requests/${request.id}/link`, { listId: '101', taskId: 'existing' }, sw)).status, 400)
  await ok(`/clickup/requests/${request.id}/link`, { listId: '102', taskId: 'existing' }, sw)
  await sync(); assert.equal(writes.length, before)
  const link = (await ok(`/clickup/requests/${request.id}`, undefined, sw)).links[0]
  assert.equal(link.managed, false); assert.equal(link.status, 'in progress')
  const next = await purchase()
  await ok(`/clickup/requests/${next.id}/link`, { listId: '102', taskId: 'existing' }, sw)
  await ok(`/clickup/requests/${request.id}/unlink`, { listId: '102' }, sw)
  assert.ok(tasks.has('existing')); assert.equal(tasks.get('existing')!.markdown_description, 'Existing team content')
})

test('definitive rejection permits retry; ambiguous creation never duplicates and can be reconciled', async () => {
  const request = await purchase()
  createMode = 'reject'
  assert.equal((await call(`/clickup/requests/${request.id}/link`, { listId: '101' }, sw)).status, 502)
  assert.equal((await ok(`/clickup/requests/${request.id}`, undefined, sw)).links.length, 0)
  createMode = 'ambiguous'
  assert.equal((await call(`/clickup/requests/${request.id}/link`, { listId: '101' }, sw)).status, 502)
  const count = tasks.size, created = [...tasks.values()].at(-1)!
  assert.equal((await ok(`/clickup/requests/${request.id}`, undefined, sw)).links[0].pending, true)
  createMode = ''
  assert.equal((await call(`/clickup/requests/${request.id}/link`, { listId: '101' }, sw)).status, 409)
  assert.equal(tasks.size, count)
  await ok(`/clickup/requests/${request.id}/link`, { listId: '101', taskId: created.id }, sw)
  assert.equal((await ok(`/clickup/requests/${request.id}`, undefined, sw)).links[0].managed, true)
})

test('background failures are visible, back off and never roll back inventory actions; disconnect pauses sync', async () => {
  const request = await purchase()
  await ok(`/clickup/requests/${request.id}/link`, { listId: '102' }, sw)
  await ok(`/workflows/requests/${request.id}/review`, { expectedVersion: request.version, decision: 'defer', note: 'Budget next week' })
  updatesBlocked = true; await sync()
  let link = (await ok(`/clickup/requests/${request.id}`, undefined, sw)).links[0]
  assert.match(link.error, /Kein ClickUp-Zugriff/); assert.ok(!link.error.includes('pk_'))
  assert.equal((await ok('/state')).workflows.requests.find((r: { id: string }) => r.id === request.id).status, 'deferred')
  const retries = db.prepare('SELECT retryAt FROM inventory_clickup_tasks WHERE requestId=?').get(request.id)!
  assert.ok(Number(retries.retryAt) > Date.now() + 240000)
  await ok('/clickup/disconnect', {}, sw); updatesBlocked = false
  const before = writes.length; await sync(); assert.equal(writes.length, before)
  await ok('/clickup/connect', { token: tokens.sw }, sw); await sync()
  link = (await ok(`/clickup/requests/${request.id}`, undefined, sw)).links[0]; assert.equal(link.error, null)
  assert.match(tasks.get(link.taskId)!.markdown_description, /Zurückgestellt/)
})

test('report block preserves team content and refuses a broken marker', () => {
  const body = clickUpDescription('Keep me', 'request:one', 'First report')
  assert.equal(clickUpDescription(body, 'request:one', 'Updated'), 'Keep me\n\n[DCO-INVENTORY:request:one]\nUpdated\n[/DCO-INVENTORY:request:one]')
  assert.throws(() => clickUpDescription('[DCO-INVENTORY:request:one]\nEdited', 'request:one', 'Next'), /Markierungen/)
})

test('disabled inventory owners stop background updates even while their ClickUp token is valid', async () => {
  const request = await purchase()
  await ok(`/clickup/requests/${request.id}/link`, { listId: '101' }, sw)
  await ok(`/workflows/requests/${request.id}/review`, { expectedVersion: request.version, decision: 'defer', note: 'After access revocation' })
  const before = writes.length
  db.prepare('UPDATE inventory_users SET active=0 WHERE id=?').run(sw.id)
  try { await sync(); assert.equal(writes.length, before); assert.match(String(db.prepare('SELECT error FROM inventory_clickup_tasks WHERE requestId=?').get(request.id)!.error), /Inventarzugang/) }
  finally { db.prepare('UPDATE inventory_users SET active=1 WHERE id=?').run(sw.id) }
})
