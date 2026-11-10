import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataEncryptionEnabled, decryptText, encryptText, isEncryptedText } from './fieldCrypto.ts'

export type ZeitguruJson = null | boolean | number | string | ZeitguruJson[] | { [key: string]: ZeitguruJson }
export type ZeitguruJsonRecord = { [key: string]: ZeitguruJson }
export type ZeitguruClockAction = 'start_work' | 'start_break' | 'stop_break' | 'stop_work'
export const zeitguruOperationStatuses = ['queued', 'sending', 'confirmed', 'retryable_failure', 'reconciliation_required', 'authentication_required', 'cancelled'] as const
export type ZeitguruOperationStatus = typeof zeitguruOperationStatuses[number]
const actions: ZeitguruClockAction[] = ['start_work', 'start_break', 'stop_break', 'stop_work']
const errorCodes = ['remote_error', 'delivery_ambiguous', 'authentication_required', 'credentials_unavailable', 'payload_unavailable', 'remote_conflict', 'preflight_unavailable', 'rate_limited', 'not_delivered', 'connection_changed', 'disconnected', 'operator_cancelled'] as const
export type ZeitguruErrorCode = typeof errorCodes[number]
export type ZeitguruEvidence = 'provider_response' | 'read_back' | 'operator_verified'
const evidenceKinds: ZeitguruEvidence[] = ['provider_response', 'read_back', 'operator_verified']

export class ZeitguruStoreError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, status: number, message: string) { super(message); this.name = 'ZeitguruStoreError'; this.code = code; this.status = status }
}
const invalid = () => new ZeitguruStoreError('invalid_input', 400, 'Invalid Zeitguru journal input.')
const conflict = (code = 'revision_conflict') => new ZeitguruStoreError(code, 409, 'The Zeitguru operation or connection changed. Reload before continuing.')
const unavailable = () => new ZeitguruStoreError('storage_unavailable', 503, 'Zeitguru storage is unavailable.')
const encryptionUnavailable = () => new ZeitguruStoreError('encryption_unavailable', 503, 'Zeitguru requires configured, readable encryption.')
function identifier(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw invalid(); return value }
function integer(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid(); return Number(value) }
function safeErrorCode(value: unknown): ZeitguruErrorCode { return errorCodes.includes(value as ZeitguruErrorCode) ? value as ZeitguruErrorCode : 'remote_error' }
function canonicalJson(input: ZeitguruJsonRecord) {
  const seen = new Set<object>()
  function visit(value: unknown, depth: number): ZeitguruJson {
    if (depth > 25) throw invalid()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return value }
    if (typeof value !== 'object' || seen.has(value)) throw invalid()
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1))
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid()
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, visit((value as Record<string, unknown>)[key], depth + 1)]))
    } finally { seen.delete(value) }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  const json = JSON.stringify(visit(input, 0))
  if (Buffer.byteLength(json) > 512 * 1024) throw invalid()
  return json
}
function encryptedJson(input: ZeitguruJsonRecord) {
  const json = canonicalJson(input)
  try {
    if (!dataEncryptionEnabled()) throw encryptionUnavailable()
    const encrypted = encryptText(json)
    if (!isEncryptedText(encrypted)) throw encryptionUnavailable()
    return encrypted!
  } catch { throw encryptionUnavailable() }
}
function decryptedJson(input: string | null): ZeitguruJsonRecord {
  try {
    // fieldCrypto deliberately tolerates legacy plaintext; this credential boundary must not.
    if (!input || !isEncryptedText(input) || !dataEncryptionEnabled()) throw encryptionUnavailable()
    const value = JSON.parse(decryptText(input)!) as ZeitguruJsonRecord
    canonicalJson(value)
    return value
  } catch { throw encryptionUnavailable() }
}
function databasePath(path: string) { const result = realpathSync(resolve(path)); return process.platform === 'win32' ? result.toLowerCase() : result }

