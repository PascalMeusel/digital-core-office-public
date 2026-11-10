export interface ZeitguruHistoryBatch {
  id: string
  createdAt: number
  fromDate: string
  toDate: string
  added: number
  duplicates: number
  conflicts: number
  skipped: number
  warnings: string[]
  canUndo: boolean
  undone: boolean
  fingerprint: string
}

export interface ZeitguruHistoryStatus {
  accounting?: ZeitguruAccountingContext
  available: true
  connected: boolean
  canImport: boolean
  generation: number
  importing?: boolean
  totalRecords: number
  totalWorkedMinutes: number
  totalCreditedMinutes: number
  uncreditedRecords: number
  firstDate?: string
  lastDate?: string
  lastImport?: ZeitguruHistoryBatch
}

export interface ZeitguruHistoryRow {
  id: string
  date: string
  startedAt: string
  stoppedAt: string
  startTime: string
  endTime: string
  breakMinutes: number
  workedMinutes: number
  creditedMinutes: number | null
  approved: boolean | null
  branchName?: string
}

export interface ZeitguruHistoryPage {
  status: ZeitguruHistoryStatus
  rows: ZeitguruHistoryRow[]
  nextCursor?: string
}

export interface ZeitguruHistoryResult {
  status: ZeitguruHistoryStatus
  batch: ZeitguruHistoryBatch
}

export interface ZeitguruHistoryApi {
  loadHistory: (query?: { cursor?: string; limit?: number; fromDate?: string; toDate?: string }) => Promise<ZeitguruHistoryPage>
  importHistory: (body: { clientRequestId: string; expectedGeneration: number; challengeId?: string }) => Promise<ZeitguruHistoryResult>
  undoHistory: (body: { batchId: string; expectedFingerprint: string }) => Promise<ZeitguruHistoryResult>
}
import type { ZeitguruAccountingContext } from './timeAccounting.ts'
