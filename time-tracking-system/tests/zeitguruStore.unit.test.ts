import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { ZeitguruStore, ZeitguruStoreError, type ZeitguruClockInput, type ZeitguruCompletion, type ZeitguruDeliveryPlan } from '../server/zeitguruStore.ts'

function fixture(t: TestContext) {
  const previousKey = process.env.DATA_ENCRYPTION_KEY
  const previousRequired = process.env.REQUIRE_DATA_ENCRYPTION
  process.env.DATA_ENCRYPTION_KEY = 'zeitguru-synthetic-encryption-key-for-unit-tests'
  process.env.REQUIRE_DATA_ENCRYPTION = 'false'
  const directory = mkdtempSync(join(tmpdir(), 'dco-zeitguru-journal-'))
  const path = join(directory, 'time.sqlite')
  let timestamp = 1_800_000_000_000
  const store = new ZeitguruStore(path, { now: () => timestamp })
  const tx = new DatabaseSync(path)
  tx.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE local_clock(id TEXT PRIMARY KEY, value INTEGER);')
  t.after(() => {
    tx.close(); store.close(); rmSync(directory, { recursive: true, force: true })
    if (previousKey === undefined) delete process.env.DATA_ENCRYPTION_KEY; else process.env.DATA_ENCRYPTION_KEY = previousKey
    if (previousRequired === undefined) delete process.env.REQUIRE_DATA_ENCRYPTION; else process.env.REQUIRE_DATA_ENCRYPTION = previousRequired
  })
  const connect = (userId = 'employee-1', providerKey = 'tenant-1/provider-1', expectedGeneration = store.status(userId).generation) =>
    store.connect({ userId, providerKey, expectedGeneration, auth: { password: 'private-provider-password', token: 'enc:v1:untrusted-input-token' }, config: { tenant: 'private-tenant-label' } })
  function transaction<T>(callback: () => T) {
    tx.exec('BEGIN IMMEDIATE')
    try { const value = callback(); tx.exec('COMMIT'); return value }
    catch (error) { tx.exec('ROLLBACK'); throw error }
  }
  const input = (overrides: Partial<ZeitguruClockInput> = {}): ZeitguruClockInput => ({
    userId: 'employee-1', clientOperationId: 'operation-1', expectedGeneration: store.status('employee-1').generation,
    expectedRevision: store.getClockRevision('employee-1'), action: 'start_work', request: { workLocation: 'office' }, ...overrides,
  })
  const enqueue = (overrides: Partial<ZeitguruClockInput> = {}) => transaction(() => {
    const result = store.withClockOperation(tx, input(overrides), () => ({ entryId: 'private-entry-id', at: timestamp }))
    assert.equal(result.kind, 'committed')
    return result.operation
  })
  return { store, tx, path, directory, connect, transaction, input, enqueue, advance: (ms: number) => { timestamp += ms } }
}
function errorCode(code: string) { return (error: unknown) => error instanceof ZeitguruStoreError && error.code === code }
test('successful sync progress survives restart and rejects stale generations, revisions and backwards progress', t => {
  const f = fixture(t); f.connect()
  f.store.markSynchronized('employee-1', 1, 0, '2026-09-07')
  assert.equal(f.store.readConnection('employee-1')!.config.liveSyncThroughDate, '2026-09-07')
  const reopened = new ZeitguruStore(f.path)
  assert.equal(reopened.readConnection('employee-1')!.config.liveSyncThroughDate, '2026-09-07'); reopened.close()
  assert.throws(() => f.store.markSynchronized('employee-1', 0, 0, '2026-09-08'), errorCode('connection_conflict'))
  assert.throws(() => f.store.markSynchronized('employee-1', 1, 1, '2026-09-08'), errorCode('connection_conflict'))
  assert.throws(() => f.store.markSynchronized('employee-1', 1, 0, '2026-09-06'), errorCode('revision_conflict'))
  assert.throws(() => f.store.markSynchronized('employee-1', 1, 0, '2026-02-30'))
  assert.equal(f.store.readConnection('employee-1')!.config.liveSyncThroughDate, '2026-09-07')
})
function deliveryPlan(): ZeitguruDeliveryPlan {
  return { localEntryId:'private-entry-id',expectedRow:null,desiredRow:{id:'provider-clock-row',startTime:1_800_000_000_000},patch:{'timeClockings/provider-clock-row':{startTime:1_800_000_000_000}} }
}

