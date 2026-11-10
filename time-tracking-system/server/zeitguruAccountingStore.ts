import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AbsenceDay, Holiday, TimeEntry } from '../shared/domain.ts'
import type { ZeitguruAccountingReport } from '../shared/zeitguruAccounting.ts'
import type { ZeitguruAccountingContext, ZeitguruAccountingPublicDay } from '../shared/timeAccounting.ts'
import { accountingEntryWorkedMinutes } from '../shared/timeAccounting.ts'
import { addDays, isValidDateKey } from '../shared/dates.ts'
import { dataEncryptionEnabled, decryptText, encryptText, isEncryptedText } from './fieldCrypto.ts'
import type { ZeitguruHistoryInputRow } from './zeitguruHistoryStore.ts'
import { classifyLegacyAbsence } from './zeitguruLegacyAbsence.ts'
import { zeitguruEvaluationEnabled } from './zeitguruConfig.ts'
import { planImportReconstruction } from './zeitguruImportReconstruction.ts'

export class ZeitguruAccountingError extends Error {
  readonly status: number; readonly code: string
  constructor(code = 'invalid_accounting', status = 400) { super('Zeitguru accounting evidence is invalid or changed. Reload before continuing.'); this.name = 'ZeitguruAccountingError'; this.code = code; this.status = status }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function encrypted(value: unknown) {
  if (!dataEncryptionEnabled()) throw new ZeitguruAccountingError('accounting_encryption_required', 503)
  const cipher = encryptText(JSON.stringify(value))
  if (!isEncryptedText(cipher)) throw new ZeitguruAccountingError('accounting_encryption_required', 503)
  return cipher!
}
function decrypted<T>(value: string): T {
  try { if (!dataEncryptionEnabled() || !isEncryptedText(value)) throw new Error(); return JSON.parse(decryptText(value)!) as T }
  catch { throw new ZeitguruAccountingError('accounting_encryption_required', 503) }
}
function validDate(value: unknown): value is string { return typeof value === 'string' && isValidDateKey(value) && value >= '2000-01-01' }
function finite(value: unknown, max = 100_000_000): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max }
function validate(report: ZeitguruAccountingReport) {
  if (!report || !validDate(report.fromDate) || !validDate(report.toDate) || report.fromDate > report.toDate || !Array.isArray(report.days) || !report.days.length || report.days.length > 10_000 || !Array.isArray(report.forecast) || report.forecast.length > 800 || !Array.isArray(report.warnings) || report.warnings.length > 100 || !Array.isArray(report.contracts) || report.contracts.length > 500 || !finite(report.openingBalanceMinutes) || !finite(report.closingBalanceMinutes) || !Number.isFinite(Date.parse(report.observedAt)) || typeof report.openingKnown !== 'boolean' || !['source_opening', 'period_delta'].includes(report.balanceBasis)) throw new ZeitguruAccountingError()
  if (report.openingKnown !== (report.balanceBasis === 'source_opening')) throw new ZeitguruAccountingError()
  if (!report.openingKnown && report.openingBalanceMinutes !== 0) throw new ZeitguruAccountingError()
  let date = report.fromDate, balance = report.openingBalanceMinutes
  for (const day of report.days) {
    if (day.date !== date || day.date > report.toDate) throw new ZeitguruAccountingError()
    for (const key of ['expectedMinutes','workedMinutes','absenceMinutes','holidayMinutes','correctionMinutes','creditedMinutes','balanceMinutes','exactDeltaMinutes'] as const) if (!finite(day[key])) throw new ZeitguruAccountingError()
    if (day.expectedMinutes < 0 || day.workedMinutes < 0 || Math.abs(day.exactDeltaMinutes - (day.creditedMinutes - day.expectedMinutes)) > 0.01) throw new ZeitguruAccountingError()
    balance += day.exactDeltaMinutes
    if (Math.abs(Math.round(balance) - day.balanceMinutes) > 1) throw new ZeitguruAccountingError()
    date = addDays(date, 1)
  }
  if (report.days.at(-1)!.date !== report.toDate || Math.abs(Math.round(balance) - report.closingBalanceMinutes) > 1) throw new ZeitguruAccountingError()
  let previous = report.toDate
  for (const day of report.forecast) { if (!validDate(day.date) || day.date <= previous || !finite(day.expectedMinutes, 1440) || day.expectedMinutes < 0) throw new ZeitguruAccountingError(); previous = day.date }
  // Enforce serializable finite evidence before writing. JSON would otherwise silently turn NaN into null.
  const seen = new Set<object>()
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 30) throw new ZeitguruAccountingError()
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object' || seen.has(value)) throw new ZeitguruAccountingError()
    seen.add(value); for (const item of Object.values(value)) visit(item, depth + 1); seen.delete(value)
  }
  visit(report)
  if (Buffer.byteLength(JSON.stringify(report)) > 32 * 1024 * 1024) throw new ZeitguruAccountingError()
}

