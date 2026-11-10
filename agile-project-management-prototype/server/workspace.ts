import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { emptyWorkspace, type AgileState, type Decision, type Stakeholder, type WorkItem, type WorkspaceAudit, type WorkspaceSnapshot } from '../src/workspace.ts'

export interface WorkspaceActor { id: string; name: string; role: 'admin' | 'employee'; active: boolean; mustChangePassword?: boolean; readOnly?: boolean }
export class WorkspaceError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const roles = ['Sales', 'Project Management', 'Software Development', 'Hardware Development']
const areas = ['Sales', 'Project', 'Software', 'Hardware']

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError(400, 'An object is required.')
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, max: number, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new WorkspaceError(400, `${field} is invalid.`)
  return value
}
function choice(value: unknown, field: string, values: readonly string[]) {
  if (typeof value !== 'string' || !values.includes(value)) throw new WorkspaceError(400, `${field} is invalid.`)
  return value
}
function number(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new WorkspaceError(400, `${field} is invalid.`)
  return value
}
function date(value: unknown, field: string) {
  const result = text(value, field, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new WorkspaceError(400, `${field} is invalid.`)
  return result
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new WorkspaceError(400, 'Unknown workspace fields are not accepted.')
}
function item(value: unknown): WorkItem {
  const v = object(value)
  keys(v, ['id','title','type','area','status','owner','stakeholder','priority','effort','businessValue','risk','sprint','release','due','dependsOn','acceptance','updatedAt'])
  return {
    id: text(v.id, 'ID', 160), title: text(v.title, 'Title', 500),
    type: choice(v.type, 'Type', ['Opportunity','Requirement','Epic','Story','Task','Bug','Decision']) as WorkItem['type'],
    area: choice(v.area, 'Area', areas) as WorkItem['area'],
    status: choice(v.status, 'Status', ['Intake','Ready','In Progress','Blocked','Review','Done']) as WorkItem['status'],
    owner: choice(v.owner, 'Owner', roles) as WorkItem['owner'],
    stakeholder: text(v.stakeholder, 'Stakeholder', 500, true),
    priority: choice(v.priority, 'Priority', ['Critical','High','Medium','Low']) as WorkItem['priority'],
    effort: number(v.effort, 'Effort', 1, 40), businessValue: number(v.businessValue, 'Business value', 1, 10), risk: number(v.risk, 'Risk', 1, 5),
    sprint: text(v.sprint, 'Sprint', 160, true), release: text(v.release, 'Release', 160, true), due: date(v.due, 'Due date'),
    dependsOn: text(v.dependsOn, 'Dependency', 2000, true), acceptance: text(v.acceptance, 'Acceptance criteria', 20000, true),
    updatedAt: text(v.updatedAt, 'Updated at', 40),
  }
}
function decision(value: unknown): Decision {
  const v = object(value)
  keys(v, ['id','title','owner','impact','status','date','notes'])
  return {
    id: text(v.id, 'ID', 160), title: text(v.title, 'Title', 500), owner: choice(v.owner, 'Owner', roles) as Decision['owner'],
    impact: choice(v.impact, 'Impact', areas) as Decision['impact'], status: choice(v.status, 'Decision status', ['Proposed','Accepted','Rejected']) as Decision['status'],
    date: date(v.date, 'Decision date'), notes: text(v.notes, 'Notes', 20000, true),
  }
}
function stakeholder(value: unknown): Stakeholder {
  const v = object(value)
  keys(v, ['id','name','role','focus','cadence','openRequests'])
  return {
    id: text(v.id, 'ID', 160), name: text(v.name, 'Name', 500), role: choice(v.role, 'Role', roles) as Stakeholder['role'],
    focus: text(v.focus, 'Focus', 20000, true), cadence: text(v.cadence, 'Cadence', 1000, true), openRequests: number(v.openRequests, 'Open requests', 0, 100000),
  }
}
function list<T extends {id: string}>(value: unknown, parser: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10000) throw new WorkspaceError(400, 'Workspace collection is invalid or too large.')
  const result = value.map(parser)
  if (new Set(result.map(v => v.id)).size !== result.length) throw new WorkspaceError(400, 'Duplicate record IDs are not accepted.')
  return result
}
export function validateWorkspace(value: unknown): AgileState {
  const v = object(value)
  keys(v, ['items','stakeholders','decisions','activeSprint','releaseGoal'])
  return { items: list(v.items, item), stakeholders: list(v.stakeholders, stakeholder), decisions: list(v.decisions, decision),
    activeSprint: text(v.activeSprint, 'Active sprint', 160, true), releaseGoal: text(v.releaseGoal, 'Release goal', 2000, true) }
}
function authorize(actor: WorkspaceActor) {
  if (!actor.active) throw new WorkspaceError(403, 'An active account is required.')
  if (actor.mustChangePassword) throw new WorkspaceError(428, 'Change your password in Digital Core Office before continuing.')
}
export function ensureWorkspaceSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS agile_workspace (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agile_workspace_audit (id TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, actorId TEXT NOT NULL, actorName TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL UNIQUE, command TEXT NOT NULL, beforeState TEXT NOT NULL, afterState TEXT NOT NULL, createdAt TEXT NOT NULL);`)
  sql.prepare('INSERT OR IGNORE INTO agile_workspace (id, revision, state) VALUES (1, 0, ?)').run(JSON.stringify(emptyWorkspace()))
}
function row(sql: DatabaseSync) {
  ensureWorkspaceSchema(sql)
  return sql.prepare('SELECT revision, state FROM agile_workspace WHERE id=1').get() as { revision: number; state: string }
}
export function readWorkspace(sql: DatabaseSync, actor: WorkspaceActor): WorkspaceSnapshot {
  authorize(actor)
  const current = row(sql)
  return { state: JSON.parse(current.state), revision: current.revision,
    permissions: { editWork: !actor.readOnly, approveDecisions: actor.role === 'admin' && !actor.readOnly, importWorkspace: actor.role === 'admin' && !actor.readOnly } }
}
export function readWorkspaceAudit(sql: DatabaseSync, actor: WorkspaceActor): WorkspaceAudit[] {
  authorize(actor); ensureWorkspaceSchema(sql)
  return sql.prepare('SELECT id, actorId, actorName, action, revision, createdAt FROM agile_workspace_audit ORDER BY revision DESC LIMIT 100').all() as unknown as WorkspaceAudit[]
}
function merge<T extends {id: string}>(current: T[], incoming: T[]): T[] {
  const existing = new Map(current.map(value => [value.id, value]))
  const added: T[] = []
  for (const entry of incoming) {
    const prior = existing.get(entry.id)
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) throw new WorkspaceError(409, `Import conflicts with existing record ${entry.id}. No records were imported; keep the exported copy and resolve the duplicate first.`)
    if (!prior) added.push(entry)
  }
  return [...current, ...added]
}
export function mutateWorkspace(sql: DatabaseSync, actor: WorkspaceActor, input: unknown): WorkspaceSnapshot {
  authorize(actor)
  if (actor.readOnly) throw new WorkspaceError(403, 'The workspace is currently read-only.')
  const command = object(input)
  keys(command, ['requestId','revision','operation'])
  const requestId = text(command.requestId, 'Request ID', 160)
  const revision = number(command.revision, 'Revision', 0, Number.MAX_SAFE_INTEGER)
  const operation = object(command.operation)
  const action = choice(operation.type, 'Operation', ['create_item','update_item','create_decision','update_decision','import_workspace'])
  if (['update_decision','import_workspace'].includes(action) && actor.role !== 'admin') throw new WorkspaceError(403, 'Administrator access is required for this action.')
  ensureWorkspaceSchema(sql)
  sql.exec('BEGIN IMMEDIATE')
  try {
    const previous = sql.prepare('SELECT actorId, command FROM agile_workspace_audit WHERE requestId=?').get(requestId) as {actorId: string; command: string} | undefined
    if (previous) {
      if (previous.actorId !== actor.id || previous.command !== JSON.stringify(operation)) throw new WorkspaceError(409, 'This request ID was already used for a different operation.')
      sql.exec('COMMIT')
      return readWorkspace(sql, actor)
    }
    const current = row(sql)
    if (current.revision !== revision) throw new WorkspaceError(409, 'The workspace changed on another device. Review the latest data before retrying your change.')
    const state = JSON.parse(current.state) as AgileState
    if (action === 'create_item') {
      keys(operation, ['type','item'])
      const added = item(operation.item)
      if (state.items.some(v => v.id === added.id)) throw new WorkspaceError(409, 'This item already exists.')
      added.updatedAt = new Date().toISOString(); state.items.unshift(added)
    } else if (action === 'update_item') {
      keys(operation, ['type','id','patch'])
      const id = text(operation.id, 'ID', 160); const patch = object(operation.patch)
      if ('id' in patch || 'updatedAt' in patch) throw new WorkspaceError(400, 'Record identity and timestamps cannot be changed.')
      const index = state.items.findIndex(v => v.id === id)
      if (index < 0) throw new WorkspaceError(404, 'The work item no longer exists.')
      state.items[index] = item({ ...state.items[index], ...patch, updatedAt: new Date().toISOString() })
    } else if (action === 'create_decision') {
      keys(operation, ['type','decision'])
      const added = decision(operation.decision)
      if (actor.role !== 'admin' && added.status !== 'Proposed') throw new WorkspaceError(403, 'Employees may propose decisions; administrators approve or reject them.')
      if (state.decisions.some(v => v.id === added.id)) throw new WorkspaceError(409, 'This decision already exists.')
      state.decisions.unshift(added)
    } else if (action === 'update_decision') {
      keys(operation, ['type','id','status'])
      const id = text(operation.id, 'ID', 160)
      const index = state.decisions.findIndex(v => v.id === id)
      if (index < 0) throw new WorkspaceError(404, 'The decision no longer exists.')
      state.decisions[index] = decision({ ...state.decisions[index], status: operation.status })
    } else {
      keys(operation, ['type','state'])
      const imported = validateWorkspace(operation.state)
      const empty = state.items.length + state.decisions.length + state.stakeholders.length === 0
      if (!empty && (state.activeSprint !== imported.activeSprint || state.releaseGoal !== imported.releaseGoal)) throw new WorkspaceError(409, 'Import workspace settings differ from the shared workspace. No data was overwritten. Resolve the settings in the exported copy first.')
      state.items = merge(state.items, imported.items); state.decisions = merge(state.decisions, imported.decisions); state.stakeholders = merge(state.stakeholders, imported.stakeholders)
      if (empty) { state.activeSprint = imported.activeSprint; state.releaseGoal = imported.releaseGoal }
    }
    if (JSON.stringify(state).length > 8 * 1024 * 1024) throw new WorkspaceError(400, 'Workspace exceeds the supported size.')
    sql.prepare('UPDATE agile_workspace SET revision=?, state=? WHERE id=1').run(revision + 1, JSON.stringify(state))
    sql.prepare('INSERT INTO agile_workspace_audit (id,requestId,actorId,actorName,action,revision,command,beforeState,afterState,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),requestId,actor.id,actor.name,action,revision+1,JSON.stringify(operation),current.state,JSON.stringify(state),new Date().toISOString())
    sql.exec('COMMIT')
    return readWorkspace(sql, actor)
  } catch (error) { sql.exec('ROLLBACK'); throw error }
}