test('credentials, configuration and immutable operation payload are encrypted; public status excludes secrets', (t) => {
  const f = fixture(t)
  f.connect(); const operation = f.enqueue()
  const row = f.tx.prepare('SELECT authCipher,configCipher,providerKey FROM zeitguru_connections').get()!
  assert.match(String(row.authCipher), /^enc:v1:/)
  assert.match(String(row.configCipher), /^enc:v1:/)
  assert.notEqual(row.providerKey, 'tenant-1/provider-1')
  assert.match(String(f.tx.prepare('SELECT payloadCipher FROM zeitguru_operations').get()!.payloadCipher), /^enc:v1:/)
  const visible = JSON.stringify({ status: f.store.status('employee-1'), operation })
  const bytes = readFileSync(f.path)
  for (const secret of ['private-provider-password', 'enc:v1:untrusted-input-token', 'private-tenant-label', 'private-entry-id']) {
    assert.equal(visible.includes(secret), false)
    assert.equal(bytes.includes(Buffer.from(secret)), false)
  }
  for (const field of ['authCipher', 'configCipher', 'payloadCipher', 'providerKey', 'attemptToken', 'requestFingerprint']) assert.equal(visible.includes(field), false)
  const claim = f.store.claimNext()!
  assert.equal(claim.auth.password, 'private-provider-password')
  assert.equal(claim.auth.token, 'enc:v1:untrusted-input-token')
  assert.equal(claim.payload.entryId, 'private-entry-id')
  assert.equal(f.store.saveDeliveryPlan(claim, deliveryPlan()), true)
  assert.equal(f.store.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'provider_response', secret: 'do-not-return' } } as ZeitguruCompletion), true)
  assert.equal(JSON.stringify(f.store.status('employee-1')).includes('do-not-return'), false)
})

test('encryption is mandatory even when global encryption is optional; plaintext credential rows are refused', (t) => {
  const f = fixture(t)
  delete process.env.DATA_ENCRYPTION_KEY
  assert.throws(() => f.connect(), errorCode('encryption_unavailable'))
  assert.equal(f.store.status('employee-1').generation, 0)
  process.env.DATA_ENCRYPTION_KEY = 'zeitguru-synthetic-encryption-key-for-unit-tests'
  f.connect(); f.enqueue()
  f.tx.prepare('UPDATE zeitguru_connections SET authCipher=?').run('{"password":"legacy-plaintext-secret"}')
  assert.equal(f.store.claimNext(), undefined)
  const state = f.store.status('employee-1')
  assert.equal(state.latestOperation?.status, 'authentication_required')
  assert.equal(state.latestOperation?.errorCode, 'credentials_unavailable')
  assert.equal(JSON.stringify(state).includes('legacy-plaintext-secret'), false)
})

test('duplicate IDs return the original operation before stale revision checks; changed request or action conflicts', (t) => {
  const f = fixture(t)
  f.connect()
  const original = f.enqueue({ request: { workLocation: 'office', other: { b: 2, a: 1 } } })
  f.transaction(() => {
    const duplicate = f.store.withClockOperation(f.tx, f.input({ expectedRevision: 0, expectedGeneration: 0, request: { other: { a: 1, b: 2 }, workLocation: 'office' } }), () => { assert.fail('Duplicate must not mutate clock state') })
    assert.equal(duplicate.kind, 'duplicate')
    if (duplicate.kind === 'duplicate') assert.deepEqual(duplicate.operation, original)
  })
  assert.throws(() => f.enqueue({ request: { workLocation: 'home' } }), errorCode('operation_conflict'))
  assert.throws(() => f.enqueue({ action: 'stop_work' }), errorCode('operation_conflict'))
  assert.equal(f.store.getClockRevision('employee-1'), 1)
  assert.equal(f.tx.prepare('SELECT COUNT(*) n FROM zeitguru_operations').get()!.n, 1)
})

