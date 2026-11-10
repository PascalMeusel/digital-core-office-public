import { randomUUID } from 'node:crypto'
import type { ZeitguruLoginChallenge, ZeitguruStatus } from '../shared/zeitguru.ts'
import { ZeitguruStore, ZeitguruStoreError, type ZeitguruJsonRecord, type ZeitguruDeliveryClaim, type ZeitguruUnsentClock } from './zeitguruStore.ts'
import { ZeitguruProtocolError } from './zeitguruProtocol.ts'
import { ZeitguruClientError } from './zeitguruClient.ts'
import type { ZeitguruObservedClock } from './zeitguruLiveClock.ts'

export class ZeitguruBridgeError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, message: string, status = 409) { super(message); this.name = 'ZeitguruBridgeError'; this.code = code; this.status = status }
}
export interface ZeitguruReadyConnection {
  auth: ZeitguruJsonRecord
  config: ZeitguruJsonRecord
  providerKey: string
  identity: { name: string; email: string }
  branches: { id: string; name: string }[]
  remoteStatus: 'off_work' | 'working' | 'on_break'
}
export interface ZeitguruDeliveryPlan extends ZeitguruJsonRecord {
  localEntryId: string
  expectedRow: ZeitguruJsonRecord | null
  desiredRow: ZeitguruJsonRecord
  patch: ZeitguruJsonRecord
}
/** Only the provider implementation handles tokens or provider response bodies. */
export interface ZeitguruProvider {
  rebase?(connection: ZeitguruReadyConnection, config: ZeitguruJsonRecord, unsent: ZeitguruUnsentClock[], checkpoint: ZeitguruJsonRecord): Promise<ZeitguruDeliveryPlan[]>
  observe?(connection: ZeitguruReadyConnection, checkpoints: { row: ZeitguruJsonRecord }[]): Promise<ZeitguruObservedClock[]>
  observationReviewDates?(connection: ZeitguruReadyConnection): string[]
  observationThroughDate?(connection: ZeitguruReadyConnection): string | undefined
  login(email: string, password: string): Promise<ZeitguruReadyConnection>
  refresh(auth: ZeitguruJsonRecord, config: ZeitguruJsonRecord): Promise<ZeitguruReadyConnection>
  plan(connection: ZeitguruReadyConnection, config: ZeitguruJsonRecord, intent: ZeitguruJsonRecord, checkpoint?: ZeitguruJsonRecord): Promise<ZeitguruDeliveryPlan>
  evidence(connection: ZeitguruReadyConnection, plan: ZeitguruDeliveryPlan): Promise<{ desired: boolean; expected: boolean; advanced?: boolean }>
  write(connection: ZeitguruReadyConnection, plan: ZeitguruDeliveryPlan): Promise<void>
}
interface Challenge { userId: string; generation: number; expiresAt: number; connection: ZeitguruReadyConnection }
interface LocalUser { id: string; email: string; active: boolean; mustChangePassword?: boolean }
interface LocalClockAccess {
  rebase?: (userId: string, generation: number, revision: number, unsent: ZeitguruUnsentClock[], plans: ZeitguruDeliveryPlan[]) => boolean
  user: (id: string) => LocalUser | undefined
  isClockedOut: (id: string) => boolean
  changed: () => void
  synchronize?: (userId: string, generation: number, revision: number, observed: ZeitguruObservedClock[], consentedAt: number, connect?: Parameters<ZeitguruStore['connect']>[0], historicalReviewDates?: Set<string>) => boolean
}
const ownEmail = (value: string) => value.trim().toLowerCase()
const invalid = () => new ZeitguruBridgeError('invalid_input', 'Invalid Zeitguru request.', 400)
function text(value: unknown, maximum = 256) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw invalid(); return value }

