import type { ZeitguruHistoryApi } from './zeitguruHistory.ts'

export type ZeitguruAction = 'start_work' | 'start_break' | 'stop_break' | 'stop_work'

export type ZeitguruOperationStatus =
  | 'queued'
  | 'sending'
  | 'confirmed'
  | 'retryable_failure'
  | 'reconciliation_required'
  | 'authentication_required'
  | 'cancelled'

export interface ZeitguruOperationSummary {
  id: string
  clientOperationId: string
  action: ZeitguruAction
  status: ZeitguruOperationStatus
  updatedAt: number
  acknowledgement?: { confirmedAt: number }
  errorCode?: string
}

export interface ZeitguruStatus {
  available: true
  enabled: boolean
  generation: number
  clockRevision: number
  requiresAttention: boolean
  counts: Record<ZeitguruOperationStatus, number>
  latestOperation?: ZeitguruOperationSummary
  attentionOperation?: ZeitguruOperationSummary
  identity?: { name: string; email: string; branchName: string }
  message?: string
  synchronization?: { checkedAt: number; error?: string }
}

export interface ZeitguruLoginChallenge {
  challengeId: string
  expiresAt: number
  identity: { name: string; email: string }
  branches: { id: string; name: string }[]
  remoteStatus: 'off_work' | 'working' | 'on_break'
  canActivate: boolean
}

export interface ZeitguruApi extends ZeitguruHistoryApi {
  synchronize?: () => Promise<ZeitguruStatus>
  login: (body: { email: string; password: string }) => Promise<ZeitguruLoginChallenge>
  connect: (body: { challengeId: string; branchId: string; consent: true; expectedGeneration: number }) => Promise<ZeitguruStatus>
  disconnect: (body: { expectedGeneration: number }) => Promise<ZeitguruStatus>
  reconcile: (body: { operationId: string }) => Promise<ZeitguruStatus>
  acknowledgeReview: (body: { expectedGeneration: number; reviewed: true }) => Promise<ZeitguruStatus>
}