test('clock revision and generation compare-and-swap reject stale independent requests', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  assert.throws(() => f.enqueue({ clientOperationId: 'stale-revision', expectedRevision: 0 }), errorCode('revision_conflict'))
  assert.throws(() => f.enqueue({ clientOperationId: 'stale-generation', expectedGeneration: 0 }), errorCode('connection_conflict'))
  assert.throws(() => f.connect('employee-1', 'tenant-1/provider-2', 0), errorCode('connection_conflict'))
  assert.throws(() => f.store.disconnect('employee-1', 0), errorCode('connection_conflict'))
  f.transaction(() => assert.equal(f.store.advanceClockRevision(f.tx, 'employee-1', 1), 2))
  const next = f.enqueue({ clientOperationId: 'operation-2' })
  assert.equal(next.clockRevision, 3)
  assert.equal(next.sequence, 2)
})

test('parent transaction rolls back local clock writes, revision and journal together', (t) => {
  const f = fixture(t)
  f.connect()
  assert.throws(() => f.transaction(() => {
    const result = f.store.withClockOperation(f.tx, f.input(), () => {
      f.tx.prepare('INSERT INTO local_clock VALUES(?,?)').run('local-1', 1)
      return { clockId: 'local-1' }
    })
    assert.equal(result.kind, 'committed')
    throw new Error('Synthetic parent save failure')
  }), /Synthetic parent save failure/)
  assert.equal(f.tx.prepare('SELECT COUNT(*) n FROM local_clock').get()!.n, 0)
  assert.equal(f.tx.prepare('SELECT COUNT(*) n FROM zeitguru_operations').get()!.n, 0)
  assert.equal(f.store.getClockRevision('employee-1'), 0)
  assert.equal(f.enqueue().sequence, 1)
  assert.throws(() => f.store.withClockOperation(f.tx, f.input(), () => ({})), errorCode('transaction_required'))
  const unrelated = new DatabaseSync(join(f.directory, 'other.sqlite'))
  unrelated.exec('BEGIN IMMEDIATE')
  try { assert.throws(() => f.store.withClockOperation(unrelated, f.input(), () => ({})), errorCode('wrong_database')) }
  finally { unrelated.exec('ROLLBACK'); unrelated.close() }
})

test('claims preserve per-user order, fence competing workers and only retry declared delivery failures when due', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue(); f.enqueue({ clientOperationId: 'operation-2', action: 'start_break' })
  f.connect('employee-2', 'tenant-1/provider-2')
  f.enqueue({ userId: 'employee-2', clientOperationId: 'other-operation', expectedGeneration: 1, expectedRevision: 0 })
  const first = f.store.claimNext({ userId: 'employee-1' })!
  assert.equal(f.store.saveDeliveryPlan(first, deliveryPlan()), true)
  assert.equal(first.operation.sequence, 1)
  const otherWorker = new ZeitguruStore(f.path)
  try { assert.equal(otherWorker.claimNext({ userId: 'employee-1' }), undefined) }
  finally { otherWorker.close() }
  assert.equal(f.store.claimNext({ userId: 'employee-2' })?.operation.clientOperationId, 'other-operation')
  assert.throws(() => f.store.complete(first, { status: 'retryable_failure', errorCode: 'not_delivered' } as ZeitguruCompletion), errorCode('invalid_input'))
  assert.equal(f.store.complete(first, { status: 'retryable_failure', notDelivered: true, errorCode: 'not_delivered', retryAfterMs: 5000 }), true)
  assert.equal(f.store.claimNext({ userId: 'employee-1' }), undefined)
  f.advance(5000)
  const retry = f.store.claimNext({ userId: 'employee-1' })!
  assert.deepEqual(retry.plan, deliveryPlan())
  assert.notEqual(retry.attemptToken, first.attemptToken)
  assert.equal(retry.operation.attemptCount, 2)
  assert.equal(f.store.complete(first, { status: 'confirmed', acknowledgement: { evidence: 'provider_response' } }), false)
  assert.equal(f.store.complete(retry, { status: 'confirmed', acknowledgement: { evidence: 'read_back' } }), true)
  assert.equal(f.store.claimNext({ userId: 'employee-1' })?.operation.sequence, 2)
})

