import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataEncryptionEnabled, decryptText, encryptText, isEncryptedText } from './fieldCrypto.ts'
import type { ZeitguruAccountingReport } from '../shared/zeitguruAccounting.ts'
import { initializeZeitguruAccounting, saveZeitguruAccountingSnapshot, hasZeitguruAccountingSnapshot, newerZeitguruAccountingSnapshot, ZeitguruAccountingError } from './zeitguruAccountingStore.ts'

export interface ZeitguruHistoryInputRow {
  sourceId: string; date: string; startedAt: string; stoppedAt: string;
  breakMinutes: number; workedMinutes: number; creditedMinutes: number | null;
  approved: boolean | null; details: Record<string, unknown>;
  branchName?: string;
}
export interface ZeitguruHistoryRow {
  id: string; date: string; startedAt: string; stoppedAt: string; startTime: string; endTime: string;
  breakMinutes: number; workedMinutes: number; creditedMinutes: number | null; approved: boolean | null;
  branchName?: string;
}
export interface ZeitguruHistoryBatch {
  id: string; createdAt: number; fromDate: string; toDate: string;
  added: number; duplicates: number; conflicts: number; skipped: number; warnings: string[];
  fingerprint: string; canUndo: boolean; undone: boolean;
}
export interface ZeitguruHistoryStatus {
  totalRecords: number; totalWorkedMinutes: number; totalCreditedMinutes: number; uncreditedRecords: number;
  firstDate?: string; lastDate?: string; lastImport?: ZeitguruHistoryBatch;
}
export interface ZeitguruHistoryImport {
  userId: string; providerKey: string; expectedGeneration: number; clientRequestId: string;
  fromDate: string; toDate: string; rows: ZeitguruHistoryInputRow[];
  skipped?: { count: number; reasons?: string[] };
  accounting?: ZeitguruAccountingReport;
}
export class ZeitguruHistoryError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, status: number, message: string) { super(message);this.name='ZeitguruHistoryError';this.code=code;this.status=status }
}
const invalid=()=>new ZeitguruHistoryError('invalid_history',400,'The historical records or selected range are invalid.')
const changed=(code='history_conflict')=>new ZeitguruHistoryError(code,409,'The historical import or account changed. Reload before continuing.')
const encryptedRequired=()=>new ZeitguruHistoryError('history_encryption_required',503,'Encrypted history storage is unavailable.')
const unavailable=()=>new ZeitguruHistoryError('history_storage_unavailable',503,'Historical records could not be saved.')
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
function id(value:unknown):string { if(typeof value!=='string'||!value.trim()||value.length>512)throw invalid();return value }
function whole(value:unknown,max=Number.MAX_SAFE_INTEGER):number {if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>max)throw invalid();return Number(value)}
function date(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'2000-01-01')throw invalid()
  const parsed=new Date(`${value}T12:00:00Z`)
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw invalid()
  return value
}
const berlin=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
function wall(epoch:number) {
  const parts=berlin.formatToParts(new Date(epoch)),part=(kind:string)=>parts.find(value=>value.type===kind)!.value
  return {date:`${part('year')}-${part('month')}-${part('day')}`,time:`${part('hour')}:${part('minute')}`}
}
function canonical(value:unknown):string {
  const seen=new Set<object>()
  function ordered(item:unknown,depth:number):unknown {
    if(depth>25)throw invalid()
    if(item===null||typeof item==='string'||typeof item==='boolean')return item
    if(typeof item==='number'){if(!Number.isFinite(item))throw invalid();return item}
    if(typeof item!=='object'||seen.has(item))throw invalid()
    seen.add(item)
    try {
      if(Array.isArray(item))return item.map(value=>ordered(value,depth+1))
      if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw invalid()
      return Object.fromEntries(Object.keys(item).sort().map(key=>[key,ordered((item as Record<string,unknown>)[key],depth+1)]))
    } finally {seen.delete(item)}
  }
  return JSON.stringify(ordered(value,0))
}
function encrypt(value:unknown):string {
  const text=canonical(value)
  try {
    if(!dataEncryptionEnabled())throw encryptedRequired()
    const encrypted=encryptText(text)
    if(!isEncryptedText(encrypted))throw encryptedRequired()
    return encrypted!
  } catch {throw encryptedRequired()}
}
function decrypt<T>(value:string):T {
  try {
    if(!dataEncryptionEnabled()||!isEncryptedText(value))throw encryptedRequired()
    return JSON.parse(decryptText(value)!) as T
  } catch {throw encryptedRequired()}
}
interface StoredRow {id:string;userId:string;identityKey:string;sourceHash:string;date:string;startEpoch:number;stopEpoch:number;recordCipher:string;batchId:string}
interface StoredBatch {id:string;userId:string;clientRequestId:string;requestHash:string;fingerprint:string;batchCipher:string;manifestCipher:string;createdAt:number;undoneAt:number|null}
interface ManifestItem {id:string;sourceHash:string}
const reasonCodes=new Set([
  'open_entry','current_day','outside_range','invalid_row','missing_times','unsupported_time','invalid_break','missing_credit','unaccepted','duplicate_source','provider_omitted','provider_error',
  'invalid_history_date','invalid_history_row','ambiguous_daylight_saving_time','outside_history_range','unfinished_clock_row',
  'credit_prefix_collision','accepted_credit_missing','invalid_credit_data','additional_credit_components','credit_approval_mismatch','credit_duration_mismatch','unfinished_row_credit',
  'wall_clock_duration_differs_from_elapsed','break_exceeds_shift_duration','automatic_clock_out','not_approved','approval_unknown','unattributed_credit_data',
])

