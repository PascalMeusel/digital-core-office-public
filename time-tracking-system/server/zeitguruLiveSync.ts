import { randomUUID } from 'node:crypto'
import type { TimeEntry } from '../shared/domain.ts'
import { addAudit, readDatabase, writeDatabaseAtomically } from './store.ts'
import { ZeitguruStore, type ZeitguruJsonRecord, type ZeitguruUnsentClock } from './zeitguruStore.ts'
import { observedZeitguruClock, type ZeitguruObservedClock } from './zeitguruLiveClock.ts'
import { zeitguruCanonical, zeitguruWallTime, type ZeitguruClockRow } from './zeitguruProtocol.ts'
import { ZeitguruBridgeError, type ZeitguruDeliveryPlan } from './zeitguruService.ts'

type ConnectInput = Parameters<ZeitguruStore['connect']>[0]
const conflict = () => new ZeitguruBridgeError('local_conflict', 'These times overlap a separate or corrected DCO entry. Review them before synchronizing Zeitguru.')
const rounded = (value?: string) => value ? Math.floor(Date.parse(value) / 60000) : null
const clockShape = (entry: Pick<TimeEntry, 'startedAt' | 'stoppedAt' | 'breaks' | 'manualBreakMinutes'>) => JSON.stringify([
  rounded(entry.startedAt), rounded(entry.stoppedAt), entry.manualBreakMinutes ?? 0, entry.breaks.map(item => [rounded(item.startedAt), rounded(item.stoppedAt)]),
])

function preservePrecision(next: ZeitguruObservedClock['entry'], local: TimeEntry) {
  const retain = (value: string | undefined, original: string | undefined) => value && original && rounded(value) === rounded(original) ? original : value
  return { ...next, startedAt: retain(next.startedAt, local.startedAt)!, stoppedAt: retain(next.stoppedAt, local.stoppedAt), breaks: next.breaks.map(item => {
    const original = local.breaks.find(candidate => rounded(candidate.startedAt) === rounded(item.startedAt) && rounded(candidate.stoppedAt) === rounded(item.stoppedAt))
    return original ? { ...original } : item
  }) }
}

/** Commit the merged local shift and complete delivery plans together; original intents remain immutable. */
export function applyZeitguruRebase(journal: ZeitguruStore, userId: string, generation: number, revision: number, unsent: ZeitguruUnsentClock[], plans: ZeitguruDeliveryPlan[]) {
  if (!unsent.length || unsent.length !== plans.length) throw conflict()
  const database = readDatabase(), entryId = String(unsent[0].payload.localEntryId), now = new Date().toISOString()
  const local = database.timeEntries.find(entry => entry.userId === userId && entry.id === entryId)
  const checkpoint = journal.lastConfirmedRow(userId, entryId)
  if (!local || local.source !== 'clock' || !checkpoint || unsent.some(item => item.payload.localEntryId !== entryId)) throw conflict()
  const expected = observedZeitguruClock(checkpoint as unknown as ZeitguruClockRow, String(checkpoint.userId), now).entry
  for (const { payload } of unsent) {
    const occurredAt = String(payload.occurredAt), open = expected.breaks.at(-1)
    if (expected.stoppedAt) throw conflict()
    if (payload.action === 'start_break' && (!open || open.stoppedAt)) expected.breaks.push({ id: randomUUID(), startedAt: occurredAt })
    else if (payload.action === 'stop_break' && open && !open.stoppedAt) open.stoppedAt = occurredAt
    else if (payload.action === 'stop_work') { expected.stoppedAt = occurredAt; if (open && !open.stoppedAt) open.stoppedAt = occurredAt }
    else throw conflict()
  }
  if (clockShape(local) !== clockShape(expected)) throw conflict()
  const row = plans.at(-1)!.desiredRow as unknown as ZeitguruClockRow
  const merged = preservePrecision(observedZeitguruClock(row, String(checkpoint.userId), now).entry, local)
  if (database.timeEntries.some(entry => entry.userId === userId && entry.id !== entryId && Date.parse(entry.startedAt) < (merged.stoppedAt ? Date.parse(merged.stoppedAt) : Infinity) && (entry.stoppedAt ? Date.parse(entry.stoppedAt) : Infinity) > Date.parse(merged.startedAt))) throw conflict()
  const previous = structuredClone(local)
  Object.assign(local, merged, { updatedAt: now })
  addAudit(database, userId, 'zeitguru_clock_rebased', 'time_entry', entryId, { previous, merged: local, operationIds: unsent.map(item => item.id) })
  writeDatabaseAtomically(database, (tx, persist) => { journal.stageRebasedPlans(tx, userId, generation, revision, unsent, plans); persist() })
  return true
}