test('expired lease and startup recovery retain ambiguity and never automatically replay', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue(); f.enqueue({ clientOperationId: 'operation-2' })
  const claim = f.store.claimNext({ leaseMs: 1000 })!
  f.advance(1000)
  assert.equal(f.store.claimNext(), undefined)
  assert.equal(f.store.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'provider_response' } }), false)
  assert.equal(f.store.operation('employee-1', 'operation-1')?.status, 'reconciliation_required')
  f.connect('employee-2', 'tenant-1/provider-2')
  f.enqueue({ userId: 'employee-2', clientOperationId: 'other', expectedGeneration: 1, expectedRevision: 0 })
  f.store.claimNext({ userId: 'employee-2' })
  assert.equal(f.store.recoverSending(), 1)
  assert.equal(f.store.recoverSending(), 0)
  assert.equal(f.store.claimNext(), undefined)
  assert.equal(f.store.status('employee-2').requiresAttention, true)
  assert.equal(f.store.status('employee-1').requiresAttention, true)
  assert.equal(f.store.status('employee-1').latestOperation?.clientOperationId, 'operation-2')
  assert.equal(f.store.status('employee-1').attentionOperation?.clientOperationId, 'operation-1')
})

test('the final delivery guard checks the exact attempt token, active generation and unexpired lease',t=>{
  const f=fixture(t);f.connect();f.enqueue()
  const claim=f.store.claimNext({leaseMs:1000})!
  assert.equal(f.store.isClaimCurrent(claim),true)
  assert.equal(f.store.isClaimCurrent({...claim,attemptToken:'stale-worker'}),false)
  f.advance(1000)
  assert.equal(f.store.isClaimCurrent(claim),false)
  assert.equal(f.store.operation('employee-1','operation-1')?.errorCode,'delivery_ambiguous')
  f.connect('employee-2','tenant-1/provider-2')
  f.enqueue({userId:'employee-2',clientOperationId:'other',expectedGeneration:1,expectedRevision:0})
  const disconnected=f.store.claimNext({userId:'employee-2'})!
  f.store.disconnect('employee-2',1)
  assert.equal(f.store.isClaimCurrent(disconnected),false)
})

test('disconnect wipes credentials and fences stale completion while preserving ambiguous provider reservation', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue(); f.enqueue({ clientOperationId: 'queued-later' })
  const claim = f.store.claimNext()!
  const disconnected = f.store.disconnect('employee-1', 1)
  assert.equal(disconnected.generation, 2)
  assert.equal(disconnected.enabled, false)
  assert.equal(disconnected.requiresAttention, true)
  const row = f.tx.prepare('SELECT authCipher,configCipher,providerKey FROM zeitguru_connections').get()!
  assert.equal(row.authCipher, null); assert.equal(row.configCipher, null); assert.ok(row.providerKey)
  assert.equal(f.store.operation('employee-1', 'queued-later')?.status, 'cancelled')
  assert.equal(f.store.operation('employee-1', 'operation-1')?.status, 'reconciliation_required')
  assert.throws(() => f.connect('employee-1', 'different-provider'), errorCode('reconciliation_required'))
  assert.throws(() => f.connect('employee-2', 'tenant-1/provider-1'), errorCode('provider_conflict'))
  assert.equal(f.connect().generation, 3)
  f.enqueue({ clientOperationId: 'reconnected-operation' })
  assert.equal(f.store.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'provider_response' } }), false)
  assert.equal(f.store.claimNext(), undefined)
  assert.equal(f.store.status('employee-1').requiresAttention, true)
})

test('known undelivered disconnect cancels queued work and releases the provider account; sequences remain monotonic', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  f.store.disconnect('employee-1', 1)
  assert.equal(f.store.operation('employee-1', 'operation-1')?.status, 'cancelled')
  assert.equal(f.store.status('employee-1').requiresAttention, false)
  assert.equal(f.tx.prepare('SELECT providerKey FROM zeitguru_connections').get()!.providerKey, null)
  f.connect('employee-2', 'tenant-1/provider-1')
  f.connect('employee-1', 'tenant-1/provider-3')
  const next = f.enqueue({ clientOperationId: 'next-generation' })
  assert.equal(next.generation, 3)
  assert.equal(next.sequence, 2)
  assert.equal(f.store.claimNext({ userId: 'employee-1' })?.operation.id, next.id)
})

test('journal and connections survive deletion and reinsertion of external Time user rows', (t) => {
  const f = fixture(t)
  f.tx.prepare('INSERT INTO users VALUES(?)').run('employee-1')
  f.connect(); const original = f.enqueue()
  f.transaction(() => {
    f.tx.prepare('DELETE FROM users WHERE id=?').run('employee-1')
    f.tx.prepare('INSERT INTO users VALUES(?)').run('employee-1')
  })
  for (const table of ['zeitguru_connections', 'zeitguru_clock_heads', 'zeitguru_operations']) assert.deepEqual(f.tx.prepare(`PRAGMA foreign_key_list(${table})`).all(), [])
  assert.deepEqual(f.store.operation('employee-1', 'operation-1'), original)
  assert.equal(f.store.status('employee-1').enabled, true)
  assert.equal(f.store.getClockRevision('employee-1'), 1)
})