interface ConnectionRow { userId: string; providerKey: string | null; generation: number; enabled: number; authCipher: string | null; configCipher: string | null; updatedAt: number }
interface OperationRow {
  id: string; userId: string; clientOperationId: string; generation: number; sequence: number; clockRevision: number;
  action: ZeitguruClockAction; requestFingerprint: string; payloadCipher: string; planCipher: string | null; status: ZeitguruOperationStatus;
  attemptCount: number; attemptToken: string | null; leaseExpiresAt: number | null; nextAttemptAt: number;
  errorCode: string | null; acknowledgement: string | null; createdAt: number; updatedAt: number;
}
export interface ZeitguruOperation {
  id: string; userId: string; clientOperationId: string; generation: number; sequence: number; clockRevision: number;
  action: ZeitguruClockAction; status: ZeitguruOperationStatus; attemptCount: number;
  createdAt: number; updatedAt: number; nextAttemptAt: number; leaseExpiresAt: number | null;
  errorCode?: ZeitguruErrorCode; acknowledgement?: { evidence: ZeitguruEvidence; confirmedAt: number };
}
export interface ZeitguruConnectionStatus {
  enabled: boolean; generation: number; clockRevision: number; requiresAttention: boolean;
  counts: Record<ZeitguruOperationStatus, number>; latestOperation?: ZeitguruOperation; attentionOperation?: ZeitguruOperation;
}
export interface ZeitguruClockInput {
  userId: string; clientOperationId: string; expectedRevision: number; expectedGeneration: number;
  action: ZeitguruClockAction; request: ZeitguruJsonRecord;
}
interface ZeitguruPreparedClock {
  readonly kind: 'ready'; readonly operationId: string; readonly userId: string;
  readonly generation: number; readonly sequence: number; readonly clockRevision: number;
}
type ZeitguruClockPreparation = ZeitguruPreparedClock | { kind: 'duplicate'; operation: ZeitguruOperation }
export type ZeitguruClockCommit = { kind: 'committed' | 'duplicate'; operation: ZeitguruOperation }
interface PreparationDetails { tx: DatabaseSync; input: ZeitguruClockInput; fingerprint: string; sequence: number }
/** Server-only. Never serialize this object to browser/API state or logs. */
export interface ZeitguruDeliveryClaim {
  operation: ZeitguruOperation; attemptToken: string;
  payload: ZeitguruJsonRecord; auth: ZeitguruJsonRecord; config: ZeitguruJsonRecord;
  plan?: ZeitguruDeliveryPlan;
}
export type ZeitguruDeliveryPlan = ZeitguruJsonRecord & {
  localEntryId: string; expectedRow: ZeitguruJsonRecord | null;
  desiredRow: ZeitguruJsonRecord; patch: ZeitguruJsonRecord;
}
/** Server-only credentials and read-back material. Never return through an API. */
export interface ZeitguruReconciliation {
  operation: ZeitguruOperation; generation: number;
  payload: ZeitguruJsonRecord; auth: ZeitguruJsonRecord; config: ZeitguruJsonRecord;
  plan: ZeitguruDeliveryPlan;
}
export interface ZeitguruUnsentClock { id: string; payload: ZeitguruJsonRecord; generation: number; status: ZeitguruOperationStatus; errorCode: string | null }
export type ZeitguruCompletion =
  | { status: 'confirmed'; acknowledgement: { evidence: ZeitguruEvidence } }
  | { status: 'retryable_failure' | 'authentication_required'; notDelivered: true; errorCode?: ZeitguruErrorCode; retryAfterMs?: number }
  | { status: 'reconciliation_required'; errorCode?: ZeitguruErrorCode }

function publicOperation(row: OperationRow): ZeitguruOperation {
  let acknowledgement: ZeitguruOperation['acknowledgement']
  if (row.acknowledgement) {
    try {
      const value = JSON.parse(row.acknowledgement) as { evidence: ZeitguruEvidence; confirmedAt: number }
      if (evidenceKinds.includes(value.evidence) && Number.isSafeInteger(value.confirmedAt)) acknowledgement = { evidence: value.evidence, confirmedAt: value.confirmedAt }
    } catch { /* Invalid provider metadata is never returned verbatim. */ }
  }
  return {
    id: row.id, userId: row.userId, clientOperationId: row.clientOperationId, generation: row.generation,
    sequence: row.sequence, clockRevision: row.clockRevision, action: row.action, status: row.status,
    attemptCount: row.attemptCount, createdAt: row.createdAt, updatedAt: row.updatedAt,
    nextAttemptAt: row.nextAttemptAt, leaseExpiresAt: row.leaseExpiresAt,
    ...(row.errorCode ? { errorCode: safeErrorCode(row.errorCode) } : {}), ...(acknowledgement ? { acknowledgement } : {}),
  }
}

export class ZeitguruStore {
  private readonly sql: DatabaseSync
  private readonly path: string
  private readonly now: () => number
  private readonly preparations = new WeakMap<ZeitguruPreparedClock, PreparationDetails>()