export function initializeZeitguruAccounting(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS zeitguru_accounting_snapshots (
    batchId TEXT PRIMARY KEY,userId TEXT NOT NULL,providerHash TEXT NOT NULL,snapshotCipher TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS zeitguru_accounting_user ON zeitguru_accounting_snapshots(userId);`)
}
/** Called only inside the history insertion transaction, after its batch exists. */
export function saveZeitguruAccountingSnapshot(sql: DatabaseSync, input: { userId: string; batchId: string; providerKey: string; report: ZeitguruAccountingReport; conflictDates?: string[] }) {
  if (!sql.isTransaction) throw new ZeitguruAccountingError('accounting_transaction_required', 409)
  validate(input.report)
  const batch = sql.prepare('SELECT userId,undoneAt FROM zeitguru_history_batches WHERE id=?').get(input.batchId)
  if (!batch || batch.userId !== input.userId || batch.undoneAt !== null) throw new ZeitguruAccountingError('accounting_batch_changed', 409)
  sql.prepare('INSERT INTO zeitguru_accounting_snapshots(batchId,userId,providerHash,snapshotCipher) VALUES(?,?,?,?)')
    .run(input.batchId, input.userId, hash(input.providerKey), encrypted({ providerKey: input.providerKey, report: input.report, conflictDates: [...new Set(input.conflictDates ?? [])] }))
}
export function hasZeitguruAccountingSnapshot(sql: DatabaseSync, batchId: string) { return Boolean(sql.prepare('SELECT 1 FROM zeitguru_accounting_snapshots WHERE batchId=?').get(batchId)) }
export function newerZeitguruAccountingSnapshot(sql: DatabaseSync, userId: string, createdAt: number) {
  return Boolean(sql.prepare('SELECT 1 FROM zeitguru_accounting_snapshots s JOIN zeitguru_history_batches b ON b.id=s.batchId WHERE s.userId=? AND b.undoneAt IS NULL AND b.createdAt>? LIMIT 1').get(userId, createdAt))
}
interface Snapshot { providerKey: string; report: ZeitguruAccountingReport; conflictDates: string[] }
const warningCode = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'source_accounting_review'

/** Derived overlay only. Native entries, user profiles and source archive evidence remain immutable. */
export class ZeitguruAccountingStore {
  private readonly sql: DatabaseSync
  private readonly options: { legacyVacationRule?: boolean; inputs?: (fromDate:string,toDate:string)=>{absences:AbsenceDay[];holidays:Holiday[]} }
  constructor(path: string, options: { legacyVacationRule?: boolean; inputs?: (fromDate:string,toDate:string)=>{absences:AbsenceDay[];holidays:Holiday[]} } = {}) { this.options=options;this.sql = new DatabaseSync(resolve(path)); this.sql.exec('PRAGMA busy_timeout=5000'); initializeZeitguruAccounting(this.sql) }
  close() { this.sql.close() }
  projection(userId: string, nativeEntries: TimeEntry[] = []): { entries: TimeEntry[]; accounting?: ZeitguruAccountingContext } {
    const batch = this.sql.prepare('SELECT s.*,b.createdAt FROM zeitguru_accounting_snapshots s JOIN zeitguru_history_batches b ON b.id=s.batchId WHERE s.userId=? AND b.undoneAt IS NULL ORDER BY b.createdAt DESC,b.id DESC LIMIT 1').get(userId)
    if (!batch) return { entries: [] }
    const { providerKey, report, conflictDates } = decrypted<Snapshot>(String(batch.snapshotCipher))
    const inputs=this.options.inputs?.(report.fromDate,report.toDate)??{absences:[],holidays:[]}
    const warnings: ZeitguruAccountingContext['warnings'] = [
      ...report.warnings.map(code => ({ date: report.toDate, code: warningCode(code) })),
      ...conflictDates.map(date => ({ date, code: 'source_clock_conflict' })),
      ...(!report.openingKnown ? [{ date: report.fromDate, code: 'source_opening_missing' }] : []),
    ]
    const reviewDays = report.details.historyReviewDays
    if (Array.isArray(reviewDays)) for (const value of reviewDays.slice(0, 100_000)) {
      if (value && typeof value === 'object' && validDate(value.date) && value.date >= report.fromDate && value.date <= report.toDate) warnings.push({ date: value.date, code: warningCode(value.reason) })
    }
    const ownNative = nativeEntries.filter(entry => entry.userId === userId && entry.source !== 'zeitguru')
    const checkpoints = new Map<string, string>()
    if (this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zeitguru_row_checkpoints'").get()) {
      for (const row of this.sql.prepare('SELECT localEntryId,rowCipher FROM zeitguru_row_checkpoints WHERE userId=? AND providerKey=?').all(userId, hash(providerKey))) {
        const remote = decrypted<{ id?: string }>(String(row.rowCipher)); if (remote.id) checkpoints.set(String(row.localEntryId), remote.id)
      }
    }
    const archived = this.sql.prepare('SELECT id,identityKey,recordCipher,batchId FROM zeitguru_history_rows WHERE userId=? AND date>=? AND date<=? ORDER BY date,startEpoch,id').all(userId, report.fromDate, report.toDate)
      .map(row => ({ row, value: decrypted<ZeitguruHistoryInputRow>(String(row.recordCipher)) }))
      .filter(({ row, value }) => row.identityKey === hash(`${providerKey}\0${value.sourceId}`))
    const entries: TimeEntry[] = [], correctionDates = new Set(ownNative.filter(entry => entry.source === 'approved_correction').map(entry => entry.date))
    const automaticRows = archived.filter(({ value }) => (value.details.rawRow as Record<string, unknown> | undefined)?.isAutoClockOut === true)
    const approvedAutomaticDates = new Set(automaticRows.filter(({ value }) => value.approved === true).map(({ value }) => value.date))
    for (const { value } of automaticRows) if (value.approved !== true) approvedAutomaticDates.delete(value.date)
    for (const date of conflictDates) approvedAutomaticDates.delete(date)
    const classifications=new Map<string,NonNullable<ZeitguruAccountingPublicDay['importClassification']>>()
    if(this.options.legacyVacationRule??zeitguruEvaluationEnabled())for(const day of report.days){
      if(conflictDates.includes(day.date)||warnings.some(warning=>warning.date===day.date))continue
      const classification=classifyLegacyAbsence(day,archived.filter(item=>item.value.date===day.date).map(item=>item.value),ownNative,inputs.holidays)
      if(classification)classifications.set(day.date,classification)
    }
    const matched = new Set<string>(), uncertain = new Set<string>()
    for (const { row, value } of archived) {
      if(classifications.has(value.date))continue
      if (value.approved !== true) warnings.push({ date: value.date, code: value.approved === false ? 'source_clock_unapproved' : 'source_clock_approval_unknown' })
      if (value.creditedMinutes === null) warnings.push({ date: value.date, code: 'source_clock_credit_unknown' })
      if (value.details.rawRow && typeof value.details.rawRow === 'object' && (value.details.rawRow as Record<string, unknown>).isAutoClockOut === true) warnings.push({ date: value.date, code: 'source_automatic_clock_out' })
      if (correctionDates.has(value.date)) continue
      const mirror = ownNative.find(entry => checkpoints.get(entry.id) === value.sourceId)
      if (mirror) {
        matched.add(mirror.id)
        if (Date.parse(mirror.startedAt) !== Date.parse(value.startedAt) || !mirror.stoppedAt || Date.parse(mirror.stoppedAt) !== Date.parse(value.stoppedAt) || accountingEntryWorkedMinutes(mirror) !== value.workedMinutes) warnings.push({ date: value.date, code: 'native_mirror_changed' })
        continue
      }
      const overlap = ownNative.filter(entry => Date.parse(entry.startedAt) < Date.parse(value.stoppedAt) && (!entry.stoppedAt || Date.parse(entry.stoppedAt) > Date.parse(value.startedAt)))
      if (overlap.length) { for (const entry of overlap) uncertain.add(entry.id); warnings.push({ date: value.date, code: 'native_source_overlap' }); continue }
      entries.push({ id: `zeitguru-${String(row.id)}`, userId, date: value.date, startedAt: value.startedAt, stoppedAt: value.stoppedAt,
        breaks: [], manualBreakMinutes: value.breakMinutes, source: 'zeitguru', importBatchId: String(row.batchId),
        createdAt: report.observedAt, updatedAt: report.observedAt,
        zeitguru: { workedMinutes: value.workedMinutes, creditedMinutes: value.creditedMinutes, approved: value.approved, readOnly: true, batchId: String(row.batchId) },
      })
    }
    const days: ZeitguruAccountingPublicDay[] = report.days.map(({ details: _details, ...day }) => {
      const native = ownNative.filter(entry => entry.date === day.date && entry.stoppedAt)
      const physical = [...native, ...entries.filter(entry => entry.date === day.date)]
      const actualWorkedMinutes = physical.reduce((sum, entry) => sum + accountingEntryWorkedMinutes(entry), 0)
      const actualBreakMinutes = physical.reduce((sum, entry) => sum + (entry.manualBreakMinutes ?? 0) + entry.breaks.reduce((minutes, segment) => minutes + (segment.stoppedAt ? Math.max(0, (Date.parse(segment.stoppedAt) - Date.parse(segment.startedAt)) / 60_000) : 0), 0), 0)
      const publicDay = { ...day, actualWorkedMinutes, actualBreakMinutes, ...(approvedAutomaticDates.has(day.date) ? { approvedAutomaticClockOut: true } : {}) }
      const classification=classifications.get(day.date)
      if(classification){
        const holiday=classification.type==='holiday',source=classification.basis==='source_absence'
        return{...publicDay,importClassification:classification,workedMinutes:0,
          absence:source?day.absence:{typeCode:classification.type,typeName:holiday?'Feiertag / Holiday':classification.type==='illness'?'Krankheit / Sick leave':'Urlaub / Vacation',startsHalfDay:false,endsHalfDay:false},
          absenceMinutes:holiday?0:day.absenceMinutes+(source?0:day.workedMinutes),holidayMinutes:day.holidayMinutes+(holiday?day.workedMinutes+day.absenceMinutes:0)}
      }
      if (correctionDates.has(day.date)) {
        const worked = native.reduce((sum, entry) => sum + accountingEntryWorkedMinutes(entry), 0), difference = worked - day.workedMinutes
        warnings.push({ date: day.date, code: 'native_correction_overrides_source' })
        return { ...publicDay, workedMinutes: worked, creditedMinutes: day.creditedMinutes + difference, exactDeltaMinutes: day.exactDeltaMinutes + difference }
      }
      const extra = native.filter(entry => !matched.has(entry.id) && !uncertain.has(entry.id)).reduce((sum, entry) => sum + accountingEntryWorkedMinutes(entry), 0)
      const localAbsence=inputs.absences.find(absence=>absence.userId===userId&&absence.date===day.date&&absence.type==='vacation')
      if(localAbsence&&!day.absence){
        if(actualWorkedMinutes>0||day.workedMinutes>0)warnings.push({date:day.date,code:'native_absence_work_conflict'})
        else {
          const credit=Math.max(0,day.expectedMinutes-day.absenceMinutes-day.holidayMinutes)
          return{...publicDay,localAbsenceApplied:true,absence:{typeCode:'vacation',typeName:'Urlaub / Vacation · DCO',startsHalfDay:false,endsHalfDay:false},absenceMinutes:day.absenceMinutes+credit,creditedMinutes:day.creditedMinutes+credit,exactDeltaMinutes:day.exactDeltaMinutes+credit}
        }
      }
      return extra ? { ...publicDay, workedMinutes: day.workedMinutes + extra, creditedMinutes: day.creditedMinutes + extra, exactDeltaMinutes: day.exactDeltaMinutes + extra } : publicDay
    })
    let balance = report.openingBalanceMinutes
    for (const day of days) { balance += day.exactDeltaMinutes; day.balanceMinutes = Math.round(balance) }
    const accounting: ZeitguruAccountingContext = { batchId: String(batch.batchId), fromDate: report.fromDate, toDate: report.toDate, observedAt: report.observedAt,
      openingKnown: report.openingKnown, balanceBasis: report.balanceBasis, openingBalanceMinutes: report.openingBalanceMinutes, closingBalanceMinutes: Math.round(balance),
      days, forecast: report.forecast.map(day => ({ date: day.date, expectedMinutes: day.expectedMinutes })),
      // Approval resolves the automatic-end warning, not independent discrepancies.
      // Normalize the provider and archive aliases so an unresolved end appears once.
      warnings: [...new Map(warnings.flatMap(warning => {
        if (warning.code === 'automatic_clock_out' || warning.code === 'source_automatic_clock_out') {
          if (approvedAutomaticDates.has(warning.date)) return []
          warning = { ...warning, code: 'source_automatic_clock_out' }
        }
        return [[`${warning.date}:${warning.code}`, warning] as const]
      })).values()],
    }
    if (this.options.legacyVacationRule ?? zeitguruEvaluationEnabled()) {
      // Keep the first import's cutoff, including after undo/reimport. Later clocking
      // imports must not acquire the migration exception merely because they are imported.
      const first = this.sql.prepare('SELECT s.snapshotCipher FROM zeitguru_accounting_snapshots s JOIN zeitguru_history_batches b ON b.id=s.batchId WHERE s.userId=? ORDER BY b.createdAt,b.rowid LIMIT 1').get(userId)
      const throughDate = first ? decrypted<Snapshot>(String(first.snapshotCipher)).report.toDate : report.toDate
      const baseline = archived.map(({ row, value }) => ({ id: `zeitguru-${String(row.id)}`, userId, date: value.date, startedAt: value.startedAt, stoppedAt: value.stoppedAt,
        breaks: [], manualBreakMinutes: value.breakMinutes, source: 'zeitguru' as const, createdAt: report.observedAt, updatedAt: report.observedAt,
        zeitguru: { workedMinutes: value.workedMinutes, creditedMinutes: value.creditedMinutes, approved: value.approved, readOnly: true as const, batchId: String(row.batchId) } }))
      const baselineDays = report.days.map(day => {
        const classification = classifyLegacyAbsence(day, archived.filter(item=>item.value.date===day.date).map(item=>item.value), [], inputs.holidays)
        return classification ? { ...day, importClassification: classification } : day
      })
      accounting.initialImportReconstruction = planImportReconstruction({ throughDate, days: baselineDays, entries: baseline, native: ownNative, holidays: inputs.holidays,
        absences: inputs.absences.filter(absence=>absence.userId===userId), uncertainDates: accounting.warnings.filter(warning=>warning.code!=='native_correction_overrides_source').map(warning=>warning.date) })
    }
    return { entries, accounting }
  }
}