test('provider error text cannot leak into public errors or acknowledgements', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  const claim = f.store.claimNext()!
  assert.throws(() => f.store.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'private-provider-password' } } as unknown as ZeitguruCompletion), errorCode('invalid_input'))
  assert.equal(f.store.complete(claim, { status: 'reconciliation_required', errorCode: 'private-provider-password' } as unknown as ZeitguruCompletion), true)
  assert.equal(f.store.status('employee-1').latestOperation?.errorCode, 'remote_error')
  assert.equal(JSON.stringify(f.store.status('employee-1')).includes('private-provider-password'), false)
})

test('authentication refresh is encrypted and fenced against disconnect or reconnection', (t) => {
  const f = fixture(t)
  assert.equal(f.store.readConnection('employee-1'), undefined)
  f.connect()
  assert.equal(f.store.readConnection('employee-1')?.generation, 1)
  assert.equal(f.store.rotateAuth('employee-1', 1, {token:'rotated-private-token'}), true)
  assert.deepEqual(f.store.readConnection('employee-1')?.auth, {token:'rotated-private-token'})
  f.store.disconnect('employee-1', 1)
  assert.equal(f.store.rotateAuth('employee-1', 1, {token:'stale-token'}), false)
  assert.equal(f.store.readConnection('employee-1'), undefined)
  f.connect()
  assert.equal(f.store.rotateAuth('employee-1', 1, {token:'stale-token'}), false)
  assert.equal(f.store.readConnection('employee-1')?.auth.password, 'private-provider-password')
  assert.equal(readFileSync(f.path).includes(Buffer.from('rotated-private-token')), false)
})

test('confirmation requires an immutable durable plan and atomically records an encrypted provider checkpoint', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  const claim = f.store.claimNext()!
  assert.throws(() => f.store.complete(claim, {status:'confirmed',acknowledgement:{evidence:'provider_response'}}), errorCode('delivery_plan_required'))
  assert.equal(f.store.operation('employee-1','operation-1')?.status, 'sending')
  assert.equal(f.store.lastConfirmedRow('employee-1','private-entry-id'), undefined)
  const plan = deliveryPlan()
  assert.equal(f.store.saveDeliveryPlan(claim, plan), true)
  assert.equal(f.store.saveDeliveryPlan(claim, plan), true)
  assert.throws(() => f.store.saveDeliveryPlan(claim, {...plan,desiredRow:{id:'different'}}), errorCode('delivery_plan_conflict'))
  assert.match(String(f.tx.prepare('SELECT planCipher FROM zeitguru_operations').get()!.planCipher), /^enc:v1:/)
  f.tx.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON zeitguru_row_checkpoints BEGIN SELECT RAISE(ABORT,'Synthetic checkpoint failure'); END")
  assert.throws(() => f.store.complete(claim, {status:'confirmed',acknowledgement:{evidence:'provider_response'}}), errorCode('storage_unavailable'))
  assert.equal(f.store.operation('employee-1','operation-1')?.status, 'sending')
  assert.equal(f.store.lastConfirmedRow('employee-1','private-entry-id'), undefined)
  f.tx.exec('DROP TRIGGER fail_checkpoint')
  assert.equal(f.store.complete(claim, {status:'confirmed',acknowledgement:{evidence:'provider_response'}}), true)
  assert.deepEqual(f.store.lastConfirmedRow('employee-1','private-entry-id'), plan.desiredRow)
  assert.match(String(f.tx.prepare('SELECT rowCipher FROM zeitguru_row_checkpoints').get()!.rowCipher), /^enc:v1:/)
  assert.equal(readFileSync(f.path).includes(Buffer.from('provider-clock-row')), false)
  assert.equal(JSON.stringify(f.store.status('employee-1')).includes('provider-clock-row'), false)
  f.connect('employee-1','different-provider')
  assert.equal(f.store.lastConfirmedRow('employee-1','private-entry-id'), undefined)
})