/** Source evidence stays separate from native records; optional accounting is a reversible derived overlay. */
export class ZeitguruHistoryStore {
  private readonly sql:DatabaseSync
  private readonly now:()=>number
  constructor(path:string,options:{now?:()=>number}={}) {
    this.now=options.now??Date.now
    try {
      this.sql=new DatabaseSync(resolve(path))
      this.sql.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS zeitguru_history_batches (
          id TEXT PRIMARY KEY,userId TEXT NOT NULL,clientRequestId TEXT NOT NULL,requestHash TEXT NOT NULL,
          fingerprint TEXT NOT NULL,batchCipher TEXT NOT NULL,manifestCipher TEXT NOT NULL,createdAt INTEGER NOT NULL,undoneAt INTEGER,
          UNIQUE(userId,clientRequestId)
        );
        CREATE TABLE IF NOT EXISTS zeitguru_history_rows (
          id TEXT PRIMARY KEY,userId TEXT NOT NULL,identityKey TEXT NOT NULL,sourceHash TEXT NOT NULL,date TEXT NOT NULL,
          startEpoch INTEGER NOT NULL,stopEpoch INTEGER NOT NULL,recordCipher TEXT NOT NULL,batchId TEXT NOT NULL,
          UNIQUE(userId,identityKey)
        );
        CREATE INDEX IF NOT EXISTS zeitguru_history_date ON zeitguru_history_rows(userId,date DESC,id DESC);
        CREATE INDEX IF NOT EXISTS zeitguru_history_overlap ON zeitguru_history_rows(userId,stopEpoch,startEpoch);
        CREATE INDEX IF NOT EXISTS zeitguru_history_imports ON zeitguru_history_batches(userId,createdAt DESC,id DESC);
      `)
      initializeZeitguruAccounting(this.sql)
    }catch{throw unavailable()}
  }
  close(){this.sql.close()}
  private transaction<T>(run:()=>T):T {
    try {
      this.sql.exec('BEGIN IMMEDIATE')
      try{const result=run();this.sql.exec('COMMIT');return result}catch(error){this.sql.exec('ROLLBACK');throw error}
    }catch(error){if(error instanceof ZeitguruHistoryError||error instanceof ZeitguruAccountingError)throw error;throw unavailable()}
  }
  private normalize(row:ZeitguruHistoryInputRow,from:string,to:string,today:string):ZeitguruHistoryInputRow {
    id(row?.sourceId);date(row?.date)
    if(typeof row.startedAt!=='string'||typeof row.stoppedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.startedAt)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.stoppedAt))throw invalid()
    const start=Date.parse(row.startedAt),stop=Date.parse(row.stoppedAt),elapsed=(stop-start)/60_000
    if(!Number.isFinite(start)||!Number.isFinite(stop)||stop<start||elapsed>36*60||wall(start).date!==row.date||wall(stop).date>=today||row.date<from||row.date>to)throw invalid()
    // Preserve the provider's wall-clock totals independently of UTC duration on DST days.
    const breakMinutes=whole(row.breakMinutes,36*60),workedMinutes=whole(row.workedMinutes,36*60)
    if(stop===start&&workedMinutes!==0)throw invalid()
    const creditedMinutes=row.creditedMinutes
    if(creditedMinutes!==null&&(typeof creditedMinutes!=='number'||!Number.isFinite(creditedMinutes)||creditedMinutes<0||creditedMinutes>31*24*60))throw invalid()
    if(row.approved!==null&&typeof row.approved!=='boolean')throw invalid()
    if(!row.details||typeof row.details!=='object'||Array.isArray(row.details))throw invalid()
    if(row.branchName!==undefined&&(typeof row.branchName!=='string'||row.branchName.length>200))throw invalid()
    const details={...row.details,...(row.branchName!==undefined?{branchName:row.branchName}:{})}
    const result={sourceId:row.sourceId,date:row.date,startedAt:new Date(start).toISOString(),stoppedAt:new Date(stop).toISOString(),breakMinutes,workedMinutes,creditedMinutes,approved:row.approved,details}
    if(Buffer.byteLength(canonical(result))>64*1024)throw invalid()
    return result
  }
  private batch(row:StoredBatch):ZeitguruHistoryBatch {
    const data=decrypt<Omit<ZeitguruHistoryBatch,'fingerprint'|'canUndo'|'undone'>>(row.batchCipher)
    return {...data,fingerprint:row.fingerprint,canUndo:row.undoneAt===null&&(data.added>0||hasZeitguruAccountingSnapshot(this.sql,row.id))&&!newerZeitguruAccountingSnapshot(this.sql,row.userId,row.createdAt),undone:row.undoneAt!==null}
  }
  /** The service must verify own provider identity; generation fences a concurrent connection change. */
  importBatch(input:ZeitguruHistoryImport):{batch:ZeitguruHistoryBatch;status:ZeitguruHistoryStatus} {
    const userId=id(input.userId),providerKey=id(input.providerKey),clientRequestId=id(input.clientRequestId)
    const generation=whole(input.expectedGeneration),fromDate=date(input.fromDate),toDate=date(input.toDate),today=wall(this.now()).date
    if(fromDate>toDate||toDate>=today||!Array.isArray(input.rows)||input.rows.length>100_000)throw invalid()
    const skipped=whole(input.skipped?.count??0,1_000_000)
    if(input.skipped?.reasons!==undefined&&!Array.isArray(input.skipped.reasons))throw invalid()
    const warnings=[...new Set((input.skipped?.reasons??[]).slice(0,20).map(reason=>reasonCodes.has(reason)?reason:'provider_omitted'))]
    const rows=input.rows.map(row=>this.normalize(row,fromDate,toDate,today))
    const requestText=canonical({providerKey,fromDate,toDate,rows,skipped,warnings,...(input.accounting?{accounting:input.accounting}:{})})
    if(Buffer.byteLength(requestText)>32*1024*1024)throw invalid()
    const requestHash=digest(requestText)
    let output!:ZeitguruHistoryBatch
    this.transaction(()=>{
      const hasConnections=this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zeitguru_connections'").get()
      const connection=hasConnections?this.sql.prepare('SELECT generation FROM zeitguru_connections WHERE userId=?').get(userId):undefined
      if(Number(connection?.generation??0)!==generation)throw changed('connection_changed')
      const prior=this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE userId=? AND clientRequestId=?').get(userId,clientRequestId) as unknown as StoredBatch|undefined
      if(prior){if(prior.requestHash!==requestHash)throw changed('request_conflict');output=this.batch(prior);return}
      // Verify mandatory encryption before modifying any archive rows, including empty imports.
      encrypt({})
      const batchId=randomUUID(),manifest:ManifestItem[]=[]
      let duplicates=0,conflicts=0
      const conflictDates:string[]=[]
      for(const row of rows){
        const identityKey=digest(`${providerKey}\0${row.sourceId}`),sourceHash=digest(canonical(row))
        const existing=this.sql.prepare('SELECT sourceHash FROM zeitguru_history_rows WHERE userId=? AND identityKey=?').get(userId,identityKey)
        if(existing){if(existing.sourceHash===sourceHash)duplicates++;else {conflicts++;conflictDates.push(row.date)}continue}
        const start=Date.parse(row.startedAt),stop=Date.parse(row.stoppedAt)
        if(start<stop&&this.sql.prepare('SELECT 1 FROM zeitguru_history_rows WHERE userId=? AND stopEpoch>startEpoch AND stopEpoch>? AND startEpoch<? LIMIT 1').get(userId,start,stop)){conflicts++;conflictDates.push(row.date);continue}
        const rowId=randomUUID()
        this.sql.prepare('INSERT INTO zeitguru_history_rows(id,userId,identityKey,sourceHash,date,startEpoch,stopEpoch,recordCipher,batchId) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(rowId,userId,identityKey,sourceHash,row.date,start,stop,encrypt(row),batchId)
        manifest.push({id:rowId,sourceHash})
      }
      const latest=this.sql.prepare('SELECT MAX(createdAt) value FROM zeitguru_history_batches WHERE userId=?').get(userId)
      const timestamp=Math.max(this.now(),Number(latest?.value??0)+1),fingerprint=digest(canonical({batchId,userId,manifest,requestHash}))
      const publicBatch={id:batchId,createdAt:timestamp,fromDate,toDate,added:manifest.length,duplicates,conflicts,skipped,warnings:[...warnings,...(conflicts?['changed_or_overlapping_records']:[])]}
      this.sql.prepare('INSERT INTO zeitguru_history_batches(id,userId,clientRequestId,requestHash,fingerprint,batchCipher,manifestCipher,createdAt) VALUES(?,?,?,?,?,?,?,?)')
        .run(batchId,userId,clientRequestId,requestHash,fingerprint,encrypt(publicBatch),encrypt(manifest),timestamp)
      if(input.accounting){
        if(input.accounting.toDate!==toDate||input.accounting.fromDate>fromDate)throw invalid()
        saveZeitguruAccountingSnapshot(this.sql,{userId,batchId,providerKey,report:input.accounting,conflictDates})
      }
      output={...publicBatch,fingerprint,canUndo:manifest.length>0||Boolean(input.accounting),undone:false}
    })
    return {batch:output,status:this.status(userId)}
  }
  status(userId:string):ZeitguruHistoryStatus {
    id(userId)
    let totalWorkedMinutes=0,totalCreditedMinutes=0,uncreditedRecords=0
    const rows=this.sql.prepare('SELECT recordCipher,date FROM zeitguru_history_rows WHERE userId=? ORDER BY date').all(userId)
    for(const row of rows){
      const value=decrypt<ZeitguruHistoryInputRow>(String(row.recordCipher))
      totalWorkedMinutes+=value.workedMinutes
      if(value.creditedMinutes===null)uncreditedRecords++;else totalCreditedMinutes+=value.creditedMinutes
    }
    const last=this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE userId=? ORDER BY createdAt DESC,id DESC LIMIT 1').get(userId) as unknown as StoredBatch|undefined
    return {totalRecords:rows.length,totalWorkedMinutes,totalCreditedMinutes,uncreditedRecords,...(rows.length?{firstDate:String(rows[0].date),lastDate:String(rows.at(-1)!.date)}:{}),...(last?{lastImport:this.batch(last)}:{})}
  }
  listBatches(userId:string,options:{limit?:number}={}):ZeitguruHistoryBatch[]{
    id(userId);const limit=whole(options.limit??20,100);if(!limit)throw invalid()
    return (this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE userId=? ORDER BY createdAt DESC,id DESC LIMIT ?').all(userId,limit) as unknown as StoredBatch[]).map(row=>this.batch(row))
  }
  batchForRequest(userId:string,clientRequestId:string):ZeitguruHistoryBatch|undefined {
    id(userId);id(clientRequestId)
    const row=this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE userId=? AND clientRequestId=?').get(userId,clientRequestId) as unknown as StoredBatch|undefined
    return row?this.batch(row):undefined
  }
  listHistory(userId:string,options:{cursor?:string;limit?:number;fromDate?:string;toDate?:string}={}):{rows:ZeitguruHistoryRow[];nextCursor?:string}{
    id(userId);const limit=whole(options.limit??50,200);if(!limit)throw invalid()
    const fromDate=options.fromDate===undefined?'2000-01-01':date(options.fromDate),toDate=options.toDate===undefined?'9999-12-31':date(options.toDate)
    if(fromDate>toDate)throw invalid()
    let cursorDate:string|null=null,cursorId:string|null=null
    if(options.cursor){
      try{const cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));cursorDate=date(cursor.date);cursorId=id(cursor.id)}catch{throw invalid()}
    }
    const stored=this.sql.prepare('SELECT * FROM zeitguru_history_rows WHERE userId=? AND date>=? AND date<=? AND (? IS NULL OR date<? OR (date=? AND id<?)) ORDER BY date DESC,id DESC LIMIT ?').all(userId,fromDate,toDate,cursorDate,cursorDate,cursorDate,cursorId,limit+1) as unknown as StoredRow[]
    const selected=stored.slice(0,limit)
    const rows=selected.map(row=>{
      const data=decrypt<ZeitguruHistoryInputRow>(row.recordCipher)
      const branchName=typeof data.details.branchName==='string'?data.details.branchName.slice(0,200):undefined
      return {id:row.id,date:data.date,startedAt:data.startedAt,stoppedAt:data.stoppedAt,startTime:wall(Date.parse(data.startedAt)).time,endTime:wall(Date.parse(data.stoppedAt)).time,breakMinutes:data.breakMinutes,workedMinutes:data.workedMinutes,creditedMinutes:data.creditedMinutes,approved:data.approved,...(branchName?{branchName}:{})}
    })
    const last=selected.at(-1)
    return {rows,...(stored.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify({date:last.date,id:last.id})).toString('base64url')}:{})}
  }
  /** Reverses this batch's unchanged inserts only. Any later change aborts the entire undo. */
  undoBatch(userId:string,batchId:string,expectedFingerprint:string):{batch:ZeitguruHistoryBatch;status:ZeitguruHistoryStatus}{
    id(userId);id(batchId);id(expectedFingerprint)
    let output!:ZeitguruHistoryBatch
    this.transaction(()=>{
      const row=this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE userId=? AND id=?').get(userId,batchId) as unknown as StoredBatch|undefined
      if(!row)throw new ZeitguruHistoryError('history_batch_missing',404,'This historical import is unavailable.')
      if(row.fingerprint!==expectedFingerprint)throw changed()
      if(row.undoneAt!==null){output=this.batch(row);return}
      if(newerZeitguruAccountingSnapshot(this.sql,userId,row.createdAt))throw changed('newer_accounting_import_exists')
      const manifest=decrypt<ManifestItem[]>(row.manifestCipher)
      for(const item of manifest){
        const entry=this.sql.prepare('SELECT * FROM zeitguru_history_rows WHERE userId=? AND id=?').get(userId,item.id) as unknown as StoredRow|undefined
        if(!entry||entry.batchId!==batchId||entry.sourceHash!==item.sourceHash||digest(canonical(decrypt(entry.recordCipher)))!==item.sourceHash)throw changed('history_changed_after_import')
      }
      for(const item of manifest)this.sql.prepare('DELETE FROM zeitguru_history_rows WHERE userId=? AND id=? AND batchId=?').run(userId,item.id,batchId)
      this.sql.prepare('DELETE FROM zeitguru_accounting_snapshots WHERE userId=? AND batchId=?').run(userId,batchId)
      this.sql.prepare('UPDATE zeitguru_history_batches SET undoneAt=? WHERE userId=? AND id=?').run(this.now(),userId,batchId)
      output=this.batch(this.sql.prepare('SELECT * FROM zeitguru_history_batches WHERE id=?').get(batchId) as unknown as StoredBatch)
    })
    return {batch:output,status:this.status(userId)}
  }
}
