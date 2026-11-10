import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { decryptText, encryptText } from './fieldCrypto.ts'
import { defaultOvertimePolicy, overtimeBreach, type OvertimePolicy } from '../shared/overtimePolicy.ts'

export class OvertimePolicyError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message);this.status=status }
}
export interface OvertimeObservation { userId: string; scope: 'balance' | 'day'; date: string; minutes: number; provisional: boolean; name: string }
interface AlertPayload { recipientId: string; observation: OvertimeObservation; side: 'over' | 'under'; limit: number; revision: number }
const pack = (value: unknown) => encryptText(JSON.stringify(value))!
const unpack = <T>(value: unknown) => JSON.parse(decryptText(String(value))!) as T
export class OvertimePolicyStore {
  private sql: DatabaseSync
  constructor(path: string) {
    this.sql = new DatabaseSync(path)
    this.sql.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS overtime_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,valueCipher TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overtime_alert_states(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,side TEXT NOT NULL,episode INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS overtime_alerts(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,recipientId TEXT NOT NULL,status TEXT NOT NULL,payloadCipher TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overtime_policy_audit(id TEXT PRIMARY KEY,actorId TEXT NOT NULL,createdAt TEXT NOT NULL,valueCipher TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS overtime_alert_status ON overtime_alerts(status,createdAt);`)
  }
  close() { this.sql.close() }
  policy(): OvertimePolicy { const row = this.sql.prepare('SELECT valueCipher FROM overtime_settings WHERE id=1').get(); return row ? unpack(row.valueCipher) : structuredClone(defaultOvertimePolicy) }
  status() {
    const alerts = { pending: 0, sent: 0, failed: 0, unknown: 0 }
    for (const row of this.sql.prepare('SELECT status,COUNT(*) count FROM overtime_alerts GROUP BY status').all()) {
      const status = String(row.status); if (status in alerts) alerts[status as keyof typeof alerts] = Number(row.count)
      if (status === 'sending') alerts.pending += Number(row.count)
    }
    return { policy: this.policy(), alerts }
  }
  save(body: Record<string, unknown>, actorId: string, adminIds: Set<string>, mailConfigured: boolean, now = new Date()) {
    const current = this.policy()
    if (body.revision !== current.revision) throw new OvertimePolicyError('The policy changed. Reload before saving.', 409)
    if (typeof body.overtimeAllowed !== 'boolean' || typeof body.emailEnabled !== 'boolean' || !['balance','day','both'].includes(String(body.scope))) throw new OvertimePolicyError('Choose valid overtime and alert settings.')
    const limit = (key: string) => { const value = body[key]; if (value === null) return null; if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 5_256_000) throw new OvertimePolicyError('Limits must be non-negative whole minutes, or empty for no limit.'); return Number(value) }
    if (!Array.isArray(body.recipientUserIds) || body.recipientUserIds.length > 100 || body.recipientUserIds.some(id => typeof id !== 'string' || !adminIds.has(id))) throw new OvertimePolicyError('Select active administrators as email recipients.')
    const policy: OvertimePolicy = { revision: current.revision + 1, configured: true, overtimeAllowed: body.overtimeAllowed, emailEnabled: body.emailEnabled,
      scope: body.scope as OvertimePolicy['scope'], balanceOvertimeMinutes: limit('balanceOvertimeMinutes'), balanceUndertimeMinutes: limit('balanceUndertimeMinutes'),
      dailyOvertimeMinutes: limit('dailyOvertimeMinutes'), dailyUndertimeMinutes: limit('dailyUndertimeMinutes'), recipientUserIds: [...new Set(body.recipientUserIds as string[])], updatedAt: now.toISOString(), updatedBy: actorId }
    if (policy.emailEnabled && (!mailConfigured || !policy.recipientUserIds.length)) throw new OvertimePolicyError('Configure SMTP and select at least one administrator before enabling email alerts.')
    if (policy.emailEnabled && policy.overtimeAllowed && (policy.scope === 'day' || policy.balanceOvertimeMinutes === null && policy.balanceUndertimeMinutes === null) && (policy.scope === 'balance' || policy.dailyOvertimeMinutes === null && policy.dailyUndertimeMinutes === null)) throw new OvertimePolicyError('Set at least one limit before enabling alerts.')
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      if (this.policy().revision !== current.revision) throw new OvertimePolicyError('The policy changed. Reload before saving.', 409)
      this.sql.prepare('INSERT INTO overtime_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,valueCipher=excluded.valueCipher').run(policy.revision,pack(policy))
      this.sql.prepare("UPDATE overtime_alerts SET status='cancelled',updatedAt=? WHERE status='pending'").run(now.toISOString())
      this.sql.prepare('INSERT INTO overtime_policy_audit VALUES(?,?,?,?)').run(randomUUID(),actorId,now.toISOString(),pack(policy))
      this.sql.exec('COMMIT');return policy
    } catch(error) { this.sql.exec('ROLLBACK');throw error }
  }
  observe(policy: OvertimePolicy, observations: OvertimeObservation[], now = new Date()) {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      if (this.policy().revision !== policy.revision) { this.sql.exec('ROLLBACK');return }
      for (const observation of observations) {
        const key = createHash('sha256').update(`${observation.userId}:${observation.scope}:${observation.scope==='day'?observation.date:'balance'}`).digest('hex')
        const side = overtimeBreach(policy,observation.scope,observation.minutes)
        const prior = this.sql.prepare('SELECT * FROM overtime_alert_states WHERE key=?').get(key)
        if (prior?.revision === policy.revision && prior.side === side) continue
        const episode = Number(prior?.episode ?? 0) + 1
        this.sql.prepare('INSERT INTO overtime_alert_states VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,side=excluded.side,episode=excluded.episode').run(key,policy.revision,side,episode)
        if (!policy.emailEnabled || side === 'within') continue
        const limit = side === 'over' ? policy.overtimeAllowed ? (observation.scope === 'balance' ? policy.balanceOvertimeMinutes : policy.dailyOvertimeMinutes)! : 0 : (observation.scope === 'balance' ? policy.balanceUndertimeMinutes : policy.dailyUndertimeMinutes)!
        for (const recipientId of policy.recipientUserIds) {
          const id = createHash('sha256').update(`${key}:${policy.revision}:${episode}:${recipientId}`).digest('hex')
          this.sql.prepare('INSERT OR IGNORE INTO overtime_alerts VALUES(?,?,?,?,?,?,?)').run(id,policy.revision,recipientId,'pending',pack({recipientId,observation,side,limit,revision:policy.revision} satisfies AlertPayload),now.toISOString(),now.toISOString())
        }
      }
      this.sql.exec('COMMIT')
    } catch(error) { this.sql.exec('ROLLBACK');throw error }
  }
  recover() { this.sql.prepare("UPDATE overtime_alerts SET status='unknown' WHERE status='sending'").run() }
  claim(activeAdminIds: Set<string>) {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const policy = this.policy()
      const rows = this.sql.prepare("SELECT * FROM overtime_alerts WHERE status='pending' ORDER BY createdAt,id LIMIT 100").all()
      for (const row of rows) {
        if (!policy.emailEnabled || row.revision !== policy.revision || !activeAdminIds.has(String(row.recipientId)) || !policy.recipientUserIds.includes(String(row.recipientId))) { this.sql.prepare("UPDATE overtime_alerts SET status='cancelled' WHERE id=?").run(row.id);continue }
        this.sql.prepare("UPDATE overtime_alerts SET status='sending' WHERE id=?").run(row.id)
        this.sql.exec('COMMIT');return { id: String(row.id), payload: unpack<AlertPayload>(row.payloadCipher) }
      }
      this.sql.exec('COMMIT');return undefined
    } catch(error) { this.sql.exec('ROLLBACK');throw error }
  }
  complete(id: string, status: 'sent' | 'failed' | 'unknown') { this.sql.prepare("UPDATE overtime_alerts SET status=?,updatedAt=? WHERE id=? AND status='sending'").run(status,new Date().toISOString(),id) }
  retryFailed() { this.sql.prepare("UPDATE overtime_alerts SET status='pending',updatedAt=? WHERE status='failed' AND revision=?").run(new Date().toISOString(),this.policy().revision) }
}
