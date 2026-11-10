import { ZeitguruClient, ZeitguruClientError, type ZeitguruTokens } from './zeitguruClient.ts'
import { allocateZeitguruClockId, planZeitguruTransition, zeitguruAddDays, zeitguruCanonical, zeitguruCreditPrefix, zeitguruFingerprint, zeitguruIdentifier, zeitguruRecord, zeitguruWallTime, type ZeitguruBinding, type ZeitguruClockRow, type ZeitguruSnapshot } from './zeitguruProtocol.ts'
import { ZeitguruBridgeError, type ZeitguruDeliveryPlan, type ZeitguruProvider, type ZeitguruReadyConnection } from './zeitguruService.ts'
import type { ZeitguruClockAction, ZeitguruJsonRecord, ZeitguruUnsentClock } from './zeitguruStore.ts'
import { containsZeitguruTransition, observedZeitguruClock, observeZeitguruRows } from './zeitguruLiveClock.ts'

const jsonRecord = (value: unknown) => JSON.parse(JSON.stringify(value)) as ZeitguruJsonRecord
const same = (left: unknown, right: unknown) => zeitguruCanonical(left) === zeitguruCanonical(right)
interface PrivateConnection { tokens: ZeitguruTokens; binding: ZeitguruBinding; snapshot: ZeitguruSnapshot; reviewDates?: string[]; catchUpFrom?: string; caughtThroughDate?: string }

/** Merge only durable, never-sent punches after an unchanged prefix of provider history. */
export function planZeitguruRecovery(snapshot: ZeitguruSnapshot, config: ZeitguruJsonRecord, unsent: ZeitguruUnsentClock[], checkpoint: ZeitguruJsonRecord): ZeitguruDeliveryPlan[] {
  const fail = (): never => { throw new ZeitguruBridgeError('manual_check_required', 'The recorded DCO actions cannot be safely merged with Zeitguru. Review the shift before continuing.') }
  if (!unsent.length || unsent.some(item => item.payload.localEntryId !== unsent[0].payload.localEntryId || item.payload.action === 'start_work')) fail()
  const shadow = structuredClone(snapshot), active = shadow.clockings.filter(row => !row.endTime && !row.isAutoClockOut)
  if (active.length !== 1) fail()
  let current = active[0]
  const credit = shadow.credits[current.date]?.[zeitguruCreditPrefix(current.id)]
  if (!containsZeitguruTransition(checkpoint as unknown as ZeitguruClockRow, current, credit ? zeitguruRecord(credit).C ?? null : null, snapshot.observedAt)) fail()
  const converted = observedZeitguruClock(current, snapshot.binding.userId, snapshot.observedAt).entry
  const last = converted.breaks.at(-1)
  // Strictly later minutes exclude already delivered actions, including restored pre-write snapshots.
  if (Math.floor(Date.parse(String(unsent[0].payload.occurredAt)) / 60000) <= Math.floor(Date.parse(last?.stoppedAt ?? last?.startedAt ?? converted.startedAt) / 60000)) fail()
  let previous = -Infinity
  return unsent.map(item => {
    const occurredAt = String(item.payload.occurredAt), instant = Date.parse(occurredAt)
    if (!Number.isFinite(instant) || instant < previous) fail()
    previous = instant
    const mutation = planZeitguruTransition(shadow, { action: item.payload.action as ZeitguruClockAction, occurredAt,
      expectedRow: current, branchId: String(config.branchId), capturedPast: true })
    shadow.clockings = shadow.clockings.map(row => row.id === current.id ? mutation.desiredRow : row)
    current = mutation.desiredRow
    shadow.credits[current.date][zeitguruCreditPrefix(current.id)] = { ...zeitguruRecord(shadow.credits[current.date][zeitguruCreditPrefix(current.id)] ?? {}), C: mutation.patch[mutation.creditPath] }
    return { ...jsonRecord(mutation), localEntryId: String(item.payload.localEntryId), capturedReplay: true,
      desiredRow: jsonRecord(mutation.desiredRow), expectedRow: jsonRecord(mutation.expectedRow), patch: jsonRecord(mutation.patch) }
  })
}