test('ambiguous delivery preserves its plan through recovery and reconnect; only exact fenced read-back confirms it', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue(); f.enqueue({clientOperationId:'later'})
  const claim = f.store.claimNext()!, plan = deliveryPlan()
  f.store.saveDeliveryPlan(claim, plan)
  f.store.recoverSending()
  const initial = f.store.readReconciliation('employee-1')!
  assert.deepEqual(initial.plan, plan)
  assert.equal(f.store.confirmReconciliation(initial, {id:'provider-clock-row'}), false)
  assert.equal(f.store.claimNext(), undefined)
  f.store.disconnect('employee-1', 1)
  assert.equal(f.store.readReconciliation('employee-1'), undefined)
  f.connect()
  assert.equal(f.store.confirmReconciliation(initial, plan.desiredRow), false)
  assert.equal(f.store.saveDeliveryPlan(claim, plan), false)
  const refreshed = f.store.readReconciliation('employee-1','operation-1')!
  assert.equal(refreshed.generation, 3)
  assert.equal(f.store.confirmReconciliation(refreshed, plan.desiredRow), true)
  assert.equal(f.store.confirmReconciliation(refreshed, plan.desiredRow), false)
  assert.deepEqual(f.store.lastConfirmedRow('employee-1','private-entry-id'), plan.desiredRow)
  assert.equal(f.store.status('employee-1').requiresAttention, false)
})

test('a known delivery failure requires attention and retains the exact plan for retry', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  const claim = f.store.claimNext()!
  f.store.saveDeliveryPlan(claim, deliveryPlan())
  f.store.complete(claim, {status:'retryable_failure',notDelivered:true,errorCode:'not_delivered'})
  assert.equal(f.store.status('employee-1').requiresAttention, true)
  const retry = f.store.claimNext()!
  assert.deepEqual(retry.plan, deliveryPlan())
  assert.equal(f.store.saveDeliveryPlan(claim, deliveryPlan()), false)
})

test('manual review refuses in-flight sends, retains history, clears checkpoints and fences old work without claiming delivery', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue()
  const confirmed = f.store.claimNext()!
  f.store.saveDeliveryPlan(confirmed, deliveryPlan())
  f.store.complete(confirmed, {status:'confirmed',acknowledgement:{evidence:'read_back'}})
  f.enqueue({clientOperationId:'unknown'}); f.enqueue({clientOperationId:'queued'})
  const claim = f.store.claimNext()!
  f.store.saveDeliveryPlan(claim, deliveryPlan())
  assert.throws(() => f.store.acknowledgeManualReview('employee-1', 1), errorCode('delivery_in_progress'))
  assert.equal(f.store.status('employee-1').generation, 1)
  f.store.complete(claim, {status:'reconciliation_required',errorCode:'delivery_ambiguous'})
  const before = f.tx.prepare("SELECT payloadCipher,planCipher FROM zeitguru_operations WHERE clientOperationId='unknown'").get()
  assert.throws(() => f.store.acknowledgeManualReview('employee-1', 0), errorCode('connection_conflict'))
  const reviewed = f.store.acknowledgeManualReview('employee-1', 1)
  assert.equal(reviewed.generation, 2)
  assert.equal(reviewed.enabled, true)
  assert.equal(reviewed.requiresAttention, false)
  assert.equal(f.store.operation('employee-1','operation-1')?.status, 'confirmed')
  assert.equal(f.store.operation('employee-1','unknown')?.status, 'cancelled')
  assert.equal(f.store.operation('employee-1','unknown')?.errorCode, 'operator_cancelled')
  assert.equal(f.store.operation('employee-1','unknown')?.acknowledgement, undefined)
  assert.deepEqual(f.tx.prepare("SELECT payloadCipher,planCipher FROM zeitguru_operations WHERE clientOperationId='unknown'").get(), before)
  assert.equal(f.store.lastConfirmedRow('employee-1','private-entry-id'), undefined)
  assert.equal(f.store.readConnection('employee-1')?.auth.password, 'private-provider-password')
  assert.equal(f.store.rotateAuth('employee-1', 1, {token:'stale'}), false)
  assert.equal(f.store.complete(claim, {status:'confirmed',acknowledgement:{evidence:'read_back'}}), false)
  assert.equal(f.store.canReauthenticate('employee-1','tenant-1/provider-1'), true)
  const next = f.enqueue({clientOperationId:'after-review'})
  assert.equal(next.sequence, 4)
  assert.equal(f.store.claimNext()?.operation.id, next.id)
})

