import { readDatabase } from '../server/store.ts'

// Run with the deployment's TIME_TRACKER_DATA and encryption key configured.
// This report deliberately does not guess whether old manual balance adjustments
// already compensated for the previous approval-accounting behavior.
const database = readDatabase()
const legacy = database.requests.filter((request) => request.status === 'approved' && (request.type === 'overtime_payout' || request.type === 'overtime_time_off') && request.balanceEffects === undefined)
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  requiresReconciliation: legacy.length > 0,
  requests: legacy.map((request) => {
    const user = database.users.find((candidate) => candidate.id === request.userId)
    return { requestId: request.id, userId: request.userId, employee: user?.name, type: request.type, minutes: request.minutes, startDate: request.startDate, endDate: request.endDate, approvedAt: request.decidedAt, currentManualBalanceAdjustmentMinutes: user?.balanceAdjustmentMinutes }
  }),
  nextStep: 'Compare these approvals with payroll and manual adjustments. To reapply a verified approval, undo it and create/approve its replacement; reconcile any manual balance adjustment explicitly. Do not automatically reapply previously settled payouts.',
}, null, 2))