/** Preserve observed punches locally without issuing any provider writes. */
export function applyZeitguruLiveSync(journal: ZeitguruStore, userId: string, generation: number, revision: number,
  observed: ZeitguruObservedClock[], consentedAt: number, connect?: ConnectInput, historicalReviewDates?: Set<string>) {
  const database = readDatabase(), now = new Date().toISOString()
  const today = zeitguruWallTime(now).date
  const own = database.timeEntries.filter(entry => entry.userId === userId)
  const checkpoints = journal.observedRows(userId)
  const active = observed.filter(item => !item.entry.stoppedAt)
  if (active.length > 1) throw conflict()
  const selected = observed.filter(item => checkpoints.some(point => point.row.id === item.row.id) || !item.entry.stoppedAt || Date.parse(item.entry.startedAt) >= consentedAt)
    .sort((left, right) => Date.parse(left.entry.startedAt) - Date.parse(right.entry.startedAt))
  const updates: { localEntryId: string; row: ZeitguruJsonRecord }[] = []
  for (const remote of selected) {
    const checkpoint = checkpoints.find(point => point.row.id === remote.row.id)
    let local = checkpoint ? own.find(entry => entry.id === checkpoint.localEntryId) : undefined
    if (checkpoint && !local) {
      // Approved corrections replace native entries. Retain the old checkpoint
      // for review instead of recreating the original or blocking a later day.
      const stop = remote.entry.stoppedAt
      const replacedHistoricalEntry = stop && remote.entry.date < today && zeitguruWallTime(stop).date < today
        && own.some(entry => entry.source === 'approved_correction' && entry.stoppedAt
          && Date.parse(entry.startedAt) < Date.parse(stop) && Date.parse(entry.stoppedAt) > Date.parse(remote.entry.startedAt))
      if (historicalReviewDates && replacedHistoricalEntry) {
        historicalReviewDates.add(remote.entry.date)
        continue
      }
      throw conflict()
    }
    if (checkpoint && zeitguruCanonical(checkpoint.row) === zeitguruCanonical(remote.row)) {
      if (!remote.entry.stoppedAt && local && clockShape(local) !== clockShape(remote.entry)) throw conflict()
      continue
    }
    if (!local && connect && !remote.entry.stoppedAt) {
      local = own.find(entry => !entry.stoppedAt && clockShape(entry) === clockShape(remote.entry))
    }
    if (local) {
      if (checkpoint) {
        const before = observedZeitguruClock(checkpoint.row as unknown as ZeitguruClockRow, String(remote.row.userId), now)
        if (clockShape(before.entry) === clockShape(remote.entry)) {
          // Approval or metadata changes must not undo a deliberate DCO correction.
          updates.push({ localEntryId: local.id, row: JSON.parse(JSON.stringify(remote.row)) as ZeitguruJsonRecord })
          continue
        }
        const automaticClose = remote.entry.stoppedAt && Date.parse(remote.entry.stoppedAt) - Date.parse(remote.entry.startedAt) <= 13 * 3600000
          && database.audit.some(audit => audit.action === 'auto_clock_out_over_13h' && audit.targetId === local!.id && audit.details.stoppedAt === local!.updatedAt)
        if (clockShape(local) !== clockShape(before.entry) && !automaticClose) throw conflict()
      }
      if (local.source !== 'clock') throw conflict()
    }
    const candidate = local ? preservePrecision(remote.entry, local) : remote.entry
    const from = Date.parse(candidate.startedAt), to = candidate.stoppedAt ? Date.parse(candidate.stoppedAt) : Infinity
    if (own.some(entry => entry.id !== local?.id && Date.parse(entry.startedAt) < to && (entry.stoppedAt ? Date.parse(entry.stoppedAt) : Infinity) > from)) throw conflict()
    const previous = local ? structuredClone(local) : null
    const next: TimeEntry = { ...(local ?? { id: randomUUID(), userId, source: 'clock', createdAt: now, note: 'Recorded in Zeitguru; synchronized into DCO.' }),
      ...candidate, stoppedAt: candidate.stoppedAt, updatedAt: now }
    if (next.note?.includes('Automatically clocked out after running for more than 13 hours. This entry counts as 0 hours until corrected.')) {
      next.note = next.note.replace('Automatically clocked out after running for more than 13 hours. This entry counts as 0 hours until corrected.', 'Automatic DCO clock-out replaced by recorded Zeitguru times.')
    }
    if (local) Object.assign(local, next)
    else { database.timeEntries.push(next); own.push(next) }
    updates.push({ localEntryId: next.id, row: JSON.parse(JSON.stringify(remote.row)) as ZeitguruJsonRecord })
    addAudit(database, userId, 'zeitguru_clock_synchronized', 'time_entry', next.id, { providerRowId: remote.row.id, previous, observed: next })
  }
  // An unlinked local running shift cannot be silently replaced or ended.
  if (connect && own.some(entry => !entry.stoppedAt && !updates.some(update => update.localEntryId === entry.id) && !checkpoints.some(point => point.localEntryId === entry.id))) throw conflict()
  if (!updates.length && !connect) return false
  writeDatabaseAtomically(database, (tx, persist) => {
    if (connect) journal.connect(connect, tx)
    journal.saveObservedRows(tx, userId, generation, revision, updates)
    persist()
  })
  return updates.length > 0
}
