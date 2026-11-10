import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { emptyWorkspace, type WorkItem } from '../src/workspace.ts'
import { mutateWorkspace, readWorkspace, readWorkspaceAudit, validateWorkspace, WorkspaceError, type WorkspaceActor } from '../server/workspace.ts'

const employee: WorkspaceActor = { id: 'employee-one', name: 'Employee One', role: 'employee', active: true }
const admin: WorkspaceActor = { id: 'admin-one', name: 'Admin One', role: 'admin', active: true }
function exampleItem(id = 'item-one'): WorkItem {
  return { id, title: 'Launch acceptance', type: 'Task', area: 'Software', status: 'Intake', owner: 'Software Development', stakeholder: 'Delivery', priority: 'High', effort: 3, businessValue: 8, risk: 2, sprint: 'Sprint 1', release: 'Launch', due: '2026-09-30', dependsOn: '', acceptance: 'Verified by another user on another device.', updatedAt: '2026-09-06T10:00:00.000Z' }
}
function status(expected: number) { return (error: unknown) => error instanceof WorkspaceError && error.status === expected }
function database() { return new DatabaseSync(':memory:') }

test('a saved item survives a database reopen and is visible to a different user', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-agile-persistence-'))
  const path = join(directory, 'agile.sqlite')
  let sql = new DatabaseSync(path)
  try {
    assert.deepEqual(readWorkspace(sql, employee).state, emptyWorkspace())
    mutateWorkspace(sql, employee, { requestId: 'create-one', revision: 0, operation: { type: 'create_item', item: exampleItem() } })
    sql.close(); sql = new DatabaseSync(path)
    const actual = readWorkspace(sql, admin)
    assert.equal(actual.revision, 1); assert.equal(actual.state.items[0].title, 'Launch acceptance')
    const audit = readWorkspaceAudit(sql, admin)
    assert.equal(audit[0].actorId, employee.id); assert.equal(audit[0].action, 'create_item')
    const durableAudit = sql.prepare('SELECT beforeState, afterState FROM agile_workspace_audit').get() as {beforeState:string; afterState:string}
    assert.equal(JSON.parse(durableAudit.beforeState).items.length, 0)
    assert.equal(JSON.parse(durableAudit.afterState).items.length, 1)
  } finally { sql.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('stale concurrent edits cannot overwrite data; response retries are idempotent', () => {
  const sql = database()
  try {
    const command = { requestId: 'create-one', revision: 0, operation: { type: 'create_item', item: exampleItem() } }
    mutateWorkspace(sql, employee, command)
    assert.throws(() => mutateWorkspace(sql, admin, { requestId:'other-user', revision:0, operation:{type:'create_item',item:exampleItem('item-two')} }), status(409))
    assert.equal(readWorkspace(sql, admin).state.items.length, 1)
    assert.equal(mutateWorkspace(sql, employee, command).revision, 1)
    assert.equal(readWorkspaceAudit(sql, employee).length, 1)
    assert.throws(() => mutateWorkspace(sql, admin, command), status(409))
    mutateWorkspace(sql, admin, { requestId:'other-user', revision:1, operation:{type:'create_item',item:exampleItem('item-two')} })
    assert.equal(readWorkspace(sql, employee).state.items.length, 2)
  } finally { sql.close() }
})

test('employees can propose decisions but cannot approve, import, forge authors or write when read-only', () => {
  const sql = database()
  try {
    const proposed = {id:'decision-one',title:'Release approval',owner:'Project Management',impact:'Project',status:'Proposed',date:'2026-09-06',notes:'Pending acceptance.'}
    mutateWorkspace(sql, employee, {requestId:'proposal',revision:0,operation:{type:'create_decision',decision:proposed}})
    assert.throws(() => mutateWorkspace(sql, employee, {requestId:'approval',revision:1,operation:{type:'update_decision',id:proposed.id,status:'Accepted'}}), status(403))
    assert.throws(() => mutateWorkspace(sql, employee, {requestId:'forged-approved',revision:1,operation:{type:'create_decision',decision:{...proposed,id:'another',status:'Accepted'}}}), status(403))
    assert.throws(() => mutateWorkspace(sql, employee, {requestId:'import',revision:1,operation:{type:'import_workspace',state:emptyWorkspace()}}), status(403))
    assert.throws(() => mutateWorkspace(sql, {...admin,readOnly:true}, {requestId:'write',revision:1,operation:{type:'create_item',item:exampleItem()}}), status(403))
    assert.throws(() => mutateWorkspace(sql, employee, {requestId:'forge',revision:1,actorId:admin.id,operation:{type:'create_item',item:exampleItem()}}), status(400))
    mutateWorkspace(sql, admin, {requestId:'approval',revision:1,operation:{type:'update_decision',id:proposed.id,status:'Accepted'}})
    assert.equal(readWorkspace(sql, employee).state.decisions[0].status, 'Accepted')
    assert.equal(readWorkspaceAudit(sql, employee)[0].actorId, admin.id)
    assert.throws(() => readWorkspace(sql, {...employee,active:false}), status(403))
    assert.throws(() => mutateWorkspace(sql, {...employee,mustChangePassword:true}, {}), status(428))
  } finally { sql.close() }
})

test('legacy workspace import is lossless, repeatable, and conflicting imports roll back completely', () => {
  const sql = database()
  try {
    const legacy = {...emptyWorkspace(),activeSprint:'Sprint 27',releaseGoal:'Historical release',items:[exampleItem()],stakeholders:[{id:'person-one',name:'Stakeholder',role:'Sales',focus:'Commercial readiness',cadence:'Weekly',openRequests:2}]}
    const input = JSON.parse(JSON.stringify(legacy))
    mutateWorkspace(sql, admin, {requestId:'import-one',revision:0,operation:{type:'import_workspace',state:input}})
    assert.deepEqual(readWorkspace(sql, employee).state, legacy)
    mutateWorkspace(sql, admin, {requestId:'import-again',revision:1,operation:{type:'import_workspace',state:input}})
    assert.equal(readWorkspace(sql, employee).state.items.length, 1)
    const conflicting = {...legacy, items:[exampleItem('new-item'), {...exampleItem(),title:'Would overwrite original'}]}
    assert.throws(() => mutateWorkspace(sql, admin, {requestId:'bad-import',revision:2,operation:{type:'import_workspace',state:conflicting}}), status(409))
    assert.deepEqual(readWorkspace(sql, employee).state, legacy)
    assert.deepEqual(input, legacy)
    assert.equal(readWorkspaceAudit(sql, admin).length, 2)
  } finally { sql.close() }
})

test('invalid and unsupported import fields fail explicitly instead of silently dropping data', () => {
  assert.throws(() => validateWorkspace({...emptyWorkspace(),items:[{...exampleItem(),due:'2026-02-30'}]}), status(400))
  assert.throws(() => validateWorkspace({...emptyWorkspace(),items:[{...exampleItem(),privateNotes:'Would be lost'}]}), status(400))
  assert.throws(() => validateWorkspace({...emptyWorkspace(),items:[exampleItem(),exampleItem()]}), status(400))
  const sql = database()
  try {
    mutateWorkspace(sql, employee, {requestId:'create',revision:0,operation:{type:'create_item',item:exampleItem()}})
    assert.throws(() => mutateWorkspace(sql, employee, {requestId:'invalid',revision:1,operation:{type:'update_item',id:'item-one',patch:{id:'replacement'}}}), status(400))
    assert.equal(readWorkspace(sql, employee).revision, 1)
  } finally { sql.close() }
})
