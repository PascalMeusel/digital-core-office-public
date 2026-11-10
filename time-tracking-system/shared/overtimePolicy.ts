export interface OvertimePolicy {
  revision: number
  configured: boolean
  overtimeAllowed: boolean
  scope: 'balance' | 'day' | 'both'
  balanceOvertimeMinutes: number | null
  balanceUndertimeMinutes: number | null
  dailyOvertimeMinutes: number | null
  dailyUndertimeMinutes: number | null
  emailEnabled: boolean
  recipientUserIds: string[]
  updatedAt?: string
  updatedBy?: string
}
export interface OvertimePolicyState {
  policy: OvertimePolicy
  mailConfigured: boolean
  alerts: { pending: number; sent: number; failed: number; unknown: number }
}
export const defaultOvertimePolicy: OvertimePolicy = {
  revision: 0, configured: false, overtimeAllowed: true, scope: 'balance',
  balanceOvertimeMinutes: null, balanceUndertimeMinutes: null,
  dailyOvertimeMinutes: null, dailyUndertimeMinutes: null,
  emailEnabled: false, recipientUserIds: [],
}
export function overtimeBreach(policy: OvertimePolicy, scope: 'balance' | 'day', minutes: number): 'over' | 'under' | 'within' {
  if (!policy.configured || !Number.isFinite(minutes) || (policy.scope !== 'both' && policy.scope !== scope)) return 'within'
  const upper = policy.overtimeAllowed ? (scope === 'balance' ? policy.balanceOvertimeMinutes : policy.dailyOvertimeMinutes) : 0
  const lower = scope === 'balance' ? policy.balanceUndertimeMinutes : policy.dailyUndertimeMinutes
  return upper !== null && minutes > upper ? 'over' : lower !== null && minutes < -lower ? 'under' : 'within'
}
