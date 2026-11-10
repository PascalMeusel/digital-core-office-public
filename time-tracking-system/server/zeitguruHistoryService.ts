import type { ZeitguruHistoryPage, ZeitguruHistoryStatus } from '../shared/zeitguruHistory.ts'
import { ZeitguruClient, ZeitguruClientError, type ZeitguruTokens } from './zeitguruClient.ts'
import { zeitguruAddDays, zeitguruWallTime, type ZeitguruBinding } from './zeitguruProtocol.ts'
import { readZeitguruHistory } from './zeitguruHistoryProvider.ts'
import { readZeitguruAccounting } from './zeitguruAccountingProvider.ts'
import { ZeitguruAccountingStore } from './zeitguruAccountingStore.ts'
import type { TimeEntry } from '../shared/domain.ts'
import { ZeitguruHistoryStore } from './zeitguruHistoryStore.ts'
import { ZeitguruBridgeError, ZeitguruService } from './zeitguruService.ts'

const invalid = () => new ZeitguruBridgeError('invalid_input', 'Invalid Zeitguru history request.', 400)
function identifier(value: unknown) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw invalid(); return value }

/** Orchestrates an explicit, read-only provider pull and a separate local archive transaction. */
export class ZeitguruHistoryService {
  readonly store: ZeitguruHistoryStore
  private readonly bridge: ZeitguruService
  private readonly client: ZeitguruClient
  private readonly reader: typeof readZeitguruHistory
  private readonly accountingReader: typeof readZeitguruAccounting
  private readonly accountingStore?: ZeitguruAccountingStore
  private readonly nativeEntries: () => TimeEntry[]
  private readonly now: () => number
  private readonly busy = new Set<string>()
  constructor(store: ZeitguruHistoryStore, bridge: ZeitguruService, options: { client?: ZeitguruClient; reader?: typeof readZeitguruHistory; accountingReader?: typeof readZeitguruAccounting; accountingStore?: ZeitguruAccountingStore; nativeEntries?: () => TimeEntry[]; now?: () => number } = {}) {
    this.store = store; this.bridge = bridge; this.client = options.client ?? new ZeitguruClient()
    this.reader = options.reader ?? readZeitguruHistory; this.now = options.now ?? Date.now
    this.accountingReader = options.accountingReader ?? readZeitguruAccounting
    this.accountingStore = options.accountingStore; this.nativeEntries = options.nativeEntries ?? (() => [])
  }
  status(userId: string): ZeitguruHistoryStatus {
    const connection = this.bridge.journal.status(userId)
    return { available: true, connected: connection.enabled, canImport: connection.enabled, generation: connection.generation, importing: this.busy.has(userId), ...this.store.status(userId), accounting: this.accountingStore?.projection(userId, this.nativeEntries()).accounting }
  }
  page(userId: string, options: { cursor?: string; limit?: number; fromDate?: string; toDate?: string } = {}): ZeitguruHistoryPage {
    return { status: this.status(userId), ...this.store.listHistory(userId, options) }
  }
  async importHistory(userId: string, body: { clientRequestId?: unknown; expectedGeneration?: unknown; challengeId?: unknown }) {
    const clientRequestId = identifier(body.clientRequestId)
    if (!Number.isSafeInteger(body.expectedGeneration) || Number(body.expectedGeneration) < 0) throw invalid()
    const expectedGeneration = Number(body.expectedGeneration)
    const challengeId = body.challengeId === undefined ? undefined : identifier(body.challengeId)
    const previous = this.store.batchForRequest(userId, clientRequestId)
    if (previous) return { batch: previous, status: this.status(userId) }
    if (this.busy.has(userId)) throw new ZeitguruBridgeError('history_busy', 'Your Zeitguru history is already being imported. Please wait.')
    this.busy.add(userId)
    try {
      return await this.bridge.withHistoryAccount(userId, expectedGeneration, challengeId, async (connection, assertCurrent) => {
        const throughDate = zeitguruAddDays(zeitguruWallTime(this.now()).date, -1)
        const history = await this.reader(this.client, connection.auth as unknown as ZeitguruTokens, connection.config.binding as unknown as ZeitguruBinding, throughDate).catch((error: unknown) => {
          if (error instanceof ZeitguruClientError) {
            if (error.code === 'history_limit_exceeded') throw new ZeitguruBridgeError('history_limit_exceeded', 'This history exceeds the import limit. Ask your DCO administrator to plan the migration; no records were imported.')
            if (error.code === 'authentication_required') throw new ZeitguruBridgeError('authentication_required', 'Verify your Zeitguru access again before importing history.', 401)
            throw new ZeitguruBridgeError('history_read_failed', 'Zeitguru history could not be read completely. No records were imported. Please try again later.', 502)
          }
          throw error
        })
        const accounting = history.fromDate ? await this.accountingReader(this.client, connection.auth as unknown as ZeitguruTokens, connection.config.binding as unknown as ZeitguruBinding, { fromDate: history.fromDate, toDate: history.toDate }).catch((error: unknown) => {
          if (error instanceof ZeitguruClientError) throw new ZeitguruBridgeError('history_read_failed', 'Zeitguru accounting could not be read completely. No records were imported. Please try again later.', 502)
          throw error
        }) : undefined
        if (accounting) accounting.details.historyReviewDays = history.reviewDays ?? []
        assertCurrent()
        const result = this.store.importBatch({ userId, providerKey: connection.providerKey, expectedGeneration, clientRequestId,
          fromDate: history.fromDate ?? throughDate, toDate: history.toDate, rows: history.rows,
          skipped: { count: history.skipped.count, reasons: [...history.skipped.reasons, ...history.warnings] },
          accounting,
        })
        return { batch: result.batch, status: this.status(userId) }
      })
    } finally { this.busy.delete(userId) }
  }
  undo(userId: string, body: { batchId?: unknown; expectedFingerprint?: unknown }) {
    if (this.busy.has(userId)) throw new ZeitguruBridgeError('history_busy', 'Wait until the history import has finished before undoing it.')
    const result = this.store.undoBatch(userId, identifier(body.batchId), identifier(body.expectedFingerprint))
    return { batch: result.batch, status: this.status(userId) }
  }
}