/** ExampleCompany's temporary browser-clock adapter. The vendor has no verified public clock-action API.
 * Mirrors its observed atomic clock/credit PATCH, with fresh preflight and read-back, never blind retries.
 * The protocol cannot exclude a simultaneous external edit between the preflight read and the PATCH.
 */
export class ZeitguruWebProvider implements ZeitguruProvider {
  private readonly client: ZeitguruClient
  private readonly connections = new WeakMap<ZeitguruReadyConnection, PrivateConnection>()
  private readonly fetchImpl: typeof fetch
  constructor(options: { client?: ZeitguruClient; fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.client = options.client ?? new ZeitguruClient({ fetchImpl: this.fetchImpl })
  }
  private ready(tokens: ZeitguruTokens, binding: ZeitguruBinding, snapshot: ZeitguruSnapshot): ZeitguruReadyConnection {
    if (binding.role !== 'employee' || snapshot.clockSettings.allowUserTimClockInBrowser !== true || snapshot.rosterSettings.timezone !== 'Europe/Berlin') {
      throw new ZeitguruBridgeError('unsupported_settings', 'This evaluation supports employee accounts with browser clocking enabled in Europe/Berlin.')
    }
    const active = snapshot.clockings.filter(row => !row.endTime && !row.isAutoClockOut)
    if (active.length > 1) throw new ZeitguruBridgeError('remote_conflict', 'More than one Zeitguru shift is open. Resolve this in Zeitguru first.')
    const connection: ZeitguruReadyConnection = {
      auth: jsonRecord(tokens), config: { binding: jsonRecord(binding) }, providerKey: `${binding.tenantId}:${binding.userId}`,
      identity: { name: String(snapshot.profile.name ?? ''), email: String(snapshot.profile.email ?? '').trim().toLowerCase() },
      branches: snapshot.branches.filter(branch => branch.isClockingEnabled === true && !branch.isInactive && !branch.isDisabled).map(branch => ({ id: zeitguruIdentifier(branch.id), name: String(branch.name ?? '') })),
      remoteStatus: !active.length ? 'off_work' : active[0].breakActivities?.at(-1)?.type === 'start' ? 'on_break' : 'working',
    }
    this.connections.set(connection, { tokens, binding, snapshot })
    return connection
  }
  async login(email: string, password: string) {
    const { tokens, binding, snapshot } = await this.client.login(email, password)
    return this.ready(tokens, binding, snapshot)
  }
  async refresh(auth: ZeitguruJsonRecord, config: ZeitguruJsonRecord) {
    try {
      let tokens = auth as unknown as ZeitguruTokens
      const binding = config.binding as unknown as ZeitguruBinding
      if (!binding || typeof tokens.idToken !== 'string' || typeof tokens.refreshToken !== 'string' || typeof tokens.expiresAt !== 'number') throw new ZeitguruBridgeError('authentication_required', 'Reconnect your Zeitguru account.')
      if (tokens.expiresAt < Date.now() + 60_000) tokens = (await this.client.refresh(tokens.refreshToken, binding)).tokens
      const snapshot = await this.client.readSnapshot(tokens, binding)
      const connection = this.ready(tokens, binding, snapshot)
      // Start at consent for older installations, then overlap the last successful
      // day. Never infer progress merely from a successful provider read.
      if (typeof config.consentedAt === 'number' && Number.isFinite(config.consentedAt)) {
        const consentDate = zeitguruWallTime(config.consentedAt).date
        const cursor = typeof config.liveSyncThroughDate === 'string' ? config.liveSyncThroughDate : consentDate
        zeitguruAddDays(cursor, 0)
        const from = zeitguruAddDays(cursor, -1)
        this.privateConnection(connection).catchUpFrom = from < consentDate ? consentDate : from
      }
      return connection
    } catch (error) {
      if (error instanceof ZeitguruClientError && error.code === 'authentication_required') throw new ZeitguruBridgeError('authentication_required', 'Reconnect your Zeitguru account.')
      throw error
    }
  }
  private privateConnection(connection: ZeitguruReadyConnection) {
    const value = this.connections.get(connection)
    if (!value) throw new ZeitguruBridgeError('connection_unavailable', 'Reconnect your Zeitguru account.')
    return value
  }
  async observe(connection: ZeitguruReadyConnection, checkpoints: { row: ZeitguruJsonRecord }[]) {
    const state = this.privateConnection(connection)
    const { snapshot, tokens, binding } = state
    const rows = [...snapshot.clockings]
    // Bounded own-account catch-up fills weekends and longer gaps without a
    // tenant-wide scan or any provider write. Later calls continue large gaps.
    if (state.catchUpFrom && state.catchUpFrom < snapshot.fromDate) {
      const end = zeitguruAddDays(state.catchUpFrom, 30)
      const previousDay = zeitguruAddDays(snapshot.fromDate, -1)
      const through = end < previousDay ? end : previousDay
      const history = await this.client.readOwnHistoryRange(tokens, binding, state.catchUpFrom, through)
      rows.push(...history.filter(row => !rows.some(current => current.id === row.id)))
      state.caughtThroughDate = through === previousDay ? snapshot.toDate : through
    } else if (state.catchUpFrom) state.caughtThroughDate = snapshot.toDate
    // A shift may have been closed outside DCO after falling out of the recent snapshot.
    for (const checkpoint of checkpoints.filter(item => !item.row.endTime && !rows.some(row => row.id === item.row.id))) {
      const result = await this.client.readOwnRow(tokens, binding, String(checkpoint.row.id))
      if (!result.value) throw new ZeitguruBridgeError('remote_conflict', 'A linked Zeitguru shift was deleted. Review its recorded times.')
      rows.push(result.value as ZeitguruClockRow)
    }
    const result = observeZeitguruRows(rows, binding.userId, snapshot.observedAt)
    this.privateConnection(connection).reviewDates = result.reviewDates
    return result.observed
  }
  observationReviewDates(connection: ZeitguruReadyConnection) { return this.privateConnection(connection).reviewDates ?? [] }
  observationThroughDate(connection: ZeitguruReadyConnection) { return this.privateConnection(connection).caughtThroughDate }
  async plan(connection: ZeitguruReadyConnection, config: ZeitguruJsonRecord, intent: ZeitguruJsonRecord, checkpoint?: ZeitguruJsonRecord): Promise<ZeitguruDeliveryPlan> {
    const { snapshot, tokens, binding } = this.privateConnection(connection)
    await this.client.readServerTime(tokens, binding)
    const action = intent.action as ZeitguruClockAction, occurredAt = String(intent.occurredAt)
    if (action !== 'start_work' && !checkpoint) throw new ZeitguruBridgeError('missing_start', 'The Zeitguru start of this shift was not confirmed. Check the shift in Zeitguru.')
    const remoteClockId = action === 'start_work' ? allocateZeitguruClockId(snapshot, zeitguruWallTime(occurredAt).date) : undefined
    const mutation = planZeitguruTransition(snapshot, { action, occurredAt, branchId: String(config.branchId), remoteClockId,
      expectedRow: action === 'start_work' ? null : checkpoint as ZeitguruClockRow })
    return {
      ...jsonRecord(mutation), localEntryId: String(intent.localEntryId), desiredRow: jsonRecord(mutation.desiredRow),
      expectedRow: mutation.expectedRow ? jsonRecord(mutation.expectedRow) : null, patch: jsonRecord(mutation.patch),
    }
  }
  async rebase(connection: ZeitguruReadyConnection, config: ZeitguruJsonRecord, unsent: ZeitguruUnsentClock[], checkpoint: ZeitguruJsonRecord) {
    const { snapshot, tokens, binding } = this.privateConnection(connection)
    await this.client.readServerTime(tokens, binding)
    return planZeitguruRecovery(snapshot, config, unsent, checkpoint)
  }
  private validatePlan(binding: ZeitguruBinding, plan: ZeitguruDeliveryPlan) {
    const row = plan.desiredRow as unknown as ZeitguruClockRow, id = zeitguruIdentifier(row.id)
    if (plan.tenantId !== binding.tenantId || plan.userId !== binding.userId || row.userId !== binding.userId || row.id !== id) throw new ZeitguruBridgeError('identity_mismatch', 'The delivery identity changed.')
    const date = zeitguruWallTime(`${row.date}T12:00:00+02:00`).date
    if (date !== row.date || row.userId_date !== `${binding.userId}_${date}`) throw new ZeitguruBridgeError('invalid_plan', 'The stored delivery needs review.')
    const rowPath = `timeClockings/${id}`, creditPath = `credits/${binding.userId}_${date}/${zeitguruCreditPrefix(id)}/C`
    if (plan.creditPath !== creditPath || !same(plan.patch[rowPath], row) || Object.keys(plan.patch).some(path => path !== rowPath && path !== creditPath)) throw new ZeitguruBridgeError('invalid_plan', 'The stored delivery needs review.')
    return { row, rowPath, creditPath }
  }
  async evidence(connection: ZeitguruReadyConnection, plan: ZeitguruDeliveryPlan) {
    const { tokens, binding } = this.privateConnection(connection), { row, creditPath } = this.validatePlan(binding, plan)
    const [observed, credits, snapshot] = await Promise.all([
      this.client.readOwnRow(tokens, binding, row.id), this.client.readOwnCredits(tokens, binding, row.date), this.client.readSnapshot(tokens, binding),
    ])
    const group = credits.value[zeitguruCreditPrefix(row.id)]
    const credit = group === undefined || group === null ? null : zeitguruRecord(group).C ?? null
    const desiredCredit = Object.hasOwn(plan.patch, creditPath) ? plan.patch[creditPath] : plan.expectedCredit
    const settings = zeitguruFingerprint({ clock: snapshot.clockSettings, roster: snapshot.rosterSettings, profile: snapshot.profile, branches: snapshot.branches, tenant: snapshot.tenant })
    const active = snapshot.clockings.filter(candidate => !candidate.endTime && !candidate.isAutoClockOut)
    const activeExpected = plan.expectedRow === null ? active.length === 0 : active.length === 1 && active[0].id === plan.expectedRow.id
    return {
      desired: same(observed.value, row) && same(credit, desiredCredit),
      advanced: Boolean(observed.value && containsZeitguruTransition(row, observed.value as ZeitguruClockRow, credit, snapshot.observedAt)),
      expected: activeExpected && same(observed.value, plan.expectedRow) && same(credit, plan.expectedCredit) && settings === plan.settingsFingerprint,
    }
  }
  async write(connection: ZeitguruReadyConnection, plan: ZeitguruDeliveryPlan) {
    const { tokens, binding } = this.privateConnection(connection)
    this.validatePlan(binding, plan)
    const url = new URL(`https://aplano-production.firebaseio.com/tenants/${zeitguruIdentifier(binding.tenantId)}.json`)
    url.searchParams.set('auth', tokens.idToken)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetchImpl(url, { method: 'PATCH', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan.patch) })
      // Consume neither an error body nor a response containing employee data into logs.
      if (!response.ok) throw new Error('Unconfirmed provider write')
      await response.body?.cancel()
    } catch { throw new ZeitguruBridgeError('delivery_ambiguous', 'Zeitguru delivery is uncertain. Check its status before taking further action.') }
    finally { clearTimeout(timeout) }
  }
}