test('manual review releases a disconnected ambiguous provider reservation after explicit review', (t) => {
  const f = fixture(t)
  f.connect(); f.enqueue(); f.store.claimNext()
  f.store.disconnect('employee-1', 1)
  assert.equal(f.store.canReauthenticate('employee-1','tenant-1/provider-1'), true)
  assert.equal(f.store.canReauthenticate('employee-1','different-provider'), false)
  assert.equal(f.store.canReauthenticate('employee-2','tenant-1/provider-1'), false)
  const reviewed = f.store.acknowledgeManualReview('employee-1', 2)
  assert.equal(reviewed.generation, 3)
  assert.equal(reviewed.enabled, false)
  assert.equal(f.store.canReauthenticate('employee-1','tenant-1/provider-1'), false)
  assert.equal(f.store.readConnection('employee-1'), undefined)
  assert.equal(f.connect('employee-2','tenant-1/provider-1').enabled, true)
})

test('actual Time persistence rolls back with the journal and duplicate requests do not advance its snapshot baseline', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-zeitguru-time-atomic-'))
  t.after(() => rmSync(directory, {recursive:true,force:true}))
  const script = `
    import assert from 'node:assert/strict';
    const {readDatabase,writeDatabase,writeDatabaseAtomically,addAudit} = await import(${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)});
    const {ZeitguruStore} = await import(${JSON.stringify(new URL('../server/zeitguruStore.ts', import.meta.url).href)});
    const database = readDatabase(), userId = database.users[0].id;
    const journal = new ZeitguruStore(process.env.TIME_TRACKER_DATA);
    journal.connect({userId,providerKey:'synthetic-provider',auth:{token:'synthetic-token'},expectedGeneration:0});
    const input = {userId,clientOperationId:'request-1',expectedRevision:0,expectedGeneration:1,action:'start_work',request:{workLocation:'office'}};
    addAudit(database,userId,'atomic-first','clock','test');
    assert.throws(() => writeDatabaseAtomically(database,(tx,persist) => {
      journal.withClockOperation(tx,input,()=>{persist();return {entryId:'synthetic-entry'};});
      throw new Error('Synthetic failure after both writes');
    }),/Synthetic failure/);
    assert.equal(readDatabase().audit.some(x=>x.action==='atomic-first'),false);
    assert.equal(journal.getClockRevision(userId),0);
    assert.equal(journal.operation(userId,'request-1'),undefined);
    const committed = writeDatabaseAtomically(database,(tx,persist)=>journal.withClockOperation(tx,input,()=>{persist();return {entryId:'synthetic-entry'};}));
    assert.equal(committed.kind,'committed');
    assert.equal(readDatabase().audit.some(x=>x.action==='atomic-first'),true);
    addAudit(database,userId,'deferred-after-duplicate','clock','test');
    let persisted = false;
    const duplicate = writeDatabaseAtomically(database,(tx,persist)=>journal.withClockOperation(tx,input,()=>{persisted=true;persist();return {};}));
    assert.equal(duplicate.kind,'duplicate');assert.equal(persisted,false);
    assert.equal(readDatabase().audit.some(x=>x.action==='deferred-after-duplicate'),false);
    writeDatabase(database);
    assert.equal(readDatabase().audit.some(x=>x.action==='deferred-after-duplicate'),true);
    assert.equal(journal.getClockRevision(userId),1);
    journal.close();
  `
  const child = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',script], {
    cwd:new URL('..',import.meta.url), encoding:'utf8', env:{...process.env,
      TIME_TRACKER_DATA:join(directory,'time.sqlite'),TIME_TRACKER_BACKUP_DIR:join(directory,'backups'),
      INITIAL_ADMIN_NAME:'Synthetic Admin',INITIAL_ADMIN_EMAIL:'synthetic@example.invalid',INITIAL_ADMIN_PASSWORD:'K9!vMq7#rT4$zLp2',
      INITIAL_ADMIN_MUST_CHANGE_PASSWORD:'false',DCO_CORE_URL:'',DCO_TIMEZONE:'Europe/Berlin',
      REQUIRE_DATA_ENCRYPTION:'true',DATA_ENCRYPTION_KEY:'zeitguru-synthetic-encryption-key-for-unit-tests'},
  })
  assert.equal(child.status,0,child.stderr || child.stdout)
})