  /** Initialize once per Time process. Call recoverSending() once before starting its delivery worker. */
  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    try {
      this.sql = new DatabaseSync(resolve(path))
      this.path = databasePath(path)
      this.sql.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS zeitguru_connections (
          userId TEXT PRIMARY KEY, providerKey TEXT UNIQUE, generation INTEGER NOT NULL, enabled INTEGER NOT NULL,
          authCipher TEXT, configCipher TEXT, updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS zeitguru_clock_heads (
          userId TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, nextSequence INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS zeitguru_operations (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, clientOperationId TEXT NOT NULL, generation INTEGER NOT NULL,
          sequence INTEGER NOT NULL, clockRevision INTEGER NOT NULL, action TEXT NOT NULL,
          requestFingerprint TEXT NOT NULL, payloadCipher TEXT NOT NULL, planCipher TEXT, status TEXT NOT NULL,
          attemptCount INTEGER NOT NULL DEFAULT 0, attemptToken TEXT, leaseExpiresAt INTEGER,
          nextAttemptAt INTEGER NOT NULL DEFAULT 0, errorCode TEXT, acknowledgement TEXT,
          createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
          UNIQUE(userId,clientOperationId), UNIQUE(userId,sequence)
        );
        CREATE INDEX IF NOT EXISTS zeitguru_operations_delivery ON zeitguru_operations(status,nextAttemptAt,userId,sequence);
        CREATE TABLE IF NOT EXISTS zeitguru_row_checkpoints (
          userId TEXT NOT NULL, localEntryId TEXT NOT NULL, providerKey TEXT NOT NULL,
          rowCipher TEXT NOT NULL, sequence INTEGER NOT NULL, confirmedAt INTEGER NOT NULL,
          PRIMARY KEY(userId,localEntryId,providerKey)
        );
      `)
      if (!this.sql.prepare('PRAGMA table_info(zeitguru_operations)').all().some((row) => row.name === 'planCipher')) this.sql.exec('ALTER TABLE zeitguru_operations ADD COLUMN planCipher TEXT')
    } catch { throw unavailable() }
  }
  close() { this.sql.close() }
  private transaction<T>(callback: () => T): T {
    try {
      this.sql.exec('BEGIN IMMEDIATE')
      try { const result = callback(); this.sql.exec('COMMIT'); return result }
      catch (error) { this.sql.exec('ROLLBACK'); throw error }
    } catch (error) { if (error instanceof ZeitguruStoreError) throw error; throw unavailable() }
  }
  private assertTransaction(tx: DatabaseSync) {
    if (!tx.isTransaction) throw new ZeitguruStoreError('transaction_required', 500, 'An active SQLite clock transaction is required.')
    const main = tx.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')
    if (!main?.file || databasePath(String(main.file)) !== this.path) throw new ZeitguruStoreError('wrong_database', 500, 'The clock journal must use the same SQLite database.')
  }
  private connection(userId: string, sql = this.sql) { return sql.prepare('SELECT * FROM zeitguru_connections WHERE userId=?').get(userId) as unknown as ConnectionRow | undefined }
  private head(userId: string, sql = this.sql) { return sql.prepare('SELECT revision,nextSequence FROM zeitguru_clock_heads WHERE userId=?').get(userId) as { revision: number; nextSequence: number } | undefined ?? { revision: 0, nextSequence: 1 } }
  private cancelUndelivered(userId: string, code: 'disconnected' | 'connection_changed', sql = this.sql) {
    // Disconnect fences the local worker; it cannot undo a request already accepted remotely.
    sql.prepare("UPDATE zeitguru_operations SET status='reconciliation_required',errorCode='delivery_ambiguous',attemptToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE userId=? AND status='sending'").run(this.now(),userId)
    sql.prepare("UPDATE zeitguru_operations SET status='cancelled',errorCode=?,attemptToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE userId=? AND status IN ('queued','retryable_failure','authentication_required')").run(code,this.now(),userId)
  }
  private hasAmbiguousDelivery(userId: string, sql = this.sql) {
    return Boolean(sql.prepare("SELECT 1 FROM zeitguru_operations WHERE userId=? AND status IN ('sending','reconciliation_required') LIMIT 1").get(userId))
  }
  /** Server-only. The caller must authenticate the user before accessing credentials. */
  readConnection(userId: string) {
    const row = this.connection(identifier(userId))
    if (!row?.enabled) return undefined
    return { generation:row.generation, auth:decryptedJson(row.authCipher), config:decryptedJson(row.configCipher) }
  }
  rotateAuth(userId: string, generation: number, auth: ZeitguruJsonRecord): boolean {
    identifier(userId); integer(generation)
    const cipher = encryptedJson(auth)
    return this.transaction(() => Number(this.sql.prepare('UPDATE zeitguru_connections SET authCipher=?,updatedAt=? WHERE userId=? AND generation=? AND enabled=1').run(cipher,this.now(),userId,generation).changes) === 1)
  }
  canReauthenticate(userId: string, providerKey: string): boolean {
    const row = this.connection(identifier(userId))
    const key = createHash('sha256').update(identifier(providerKey)).digest('hex')
    return Boolean(row?.providerKey && row.providerKey === key)
  }
  /**
   * Caller MUST authenticate this user, obtain explicit reviewed:true acknowledgement,
   * and freshly verify both local and provider clocks are stopped. This only records
   * manual review; it never claims provider delivery or fixes payroll/stock/time rows.
   * Keep the immutable journal history, discard its checkpoints, and fence old work.
   */
  acknowledgeManualReview(userId: string, expectedGeneration: number): ZeitguruConnectionStatus {
    identifier(userId); integer(expectedGeneration)
    this.transaction(() => {
      const connection = this.connection(userId)
      if (!connection || connection.generation !== expectedGeneration) throw conflict('connection_conflict')
      if (this.sql.prepare("SELECT 1 FROM zeitguru_operations WHERE userId=? AND status='sending' LIMIT 1").get(userId)) throw conflict('delivery_in_progress')
      const timestamp = this.now()
      this.sql.prepare("UPDATE zeitguru_operations SET status='cancelled',errorCode='operator_cancelled',attemptToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE userId=? AND status IN ('queued','retryable_failure','authentication_required','reconciliation_required')").run(timestamp,userId)
      this.sql.prepare('DELETE FROM zeitguru_row_checkpoints WHERE userId=?').run(userId)
      this.sql.prepare('UPDATE zeitguru_connections SET generation=generation+1,providerKey=CASE WHEN enabled=1 THEN providerKey ELSE NULL END,updatedAt=? WHERE userId=?').run(timestamp,userId)
    })
    return this.status(userId)
  }
  connect(input: { userId: string; providerKey: string; auth: ZeitguruJsonRecord; config?: ZeitguruJsonRecord; expectedGeneration: number }, tx?: DatabaseSync) {
    const userId = identifier(input.userId), providerKey = createHash('sha256').update(identifier(input.providerKey)).digest('hex')
    const authCipher = encryptedJson(input.auth), configCipher = encryptedJson(input.config ?? {})
    const sql = tx ?? this.sql
    const apply = () => {
      const previous = this.connection(userId, sql)
      if (integer(input.expectedGeneration) !== (previous?.generation ?? 0)) throw conflict('connection_conflict')
      if (previous?.providerKey !== providerKey && this.hasAmbiguousDelivery(userId, sql)) throw conflict('reconciliation_required')
      const owner = sql.prepare('SELECT userId FROM zeitguru_connections WHERE providerKey=? AND userId<>?').get(providerKey,userId)
      if (owner) throw new ZeitguruStoreError('provider_conflict',409,'This Zeitguru account is already connected.')
      this.cancelUndelivered(userId,'connection_changed', sql)
      sql.prepare(`INSERT INTO zeitguru_connections(userId,providerKey,generation,enabled,authCipher,configCipher,updatedAt) VALUES(?,?,?,1,?,?,?)
        ON CONFLICT(userId) DO UPDATE SET providerKey=excluded.providerKey,generation=excluded.generation,enabled=1,authCipher=excluded.authCipher,configCipher=excluded.configCipher,updatedAt=excluded.updatedAt`)
        .run(userId,providerKey,(previous?.generation ?? 0)+1,authCipher,configCipher,this.now())
    }
    if (tx) { this.assertTransaction(tx); apply() } else this.transaction(apply)
    return tx ? undefined : this.status(userId)
  }
  disconnect(userIdInput: string, expectedGeneration: number) {
    const userId = identifier(userIdInput)
    this.transaction(() => {
      const previous = this.connection(userId)
      if (integer(expectedGeneration) !== (previous?.generation ?? 0)) throw conflict('connection_conflict')
      this.cancelUndelivered(userId,'disconnected')
      // Keep the provider reservation until uncertain old deliveries have been reconciled.
      const providerKey = this.hasAmbiguousDelivery(userId) ? previous?.providerKey ?? null : null
      this.sql.prepare(`INSERT INTO zeitguru_connections(userId,providerKey,generation,enabled,authCipher,configCipher,updatedAt) VALUES(?,?,?,0,NULL,NULL,?)
        ON CONFLICT(userId) DO UPDATE SET providerKey=excluded.providerKey,generation=excluded.generation,enabled=0,authCipher=NULL,configCipher=NULL,updatedAt=excluded.updatedAt`)
        .run(userId,providerKey,(previous?.generation ?? 0)+1,this.now())
    })
    return this.status(userId)
  }
  getClockRevision(userId: string, tx?: DatabaseSync) { if (tx) this.assertTransaction(tx); return this.head(identifier(userId),tx).revision }
  status(userIdInput: string): ZeitguruConnectionStatus {
    const userId = identifier(userIdInput), connection = this.connection(userId)
    const counts = Object.fromEntries(zeitguruOperationStatuses.map((status) => [status,0])) as Record<ZeitguruOperationStatus,number>
    for (const row of this.sql.prepare('SELECT status,COUNT(*) n FROM zeitguru_operations WHERE userId=? GROUP BY status').all(userId)) if (zeitguruOperationStatuses.includes(row.status as ZeitguruOperationStatus)) counts[row.status as ZeitguruOperationStatus] = Number(row.n)
    const latest = this.sql.prepare('SELECT * FROM zeitguru_operations WHERE userId=? ORDER BY sequence DESC LIMIT 1').get(userId) as unknown as OperationRow | undefined
    const attention = this.sql.prepare("SELECT * FROM zeitguru_operations WHERE userId=? AND status IN ('reconciliation_required','authentication_required','retryable_failure') ORDER BY sequence LIMIT 1").get(userId) as unknown as OperationRow | undefined
    return { enabled: Boolean(connection?.enabled && isEncryptedText(connection.authCipher)), generation: connection?.generation ?? 0, clockRevision: this.head(userId).revision, requiresAttention: counts.reconciliation_required+counts.authentication_required+counts.retryable_failure > 0, counts, ...(latest ? { latestOperation: publicOperation(latest) } : {}), ...(attention ? { attentionOperation: publicOperation(attention) } : {}) }
  }
  operation(userId: string, clientOperationId: string) {
    const row = this.sql.prepare('SELECT * FROM zeitguru_operations WHERE userId=? AND clientOperationId=?').get(identifier(userId),identifier(clientOperationId)) as unknown as OperationRow | undefined
    return row ? publicOperation(row) : undefined
  }
  /**
   * Caller owns BEGIN IMMEDIATE/COMMIT/ROLLBACK and MUST roll back on any error.
   * writeLocal runs synchronously only for a new request and returns its immutable delivery payload.
   * It must use tx, perform no network work, and must not commit/roll back or open another transaction.
   * A duplicate skips writeLocal entirely. No prepared token escapes its transaction lifetime.
   */
  withClockOperation(tx: DatabaseSync, input: ZeitguruClockInput, writeLocal: (operationId: string) => ZeitguruJsonRecord): ZeitguruClockCommit {
    const prepared = this.#prepareClockOperation(tx,input)
    if (prepared.kind === 'duplicate') return prepared
    try {
      const payload = writeLocal(prepared.operationId)
      return { kind:'committed',operation:this.#commitClockOperation(tx,prepared,payload) }
    } finally { this.preparations.delete(prepared) }
  }
  #prepareClockOperation(tx: DatabaseSync, input: ZeitguruClockInput): ZeitguruClockPreparation {
    this.assertTransaction(tx)
    identifier(input.userId); identifier(input.clientOperationId); integer(input.expectedRevision); integer(input.expectedGeneration)
    if (!actions.includes(input.action)) throw invalid()
    const fingerprint = createHash('sha256').update(canonicalJson({action:input.action,request:input.request})).digest('hex')
    const duplicate = tx.prepare('SELECT * FROM zeitguru_operations WHERE userId=? AND clientOperationId=?').get(input.userId,input.clientOperationId) as unknown as OperationRow | undefined
    if (duplicate) { if (duplicate.requestFingerprint !== fingerprint) throw conflict('operation_conflict'); return { kind:'duplicate',operation:publicOperation(duplicate) } }
    const connection = this.connection(input.userId,tx), head = this.head(input.userId,tx)
    if (!connection?.enabled || !connection.authCipher) throw new ZeitguruStoreError('not_connected',409,'Connect Zeitguru before mirroring clock actions.')
    if (connection.generation !== input.expectedGeneration) throw conflict('connection_conflict')
    if (head.revision !== input.expectedRevision) throw conflict()
    const ready: ZeitguruPreparedClock = Object.freeze({kind:'ready',operationId:randomUUID(),userId:input.userId,generation:connection.generation,sequence:head.nextSequence,clockRevision:head.revision+1})
    this.preparations.set(ready,{tx,input:structuredClone(input),fingerprint,sequence:head.nextSequence})
    return ready
  }
  #commitClockOperation(tx: DatabaseSync, ready: ZeitguruPreparedClock, payload: ZeitguruJsonRecord): ZeitguruOperation {
    this.assertTransaction(tx)
    const prepared = this.preparations.get(ready)
    if (!prepared || prepared.tx !== tx) throw conflict('operation_conflict')
    const { input, fingerprint } = prepared, cipher = encryptedJson(payload), timestamp = this.now()
    const connection = this.connection(input.userId,tx)
    if (!connection?.enabled || connection.generation !== input.expectedGeneration) throw conflict('connection_conflict')
    if (tx.prepare('SELECT 1 FROM zeitguru_operations WHERE userId=? AND clientOperationId=?').get(input.userId,input.clientOperationId)) throw conflict('operation_conflict')
    tx.prepare('INSERT OR IGNORE INTO zeitguru_clock_heads(userId,revision,nextSequence) VALUES(?,0,1)').run(input.userId)
    const changed = tx.prepare('UPDATE zeitguru_clock_heads SET revision=revision+1,nextSequence=nextSequence+1 WHERE userId=? AND revision=? AND nextSequence=?').run(input.userId,input.expectedRevision,prepared.sequence)
    if (Number(changed.changes) !== 1) throw conflict()
    tx.prepare(`INSERT INTO zeitguru_operations(id,userId,clientOperationId,generation,sequence,clockRevision,action,requestFingerprint,payloadCipher,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`)
      .run(ready.operationId,input.userId,input.clientOperationId,input.expectedGeneration,prepared.sequence,ready.clockRevision,input.action,fingerprint,cipher,timestamp,timestamp)
    this.preparations.delete(ready)
    return publicOperation(tx.prepare('SELECT * FROM zeitguru_operations WHERE id=?').get(ready.operationId) as unknown as OperationRow)
  }
  /** Optional local-only transition CAS; does not enqueue any provider operation. */
  advanceClockRevision(tx: DatabaseSync, userId: string, expectedRevision: number) {
    this.assertTransaction(tx); identifier(userId); integer(expectedRevision)
    tx.prepare('INSERT OR IGNORE INTO zeitguru_clock_heads(userId,revision,nextSequence) VALUES(?,0,1)').run(userId)
    if (Number(tx.prepare('UPDATE zeitguru_clock_heads SET revision=revision+1 WHERE userId=? AND revision=?').run(userId,expectedRevision).changes) !== 1) throw conflict()
    return expectedRevision+1
  }
  private expireLeases(timestamp: number) {
    return Number(this.sql.prepare("UPDATE zeitguru_operations SET status='reconciliation_required',errorCode='delivery_ambiguous',attemptToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE status='sending' AND leaseExpiresAt<=?").run(timestamp,timestamp).changes)
  }
  /** Invoke once on exclusive worker startup. Never changes an ambiguous send back to queued. */
  recoverSending(options: { includeQueued?: boolean } = {}) {
    return this.transaction(() => Number(this.sql.prepare("UPDATE zeitguru_operations SET status='reconciliation_required',errorCode='delivery_ambiguous',attemptToken=NULL,leaseExpiresAt=NULL,updatedAt=? WHERE status='sending' OR (?=1 AND status IN ('queued','retryable_failure'))").run(this.now(), options.includeQueued ? 1 : 0).changes))
  }
  claimNext(options: { userId?: string; leaseMs?: number } = {}): ZeitguruDeliveryClaim | undefined {
    if (options.userId !== undefined) identifier(options.userId)
    const leaseMs = options.leaseMs ?? 30_000
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw invalid()
    return this.transaction(() => {
      const timestamp = this.now(); this.expireLeases(timestamp)
      const row = this.sql.prepare(`SELECT o.* FROM zeitguru_operations o JOIN zeitguru_connections c ON c.userId=o.userId AND c.enabled=1 AND c.generation=o.generation
        WHERE o.status IN ('queued','retryable_failure') AND o.nextAttemptAt<=? AND (? IS NULL OR o.userId=?)
        AND NOT EXISTS(SELECT 1 FROM zeitguru_operations earlier WHERE earlier.userId=o.userId AND earlier.sequence<o.sequence AND earlier.status NOT IN ('confirmed','cancelled'))
        ORDER BY o.createdAt,o.userId,o.sequence LIMIT 1`).get(timestamp,options.userId ?? null,options.userId ?? null) as unknown as OperationRow | undefined
      if (!row) return undefined
      const connection = this.connection(row.userId)!
      let auth: ZeitguruJsonRecord, config: ZeitguruJsonRecord, payload: ZeitguruJsonRecord, plan: ZeitguruDeliveryPlan | undefined
      try { auth = decryptedJson(connection.authCipher); config = decryptedJson(connection.configCipher) }
      catch { this.sql.prepare("UPDATE zeitguru_operations SET status='authentication_required',errorCode='credentials_unavailable',updatedAt=? WHERE id=?").run(timestamp,row.id); return undefined }
      try { payload = decryptedJson(row.payloadCipher); if (row.planCipher) plan = this.deliveryPlan(decryptedJson(row.planCipher)) }
      catch { this.sql.prepare("UPDATE zeitguru_operations SET status='reconciliation_required',errorCode='payload_unavailable',updatedAt=? WHERE id=?").run(timestamp,row.id); return undefined }
      const attemptToken = randomUUID()
      this.sql.prepare("UPDATE zeitguru_operations SET status='sending',attemptCount=attemptCount+1,attemptToken=?,leaseExpiresAt=?,errorCode=NULL,updatedAt=? WHERE id=?").run(attemptToken,timestamp+leaseMs,timestamp,row.id)
      return { operation:publicOperation(this.sql.prepare('SELECT * FROM zeitguru_operations WHERE id=?').get(row.id) as unknown as OperationRow),attemptToken,payload,auth,config,...(plan ? {plan} : {}) }
    })
  }
  private deliveryPlan(value: ZeitguruJsonRecord): ZeitguruDeliveryPlan {
    identifier(value.localEntryId)
    if (value.expectedRow !== null) canonicalJson(value.expectedRow as ZeitguruJsonRecord)
    canonicalJson(value.desiredRow as ZeitguruJsonRecord); canonicalJson(value.patch as ZeitguruJsonRecord)
    canonicalJson(value)
    return value as ZeitguruDeliveryPlan
  }
  private activeClaim(claim: Pick<ZeitguruDeliveryClaim,'operation'|'attemptToken'>) {
    const row = this.sql.prepare('SELECT * FROM zeitguru_operations WHERE id=?').get(claim.operation.id) as unknown as OperationRow | undefined
    const connection = row ? this.connection(row.userId) : undefined
    return row && row.status === 'sending' && row.attemptToken === claim.attemptToken && row.userId === claim.operation.userId && row.generation === claim.operation.generation && connection?.enabled && connection.generation === row.generation ? row : undefined
  }
  /** Recheck the exclusive lease and connection immediately before a provider write. */
  isClaimCurrent(claim: Pick<ZeitguruDeliveryClaim,'operation'|'attemptToken'>): boolean {
    if (!claim?.operation || !claim.attemptToken) throw invalid()
    return this.transaction(() => {
      this.expireLeases(this.now())
      return Boolean(this.activeClaim(claim))
    })
  }
  /** Save before any provider write. A plan is immutable across retries and unknown outcomes. */
  saveDeliveryPlan(claim: Pick<ZeitguruDeliveryClaim,'operation'|'attemptToken'>, input: ZeitguruDeliveryPlan): boolean {
    if (!claim?.operation || !claim.attemptToken) throw invalid()
    const plan = this.deliveryPlan(input), serialized = canonicalJson(plan), cipher = encryptedJson(plan)
    return this.transaction(() => {
      this.expireLeases(this.now())
      const row = this.activeClaim(claim)
      if (!row) return false
      if (row.planCipher) {
        if (canonicalJson(decryptedJson(row.planCipher)) !== serialized) throw conflict('delivery_plan_conflict')
        return true
      }
      this.sql.prepare('UPDATE zeitguru_operations SET planCipher=?,updatedAt=? WHERE id=?').run(cipher,this.now(),row.id)
      return true
    })
  }
  lastConfirmedRow(userId: string, localEntryId: string): ZeitguruJsonRecord | undefined {
    const connection = this.connection(identifier(userId))
    identifier(localEntryId)
    if (!connection?.providerKey) return undefined
    const row = this.sql.prepare('SELECT rowCipher FROM zeitguru_row_checkpoints WHERE userId=? AND localEntryId=? AND providerKey=?').get(userId,localEntryId,connection.providerKey)
    return row ? decryptedJson(String(row.rowCipher)) : undefined
  }
  observedRows(userId: string) {
    const connection = this.connection(identifier(userId))
    if (!connection?.providerKey) return []
    return this.sql.prepare('SELECT localEntryId,rowCipher FROM zeitguru_row_checkpoints WHERE userId=? AND providerKey=?').all(userId, connection.providerKey)
      .map(row => ({ localEntryId: String(row.localEntryId), row: decryptedJson(String(row.rowCipher)) }))
  }
  /** Progress is fenced after a successful merge; a failed/crashed merge retries. */
  markSynchronized(userId: string, generation: number, revision: number, throughDate: string) {
    const parsedDate = new Date(`${throughDate}T12:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== throughDate) throw invalid()
    this.transaction(() => {
      const connection = this.connection(identifier(userId))
      if (!connection?.enabled || connection.generation !== generation || this.head(userId).revision !== revision || this.hasAmbiguousDelivery(userId)) throw conflict('connection_conflict')
      const config = decryptedJson(connection.configCipher)
      if (typeof config.liveSyncThroughDate === 'string' && config.liveSyncThroughDate > throughDate) throw conflict('revision_conflict')
      this.sql.prepare('UPDATE zeitguru_connections SET configCipher=?,updatedAt=? WHERE userId=? AND generation=?')
        .run(encryptedJson({ ...config, liveSyncThroughDate: throughDate }), this.now(), userId, generation)
    })
  }
  unsentConflict(userId: string): ZeitguruUnsentClock[] | undefined {
    const rows = this.sql.prepare("SELECT * FROM zeitguru_operations WHERE userId=? AND status NOT IN ('confirmed','cancelled') ORDER BY sequence").all(identifier(userId)) as unknown as OperationRow[]
    // A persisted plan is mandatory before EVERY provider write. Its absence proves no write began.
    if (!rows.length || rows[0].errorCode !== 'remote_conflict' || rows.some(row => row.planCipher || !['queued','reconciliation_required'].includes(row.status))) return undefined
    return rows.map(row => ({ id: row.id, payload: decryptedJson(row.payloadCipher), generation: row.generation, status: row.status, errorCode: row.errorCode }))
  }
  stageRebasedPlans(tx: DatabaseSync, userId: string, generation: number, revision: number, unsent: ZeitguruUnsentClock[], plans: ZeitguruDeliveryPlan[]) {
    this.assertTransaction(tx)
    const connection = this.connection(userId, tx)
    if (!connection?.enabled || connection.generation !== generation || this.head(userId, tx).revision !== revision || unsent.length !== plans.length) throw conflict('connection_conflict')
    const current = tx.prepare("SELECT * FROM zeitguru_operations WHERE userId=? AND status NOT IN ('confirmed','cancelled') ORDER BY sequence").all(userId) as unknown as OperationRow[]
    if (current.length !== unsent.length || current.some((row, index) => row.id !== unsent[index].id || row.generation !== generation || row.planCipher || row.status !== unsent[index].status || row.errorCode !== unsent[index].errorCode)) throw conflict('operation_conflict')
    for (const [index, plan] of plans.entries()) {
      const payload = decryptedJson(current[index].payloadCipher)
      if (plan.localEntryId !== payload.localEntryId || plan.action !== payload.action || plan.occurredAt !== payload.occurredAt || plan.capturedReplay !== true) throw invalid()
      tx.prepare("UPDATE zeitguru_operations SET planCipher=?,status='queued',errorCode=NULL,nextAttemptAt=0,updatedAt=? WHERE id=?")
        .run(encryptedJson(this.deliveryPlan(plan)), this.now(), current[index].id)
    }
    this.advanceClockRevision(tx, userId, revision)
  }
  /** Caller commits observed provider rows and local time entries in the SAME transaction. */
  saveObservedRows(tx: DatabaseSync, userId: string, generation: number, revision: number, rows: { localEntryId: string; row: ZeitguruJsonRecord }[]) {
    this.assertTransaction(tx)
    const connection = this.connection(identifier(userId), tx)
    if (!connection?.enabled || connection.generation !== generation || this.head(userId, tx).revision !== revision) throw conflict('connection_conflict')
    if (tx.prepare("SELECT 1 FROM zeitguru_operations WHERE userId=? AND status NOT IN ('confirmed','cancelled') LIMIT 1").get(userId)) throw conflict('reconciliation_required')
    for (const row of rows) tx.prepare(`INSERT INTO zeitguru_row_checkpoints(userId,localEntryId,providerKey,rowCipher,sequence,confirmedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(userId,localEntryId,providerKey) DO UPDATE SET rowCipher=excluded.rowCipher,sequence=excluded.sequence,confirmedAt=excluded.confirmedAt`)
      .run(userId, identifier(row.localEntryId), connection.providerKey, encryptedJson(row.row), this.head(userId, tx).nextSequence - 1, this.now())
    this.advanceClockRevision(tx, userId, revision)
  }
  private confirmRow(row: OperationRow, evidence: ZeitguruEvidence, timestamp: number) {
    if (!row.planCipher) throw conflict('delivery_plan_required')
    const plan = this.deliveryPlan(decryptedJson(row.planCipher)), connection = this.connection(row.userId)
    if (!connection?.providerKey) throw conflict('connection_conflict')
    const cipher = encryptedJson(plan.desiredRow)
    this.sql.prepare(`INSERT INTO zeitguru_row_checkpoints(userId,localEntryId,providerKey,rowCipher,sequence,confirmedAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(userId,localEntryId,providerKey) DO UPDATE SET rowCipher=excluded.rowCipher,sequence=excluded.sequence,confirmedAt=excluded.confirmedAt
      WHERE excluded.sequence>zeitguru_row_checkpoints.sequence`).run(row.userId,plan.localEntryId,connection.providerKey,cipher,row.sequence,timestamp)
    this.sql.prepare("UPDATE zeitguru_operations SET status='confirmed',attemptToken=NULL,leaseExpiresAt=NULL,nextAttemptAt=0,errorCode=NULL,acknowledgement=?,updatedAt=? WHERE id=?")
      .run(JSON.stringify({evidence,confirmedAt:timestamp}),timestamp,row.id)
  }
  /** Read the oldest ambiguous operation; credentials may have been refreshed since it was sent. */
  readReconciliation(userId: string, clientOperationId?: string): ZeitguruReconciliation | undefined {
    identifier(userId); if (clientOperationId !== undefined) identifier(clientOperationId)
    const connection = this.readConnection(userId)
    if (!connection) return undefined
    const row = this.sql.prepare("SELECT * FROM zeitguru_operations WHERE userId=? AND status='reconciliation_required' AND (? IS NULL OR clientOperationId=?) ORDER BY sequence LIMIT 1").get(userId,clientOperationId ?? null,clientOperationId ?? null) as unknown as OperationRow | undefined
    if (!row?.planCipher) return undefined
    return { operation:publicOperation(row),generation:connection.generation,auth:connection.auth,config:connection.config,payload:decryptedJson(row.payloadCipher),plan:this.deliveryPlan(decryptedJson(row.planCipher)) }
  }
  /** Exact provider read-back only. Expected/pre-write state never releases an unknown operation. */
  confirmReconciliation(snapshot: ZeitguruReconciliation, observedRow: ZeitguruJsonRecord): boolean {
    if (!snapshot?.operation) throw invalid()
    const observed = canonicalJson(observedRow)
    return this.transaction(() => {
      const row = this.sql.prepare('SELECT * FROM zeitguru_operations WHERE id=?').get(snapshot.operation.id) as unknown as OperationRow | undefined
      const connection = row ? this.connection(row.userId) : undefined
      if (!row || row.status !== 'reconciliation_required' || row.userId !== snapshot.operation.userId || !row.planCipher || !connection?.enabled || connection.generation !== snapshot.generation) return false
      const plan = this.deliveryPlan(decryptedJson(row.planCipher))
      if (canonicalJson(plan) !== canonicalJson(snapshot.plan) || observed !== canonicalJson(plan.desiredRow)) return false
      this.confirmRow(row,'read_back',this.now())
      return true
    })
  }
  /**
   * A stale completion returns false. Confirmed requires explicit evidence of provider acceptance.
   * Retry/auth failures require the adapter to affirm that nothing was delivered; timeout alone is
   * never evidence for notDelivered. Unknown acceptance must remain reconciliation_required.
   */
  complete(claim: Pick<ZeitguruDeliveryClaim,'operation'|'attemptToken'>, result: ZeitguruCompletion): boolean {
    if (!claim?.operation || !claim.attemptToken) throw invalid()
    if (!['confirmed','retryable_failure','reconciliation_required','authentication_required'].includes(result.status)) throw invalid()
    if (result.status === 'confirmed' && !evidenceKinds.includes(result.acknowledgement?.evidence)) throw invalid()
    if ((result.status === 'retryable_failure' || result.status === 'authentication_required') && result.notDelivered !== true) throw invalid()
    const retryAfterMs = result.status === 'retryable_failure' || result.status === 'authentication_required' ? result.retryAfterMs ?? 0 : 0
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 7*24*60*60_000) throw invalid()
    return this.transaction(() => {
      const timestamp = this.now(); this.expireLeases(timestamp)
      const row = this.activeClaim(claim)
      if (!row) return false
      if (result.status === 'confirmed') { this.confirmRow(row,result.acknowledgement.evidence,timestamp); return true }
      this.sql.prepare('UPDATE zeitguru_operations SET status=?,attemptToken=NULL,leaseExpiresAt=NULL,nextAttemptAt=?,errorCode=?,acknowledgement=?,updatedAt=? WHERE id=?')
        .run(result.status,timestamp+retryAfterMs,safeErrorCode(result.errorCode),null,timestamp,row.id)
      return true
    })
  }
}