export class ZeitguruService {
  readonly journal: ZeitguruStore
  private readonly provider: ZeitguruProvider
  private readonly local: LocalClockAccess
  private readonly syncChecks = new Map<string, { checkedAt: number; error?: string }>()
  private readonly now: () => number
  private readonly challenges = new Map<string, Challenge>()
  private readonly loginAttempts = new Map<string, { count: number; until: number }>()
  private readonly busyUsers = new Set<string>()
  private readonly synchronizations = new Map<string, Promise<ZeitguruStatus>>()
  private running = false
  private readonly startedAt: number
  constructor(journal: ZeitguruStore, provider: ZeitguruProvider,
    local: LocalClockAccess,
    now: () => number = Date.now) {
    this.journal = journal; this.provider = provider; this.local = local; this.now = now
    this.startedAt = now()
    // A restored snapshot may predate a delivery made by the original process.
    // Surface every outstanding startup intent for review immediately, without a network call.
    journal.recoverSending({ includeQueued: true })
  }
  private purge() {
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt <= this.now()) this.challenges.delete(id)
    for (const [id, attempts] of this.loginAttempts) if (attempts.until <= this.now()) this.loginAttempts.delete(id)
  }
  private forgetChallenges(userId: string) { for (const [id, challenge] of this.challenges) if (challenge.userId === userId) this.challenges.delete(id) }
  private user(id: string) {
    const user = this.local.user(id)
    if (!user?.active || user.mustChangePassword || !ownEmail(user.email).endsWith('@example.test')) throw new ZeitguruBridgeError('account_unavailable', 'An active ExampleCompany account is required.', 403)
    return user
  }
  status(userId: string): ZeitguruStatus {
    this.purge()
    const status = this.journal.status(userId)
    let identity: ZeitguruStatus['identity']
    try {
      const saved = this.journal.readConnection(userId)?.config
      if (saved && typeof saved.name === 'string' && typeof saved.email === 'string' && typeof saved.branchName === 'string') {
        identity = { name: saved.name, email: saved.email, branchName: saved.branchName }
      }
    } catch { /* Public status must remain available when credentials require reconnecting. */ }
    return { available: true, ...status, ...(identity ? { identity } : {}), synchronization: this.syncChecks.get(userId) }
  }
  async login(userId: string, body: { email?: unknown; password?: unknown }): Promise<ZeitguruLoginChallenge> {
    this.purge()
    const user = this.user(userId), email = ownEmail(text(body.email)), password = text(body.password, 1024)
    if (email !== ownEmail(user.email)) throw new ZeitguruBridgeError('identity_mismatch', 'Connect your own Zeitguru account using your DCO email address.', 403)
    const attempts = this.loginAttempts.get(userId) ?? { count: 0, until: this.now() + 15 * 60_000 }
    if (attempts.count >= 5 || this.busyUsers.has(userId)) throw new ZeitguruBridgeError('rate_limited', 'Please wait before trying Zeitguru sign-in again.', 429)
    attempts.count++; this.loginAttempts.set(userId, attempts)
    this.busyUsers.add(userId); this.forgetChallenges(userId)
    const generation = this.journal.status(userId).generation
    try {
      const connection = await this.provider.login(email, password)
      if (ownEmail(connection.identity.email) !== ownEmail(this.user(userId).email)) throw new ZeitguruBridgeError('identity_mismatch', 'Zeitguru returned a different employee account.', 403)
      if (this.journal.status(userId).generation !== generation) throw new ZeitguruBridgeError('connection_changed', 'The connection changed. Sign in to Zeitguru again.')
      const challengeId = randomUUID(), expiresAt = this.now() + 3 * 60_000
      this.challenges.set(challengeId, { userId, generation, expiresAt, connection })
      setTimeout(() => this.challenges.delete(challengeId), 3 * 60_000).unref()
      return { challengeId, expiresAt, identity: connection.identity, branches: connection.branches, remoteStatus: connection.remoteStatus,
        canActivate: connection.branches.length > 0 && (Boolean(this.provider.observe && this.local.synchronize) || this.journal.canReauthenticate(userId, connection.providerKey) || (connection.remoteStatus === 'off_work' && this.local.isClockedOut(userId))) }
    } finally { this.busyUsers.delete(userId); delete body.password }
  }
  async connect(userId: string, body: { challengeId?: unknown; branchId?: unknown; consent?: unknown; expectedGeneration?: unknown }) {
    this.purge(); this.user(userId)
    const challengeId = text(body.challengeId), branchId = text(body.branchId)
    const challenge = this.challenges.get(challengeId)
    if (!challenge || challenge.userId !== userId || challenge.expiresAt <= this.now()) throw new ZeitguruBridgeError('challenge_expired', 'Sign in to Zeitguru again to confirm the connection.')
    if (body.consent !== true || body.expectedGeneration !== challenge.generation) throw invalid()
    if (this.busyUsers.has(userId)) throw new ZeitguruBridgeError('connection_busy', 'The connection is being checked. Please wait.')
    this.busyUsers.add(userId)
    try {
      const connection = await this.provider.refresh(challenge.connection.auth, challenge.connection.config)
      const user = this.user(userId)
      if (ownEmail(connection.identity.email) !== ownEmail(user.email) || connection.providerKey !== challenge.connection.providerKey) throw new ZeitguruBridgeError('identity_mismatch', 'Zeitguru returned a different employee account.', 403)
      const branch = connection.branches.find(candidate => candidate.id === branchId)
      if (!branch) throw new ZeitguruBridgeError('branch_unavailable', 'Select an available Zeitguru clocking location.')
      const restoring = this.journal.canReauthenticate(userId, connection.providerKey)
      const existing = this.journal.readConnection(userId)
      const oldBranch = existing?.config.branchId
      if (restoring && oldBranch && oldBranch !== branchId) throw new ZeitguruBridgeError('branch_changed', 'Keep the existing Zeitguru location while reviewing this shift.')
      if (!restoring && !(this.provider.observe && this.local.synchronize) && (connection.remoteStatus !== 'off_work' || !this.local.isClockedOut(userId))) throw new ZeitguruBridgeError('shift_running', 'Finish the current shift in both systems before connecting Zeitguru.')
      if (restoring && existing) {
        // Reauthentication of the same connection must not cancel a pending clock action.
        if (!this.journal.rotateAuth(userId, challenge.generation, connection.auth)) throw new ZeitguruBridgeError('connection_changed', 'The connection changed. Sign in again.')
      } else {
        const input = { userId, providerKey: connection.providerKey, auth: connection.auth, expectedGeneration: challenge.generation,
          config: { ...connection.config, branchId, branchName: branch.name, name: connection.identity.name, email: connection.identity.email, consentedAt: this.now() } }
        if (this.provider.observe && this.local.synchronize) {
          const revision = this.journal.getClockRevision(userId)
          const observed = await this.provider.observe(connection, [])
          this.user(userId)
          this.local.synchronize(userId, challenge.generation + 1, revision, observed, this.now(), input)
        } else this.journal.connect(input)
      }
      this.forgetChallenges(userId); this.local.changed()
      return this.status(userId)
    } finally { this.busyUsers.delete(userId) }
  }
  disconnect(userId: string, expectedGeneration: number) {
    this.user(userId); this.forgetChallenges(userId)
    this.journal.disconnect(userId, expectedGeneration); this.local.changed()
    return this.status(userId)
  }
  /** Server-only, read-only access for an explicit history import. A verified sign-in challenge
   * grants this without enabling clock forwarding or requiring the current shift to end. */
  async withHistoryAccount<T>(userId: string, expectedGeneration: number, challengeId: string | undefined,
    callback: (connection: ZeitguruReadyConnection, assertCurrent: () => void) => Promise<T>): Promise<T> {
    this.purge(); this.user(userId)
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw invalid()
    if (this.journal.status(userId).generation !== expectedGeneration) throw new ZeitguruBridgeError('connection_changed', 'The Zeitguru connection changed. Reload before importing.')
    if (this.busyUsers.has(userId)) throw new ZeitguruBridgeError('connection_busy', 'The Zeitguru connection is busy. Please wait.')
    const challenge = challengeId ? this.challenges.get(text(challengeId)) : undefined
    if (challengeId && (!challenge || challenge.userId !== userId || challenge.generation !== expectedGeneration || challenge.expiresAt <= this.now())) {
      throw new ZeitguruBridgeError('challenge_expired', 'Verify your Zeitguru account again before importing.')
    }
    this.busyUsers.add(userId)
    try {
      let connection: ZeitguruReadyConnection
      if (challenge) {
        connection = await this.provider.refresh(challenge.connection.auth, challenge.connection.config)
        if (connection.providerKey !== challenge.connection.providerKey) throw new ZeitguruBridgeError('identity_mismatch', 'The Zeitguru employee identity changed.')
      } else {
        const saved = this.journal.readConnection(userId)
        if (!saved || saved.generation !== expectedGeneration) throw new ZeitguruBridgeError('authentication_required', 'Verify your Zeitguru account before importing history.', 401)
        connection = await this.refreshed(userId, expectedGeneration, saved.auth, saved.config)
      }
      const assertCurrent = () => {
        const user = this.user(userId)
        if (ownEmail(connection.identity.email) !== ownEmail(user.email)) throw new ZeitguruBridgeError('identity_mismatch', 'The employee identity changed.')
        if (this.journal.status(userId).generation !== expectedGeneration) throw new ZeitguruBridgeError('connection_changed', 'The connection changed while history was being read.')
      }
      assertCurrent()
      return await callback(connection, assertCurrent)
    } finally {
      this.busyUsers.delete(userId)
      if (challengeId) this.challenges.delete(challengeId)
    }
  }
  private async refreshed(userId: string, generation: number, auth: ZeitguruJsonRecord, config: ZeitguruJsonRecord) {
    this.user(userId)
    const connection = await this.provider.refresh(auth, config)
    const user = this.user(userId)
    if (ownEmail(connection.identity.email) !== ownEmail(user.email) || !this.journal.canReauthenticate(userId, connection.providerKey)) throw new ZeitguruBridgeError('identity_mismatch', 'The employee identity changed.')
    if (!this.journal.rotateAuth(userId, generation, connection.auth)) throw new ZeitguruBridgeError('connection_changed', 'The connection changed.')
    return connection
  }
  /** Pull recorded provider actions and recover only proven-unsent durable local intents. */
  async synchronize(userId: string) {
    this.user(userId)
    const active = this.synchronizations.get(userId)
    if (active) return active
    // A clock preflight can arrive during the same employee's background check.
    // Share its result or failure; do not repeat provider work or join unrelated
    // connection/history operations protected by busyUsers.
    const synchronization = this.synchronizeOnce(userId)
    this.synchronizations.set(userId, synchronization)
    try { return await synchronization }
    finally { if (this.synchronizations.get(userId) === synchronization) this.synchronizations.delete(userId) }
  }
  private async synchronizeOnce(userId: string) {
    if (!this.provider.observe || !this.local.synchronize) return this.status(userId)
    if (this.busyUsers.has(userId)) throw new ZeitguruBridgeError('connection_busy', 'Zeitguru is being checked. Please try again shortly.')
    this.busyUsers.add(userId)
    try {
      let status = this.journal.status(userId)
      if (!status.enabled || status.counts.sending || (status.counts.queued && !status.requiresAttention)) return this.status(userId)
      // Resolve uncertain delivery only from exact read-back; never resend it.
      if (status.requiresAttention) {
        const unsent = this.journal.unsentConflict(userId), saved = this.journal.readConnection(userId)
        if (unsent && saved && this.provider.rebase && this.local.rebase) {
          const checkpoint = this.journal.lastConfirmedRow(userId, String(unsent[0].payload.localEntryId))
          if (!checkpoint) throw new ZeitguruBridgeError('manual_check_required', 'The start of the previous DCO shift needs review in Zeitguru.')
          const connection = await this.refreshed(userId, saved.generation, saved.auth, saved.config)
          const plans = await this.provider.rebase(connection, saved.config, unsent, checkpoint)
          this.user(userId)
          this.local.rebase(userId, saved.generation, status.clockRevision, unsent, plans)
          this.syncChecks.set(userId, { checkedAt: this.now() })
          this.kick()
          return this.status(userId)
        }
        const pending = this.journal.readReconciliation(userId)
        if (!pending?.plan) throw new ZeitguruBridgeError('manual_check_required', 'A previous DCO action still needs review before importing Zeitguru changes.')
        const connection = await this.refreshed(userId, pending.generation, pending.auth, pending.config)
        const evidence = await this.provider.evidence(connection, pending.plan as ZeitguruDeliveryPlan)
        if (!(evidence.desired || evidence.advanced) || !this.journal.confirmReconciliation(pending, pending.plan.desiredRow))
          throw new ZeitguruBridgeError('manual_check_required', 'A previous DCO action is not confirmed by Zeitguru. Review it before replacing recorded times.')
        status = this.journal.status(userId)
        if (status.requiresAttention || status.counts.queued || status.counts.sending) return this.status(userId)
      }
      const saved = this.journal.readConnection(userId)
      if (!saved) return this.status(userId)
      const connection = await this.refreshed(userId, saved.generation, saved.auth, saved.config)
      const observed = await this.provider.observe(connection, this.journal.observedRows(userId))
      this.user(userId)
      const historicalReviewDates = new Set<string>()
      const changed = this.local.synchronize(userId, saved.generation, status.clockRevision, observed, Number(saved.config.consentedAt ?? this.now()), undefined, historicalReviewDates)
      const reviewDates = [...new Set([...(this.provider.observationReviewDates?.(connection) ?? []), ...historicalReviewDates])].sort()
      const throughDate = this.provider.observationThroughDate?.(connection)
      // Unresolved historical rows keep the cursor in place, so they are never
      // permanently skipped after review. Local merge commits before progress.
      if (throughDate && !reviewDates.length) this.journal.markSynchronized(userId, saved.generation, status.clockRevision + (changed ? 1 : 0), throughDate)
      this.syncChecks.set(userId, { checkedAt: this.now(), ...(reviewDates.length ? {
        error: `Ältere Zeitguru-Einträge prüfen / Review older Zeitguru records: ${reviewDates.join(', ')}. Neue Stempelungen bleiben möglich / New clock actions remain available.`,
      } : {}) })
      return this.status(userId)
    } catch (error) {
      const message = error instanceof ZeitguruBridgeError ? error.message : 'Zeitguru could not be synchronized. Please try again.'
      this.syncChecks.set(userId, { checkedAt: this.now(), error: message })
      throw error
    } finally { this.busyUsers.delete(userId); this.local.changed() }
  }
  /** Trigger only after an authenticated normal clock action. Never replay a restored queue at startup. */
  kick() {
    if (this.running) return
    this.running = true
    void this.drain().catch(() => { /* Safe operation status is the user-visible error channel; never log tokens. */ }).finally(() => { this.running = false; this.local.changed() })
  }
  private async drain() {
    for (let count = 0; count < 100; count++) {
      const claim = this.journal.claimNext({ leaseMs: 180_000 })
      if (!claim) return
      await this.deliver(claim)
      this.local.changed()
    }
  }
  private async deliver(claim: ZeitguruDeliveryClaim) {
    let writeStarted = false
    let plan = claim.plan as ZeitguruDeliveryPlan | undefined
    const assertFresh = () => {
      const occurredAt = Date.parse(String(claim.payload.occurredAt))
      const captured = claim.plan?.capturedReplay === true
      if (!Number.isFinite(occurredAt) || (!captured && occurredAt < this.startedAt) || this.now() - occurredAt > (captured ? 86400000 : 120_000) || occurredAt > this.now() + 5000) {
        throw new ZeitguruBridgeError('event_expired', 'An older punch needs to be checked in Zeitguru.')
      }
    }
    // A failed read cannot have delivered this intent. Retry only known transient read
    // errors, with the same immutable plan, while this original worker still owns it.
    // Restored/uncertain operations never enter this loop through reconciliation.
    for (let readAttempt = 0; ; readAttempt++) {
      try {
        assertFresh()
        if (!this.journal.isClaimCurrent(claim)) return
        const saved = this.journal.readConnection(claim.operation.userId)
        if (!saved || saved.generation !== claim.operation.generation) return
        // Refresh may rotate credentials before a later read fails. Never retry using
        // the stale credentials captured when the delivery was initially claimed.
        const connection = await this.refreshed(claim.operation.userId, claim.operation.generation, saved.auth, saved.config)
        const entryId = text(claim.payload.localEntryId)
        const checkpoint = this.journal.lastConfirmedRow(claim.operation.userId, entryId)
        plan ??= await this.provider.plan(connection, claim.config, claim.payload, checkpoint)
        if (!this.journal.saveDeliveryPlan(claim, plan)) return
        // Re-read just before sending. A conflicting external clock action or correction requires review.
        const before = await this.provider.evidence(connection, plan)
        if (before.desired || before.advanced) {
          this.journal.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'read_back' } }); return
        }
        if (!before.expected) throw new ZeitguruBridgeError('remote_conflict', 'Zeitguru changed. Check the entry before continuing.')
        const user = this.user(claim.operation.userId)
        if (ownEmail(connection.identity.email) !== ownEmail(user.email) || !this.journal.canReauthenticate(user.id, connection.providerKey)) throw new ZeitguruBridgeError('identity_mismatch', 'The employee identity changed.')
        assertFresh()
        if (!this.journal.isClaimCurrent(claim)) return
        // Once write is invoked, every error is uncertain. No blind retries after a timeout or HTTP failure.
        writeStarted = true
        await this.provider.write(connection, plan)
        const after = await this.provider.evidence(connection, plan)
        if (!after.desired && !after.advanced) throw new ZeitguruBridgeError('remote_conflict', 'Zeitguru did not confirm the expected entry.')
        this.journal.complete(claim, { status: 'confirmed', acknowledgement: { evidence: 'read_back' } })
        return
      } catch (error) {
        const transientRead = !writeStarted && error instanceof ZeitguruClientError &&
          ['provider_timeout', 'provider_unavailable', 'provider_request_failed', 'rate_limited'].includes(error.code)
        if (transientRead && readAttempt < 2) {
          await new Promise<void>(resolve => setTimeout(resolve, 1000 * 2 ** readAttempt))
          continue
        }
        const authentication = !writeStarted && (error instanceof ZeitguruBridgeError || error instanceof ZeitguruClientError) && error.code === 'authentication_required'
        const readRetryExpired = readAttempt > 0 && error instanceof ZeitguruBridgeError && error.code === 'event_expired'
        this.journal.complete(claim, authentication
          ? { status: 'authentication_required', notDelivered: true, errorCode: 'authentication_required' }
          : { status: 'reconciliation_required', errorCode: writeStarted ? 'delivery_ambiguous' : transientRead || readRetryExpired ? 'preflight_unavailable' : 'remote_conflict' })
        return
      }
    }
  }
  async reconcile(userId: string, operationId: string) {
    this.user(userId)
    // The journal lookup is scoped to this authenticated employee, even if another ID is supplied.
    const status = this.journal.status(userId)
    const operation = status.attentionOperation ?? status.latestOperation
    if (!operation || operation.id !== text(operationId)) throw new ZeitguruBridgeError('operation_unavailable', 'Reload the current Zeitguru delivery status.')
    const pending = this.journal.readReconciliation(userId, operation.clientOperationId)
    if (!pending?.plan) throw new ZeitguruBridgeError('manual_check_required', 'No confirmed delivery can be checked automatically. Check this punch in Zeitguru before reconnecting.')
    const connection = await this.refreshed(userId, pending.generation, pending.auth, pending.config)
    const plan = pending.plan as ZeitguruDeliveryPlan
    const evidence = await this.provider.evidence(connection, plan)
    if (!evidence.desired && !evidence.advanced) throw new ZeitguruBridgeError('manual_check_required', 'Zeitguru does not contain the expected punch and credited time. Check it there; no punch has been resent.')
    if (!this.journal.confirmReconciliation(pending, plan.desiredRow)) throw new ZeitguruBridgeError('connection_changed', 'The connection changed. Reload and check again.')
    this.local.changed(); this.kick()
    return this.status(userId)
  }
  async acknowledgeReview(userId: string, expectedGeneration: number, reviewed: unknown) {
    this.user(userId)
    if (reviewed !== true) throw invalid()
    const saved = this.journal.readConnection(userId)
    if (!saved || saved.generation !== expectedGeneration) throw new ZeitguruBridgeError('connection_changed', 'Reconnect your Zeitguru account before completing the review.')
    const connection = await this.refreshed(userId, saved.generation, saved.auth, saved.config)
    if (!this.local.isClockedOut(userId) || connection.remoteStatus !== 'off_work') throw new ZeitguruBridgeError('shift_running', 'Finish the current shift in both systems before completing the manual review.')
    this.journal.acknowledgeManualReview(userId, expectedGeneration)
    this.local.changed()
    return this.status(userId)
  }
}

export function zeitguruPublicError(error: unknown) {
  if (error instanceof ZeitguruBridgeError || error instanceof ZeitguruStoreError || error instanceof ZeitguruProtocolError) return { status: error.status, body: { message: error.message, code: error.code } }
  return { status: 502, body: { message: 'Zeitguru could not be reached or sign-in failed. Please check your details and try again.', code: 'provider_unavailable' } }
}
