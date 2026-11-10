import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Check, Download, FileSpreadsheet, PackageCheck, Paperclip, Plus, RotateCcw, ScanLine, Trash2, Upload } from 'lucide-react'
import type { InventoryLocation, InventoryReceiptLine, InventoryStatePayload } from '../shared/inventory.ts'
import { receivingDraftKey } from './receivingDraft.ts'

interface DraftLine {
  key: string
  itemId: string
  sourceRecordId: string
  sourceExpectedVersion?: number
  locationId: string
  quantity: string
  quantityLabel: string
  condition: string
  discrepancy: string
  discrepancyQuantity: string
  notes: string
  barcode: string
}

interface PreviewRow {
  rowNumber: number
  receivedAt: string
  itemName: string
  itemId?: string
  quantity?: number
  quantityLabel?: string
  locationName: string
  locationId?: string
  notes?: string
  receiverLabel?: string
  supplier?: string
  orderReference?: string
  deliveryNoteNumber?: string
  barcode?: string
  sourceReference?: string
  errors: string[]
  warnings: string[]
}

interface GoodsReceivingPanelProps {
  state: InventoryStatePayload
  language: 'en' | 'de'
  loading: boolean
  canReceive: boolean
  canCorrect: boolean
  onPreview: (file: File) => Promise<PreviewRow[]>
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>
  onCorrect: (lineId: string, body: Record<string, unknown>) => Promise<boolean>
  onRelease: (lineId: string, body: Record<string, unknown>) => Promise<boolean>
  onExport: (month: string) => Promise<void>
  serverScope: string
}

interface ReceivingDraft {
  receivedAt: string; supplier: string; orderReference: string; deliveryNoteNumber: string; batchNotes: string
  lines: DraftLine[]; pasteText: string; previewRows: PreviewRow[]; previewName: string; attachmentName?: string
  submission?: { fingerprint: string; key: string }
}

function writeDraft(key: string, value: string) {
  if (value.length > 2_000_000) throw new Error('Draft exceeds browser restoration limit.')
  sessionStorage.setItem(key, value)
}

function readDraft(key: string): Partial<ReceivingDraft> {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw || raw.length > 2_000_000) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return {}
    const draft = value as ReceivingDraft
    if (!['receivedAt', 'supplier', 'orderReference', 'deliveryNoteNumber', 'batchNotes', 'pasteText', 'previewName'].every(field => typeof draft[field as keyof ReceivingDraft] === 'string')) return {}
    if (!Array.isArray(draft.lines) || !draft.lines.length || draft.lines.length > 1000 || !draft.lines.every(line => line && Object.keys(blankLine()).every(field => typeof line[field as keyof DraftLine] === 'string'))) return {}
    if (!Array.isArray(draft.previewRows) || !draft.previewRows.every(row => row && Array.isArray(row.errors) && Array.isArray(row.warnings))) return {}
    return draft
  } catch { return {} }
}

const blankLine = (locationId = ''): DraftLine => ({
  key: crypto.randomUUID(), itemId: '', sourceRecordId: '', locationId, quantity: '', quantityLabel: '', condition: 'new', discrepancy: 'none',
  discrepancyQuantity: '', notes: '', barcode: '',
})

function dateInputValue(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 10)
}

async function fileBase64(file?: File | null) {
  if (!file) return undefined
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

export function GoodsReceivingPanel({ state, language, loading, canReceive, canCorrect, onPreview, onSubmit, onCorrect, onRelease, onExport, serverScope }: GoodsReceivingPanelProps) {
  const de = language === 'de'
  const storageKey = receivingDraftKey(state.currentUser.id, serverScope)
  const [restored] = useState(() => readDraft(storageKey))
  const [receivedAt, setReceivedAt] = useState(restored.receivedAt ?? dateInputValue())
  const [supplier, setSupplier] = useState(restored.supplier ?? '')
  const [orderReference, setOrderReference] = useState(restored.orderReference ?? '')
  const [deliveryNoteNumber, setDeliveryNoteNumber] = useState(restored.deliveryNoteNumber ?? '')
  const [batchNotes, setBatchNotes] = useState(restored.batchNotes ?? '')
  const [attachment, setAttachment] = useState<File | null>(null)
  const attachmentInput = useRef<HTMLInputElement>(null)
  const [missingAttachment, setMissingAttachment] = useState(restored.attachmentName ?? '')
  const [lines, setLines] = useState<DraftLine[]>(restored.lines ?? [blankLine()])
  const [pasteText, setPasteText] = useState(restored.pasteText ?? '')
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>(restored.previewRows ?? [])
  const [previewName, setPreviewName] = useState(restored.previewName ?? '')
  const submission = useRef(restored.submission)
  const [storageFailed, setStorageFailed] = useState(false)
  const [localError, setLocalError] = useState('')
  const [month, setMonth] = useState(dateInputValue().slice(0, 7))
  const itemsById = useMemo(() => new Map(state.items.map((item) => [item.id, item])), [state.items])
  const locationsById = useMemo(() => new Map(state.locations.map((location) => [location.id, location])), [state.locations])
  const receiptsById = useMemo(() => new Map(state.receipts.map((receipt) => [receipt.id, receipt])), [state.receipts])
  const correctedLineIds = useMemo(() => new Set(state.receiptLines.filter((line) => line.adjustments?.some((event) => event.type === 'corrected')).map((line) => line.id)), [state.receiptLines])
  const monthReceipts = state.receipts.filter((receipt) => receipt.receivedAt.slice(0, 7) === month)
  const monthReceiptIds = new Set(monthReceipts.map((receipt) => receipt.id))
  const monthLines = state.receiptLines.filter((line) => monthReceiptIds.has(line.receiptId))
  const reviewLines = state.receiptLines.filter((line) => !line.reversedByEventId && (line.quarantined || (line.reviewRequired && !correctedLineIds.has(line.id) && !line.releasedByEventId)))
  const hasDraft = Boolean(supplier || orderReference || deliveryNoteNumber || batchNotes || pasteText || previewRows.length || attachment || missingAttachment || receivedAt !== dateInputValue() || lines.length > 1 || lines.some(line => line.itemId || line.quantity || line.quantityLabel || line.notes || line.barcode || line.locationId || line.discrepancy !== 'none'))
  const draft: ReceivingDraft = { receivedAt, supplier, orderReference, deliveryNoteNumber, batchNotes, lines, pasteText, previewRows, previewName, attachmentName: attachment?.name || missingAttachment, submission: submission.current }
  const serializedDraft = JSON.stringify(draft)

  useEffect(() => {
    try {
      if (hasDraft) writeDraft(storageKey, serializedDraft)
      else sessionStorage.removeItem(storageKey)
      setStorageFailed(false)
    } catch { setStorageFailed(true) }
  }, [hasDraft, serializedDraft, storageKey])

  useEffect(() => {
    if (!hasDraft) return
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [hasDraft])

  function clearManualDraft() {
    setReceivedAt(dateInputValue()); setSupplier(''); setOrderReference(''); setDeliveryNoteNumber('')
    setBatchNotes(''); setLines([blankLine()]); setPasteText(''); setAttachment(null); setMissingAttachment('')
    if (attachmentInput.current) attachmentInput.current.value = ''
    submission.current = undefined
  }

  function discardDraft() {
    if (!window.confirm(de ? 'Den ungespeicherten Wareneingang verwerfen?' : 'Discard this unsaved receiving draft?')) return
    clearManualDraft(); setPreviewRows([]); setPreviewName(''); setLocalError('')
  }

  async function submitOnce(body: Record<string, unknown>) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() }
    try { writeDraft(storageKey, JSON.stringify({ ...draft, submission: submission.current })) } catch { setStorageFailed(true) }
    return onSubmit({ ...body, idempotencyKey: submission.current.key })
  }

  function patchLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line))
  }

  function scanBarcode(line: DraftLine, barcode: string) {
    const normalized = barcode.trim().toLowerCase()
    const item = state.items.find((candidate) => [candidate.sku, candidate.manufacturerPartNumber, candidate.lcscPartNumber].some((value) => value?.toLowerCase() === normalized))
    patchLine(line.key, { barcode, itemId: item?.id ?? line.itemId })
  }

  function applyPaste() {
    const locationFallback = lines.at(-1)?.locationId ?? ''
    const pasted = pasteText.trim().split(/\r?\n/).filter(Boolean).map((row) => {
      const [itemText = '', quantity = '', quantityLabel = '', locationText = '', notes = ''] = row.split('\t')
      const item = state.items.find((candidate) => [candidate.name, candidate.sku].some((value) => value.toLowerCase() === itemText.trim().toLowerCase()))
      const location = state.locations.find((candidate) => [candidate.name, candidate.code].some((value) => value.toLowerCase() === locationText.trim().toLowerCase()))
      return { ...blankLine(location?.id || locationFallback), itemId: item?.id ?? '', quantity, quantityLabel, notes }
    })
    if (pasted.length) setLines(pasted)
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault()
    setLocalError('')
    const valid = lines.filter((line) => line.itemId && line.locationId && Number(line.quantity) > 0)
    if (valid.length !== lines.length) { setLocalError(de ? 'Artikel, Lagerort und eine positive Menge sind in jeder Zeile erforderlich.' : 'Every line needs an item, location, and positive quantity.'); return }
    if (missingAttachment && !attachment) { setLocalError(de ? 'Bitte den Lieferschein erneut auswählen oder den fehlenden Anhang entfernen.' : 'Choose the delivery note again or remove the missing attachment.'); return }
    const saved = await submitOnce({
      receivedAt: new Date(`${receivedAt}T12:00:00`).toISOString(), supplier, orderReference, deliveryNoteNumber, notes: batchNotes,
      attachmentName: attachment?.name, attachmentBase64: await fileBase64(attachment),
      lines: valid.map(({ key: _key, ...line }, index) => ({ ...line, rowNumber: index + 1, quantity: Number(line.quantity), discrepancyQuantity: line.discrepancyQuantity ? Number(line.discrepancyQuantity) : undefined })),
    })
    if (saved) clearManualDraft()
  }

  async function chooseImport(file?: File) {
    if (!file) return
    setLocalError('')
    try { setPreviewRows(await onPreview(file)); setPreviewName(file.name) }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'Import failed.') }
  }

  async function commitImport() {
    if (previewRows.some((row) => row.errors.length)) return
    if (await submitOnce({ lines: previewRows })) { setPreviewRows([]); setPreviewName(''); submission.current = undefined }
  }

  return (
    <div className="receiving-workspace">
      {hasDraft && <div className="receiving-draft-status" role="status"><span>{storageFailed ? (de ? 'Entwurf bleibt geöffnet. Dieser Browser konnte ihn nicht für ein Neuladen sichern.' : 'Draft remains open. This browser could not save it for reload.') : (de ? 'Ungespeicherter Entwurf für dieses Konto in diesem Browser-Tab gesichert.' : 'Unsaved draft kept for this account in this browser tab.')}</span><button className="secondary-action" disabled={loading} type="button" onClick={discardDraft}>{de ? 'Entwurf verwerfen' : 'Discard draft'}</button></div>}
      {missingAttachment && !attachment && <div className="inline-error" role="alert">{de ? 'Lieferschein erneut auswählen: ' : 'Choose the delivery note again: '}{missingAttachment} <button className="secondary-action" type="button" onClick={() => setMissingAttachment('')}>{de ? 'Ohne Anhang fortfahren' : 'Continue without attachment'}</button></div>}
      <section className="inventory-panel receiving-hero">
        <div className="panel-title-row"><div><span className="eyebrow">{de ? 'Nachvollziehbarer Wareneingang' : 'Accountable goods receipt'}</span><h2><PackageCheck size={22} /> {de ? 'Wareneingang erfassen' : 'Receive inventory'}</h2><p>{de ? 'Schnell wie eine Liste – mit Verantwortlichkeit, Prüfung und unveränderbarer Historie.' : 'As quick as a list, with ownership, validation, and immutable history.'}</p></div><div className="receiving-summary"><strong>{monthLines.length}</strong><span>{de ? 'Positionen im Monat' : 'lines this month'}</span><strong>{reviewLines.length}</strong><span>{de ? 'zu prüfen' : 'need review'}</span></div></div>
      </section>

      <section className="inventory-panel">
        <form className="receiving-form" onSubmit={submitManual}>
          <div className="receiving-section-heading"><div><h3>{de ? 'Neue Lieferung' : 'New delivery'}</h3><p>{de ? 'Empfänger wird automatisch aus Ihrem Konto übernommen.' : 'Receiver is attributed automatically from your account.'}</p></div><button className="secondary-action" type="button" onClick={() => setLines((current) => [...current, blankLine(current.at(-1)?.locationId)])}><Plus size={16} />{de ? 'Zeile hinzufügen' : 'Add line'}</button></div>
          <div className="receiving-header-grid">
            <label>{de ? 'Eingangsdatum' : 'Receipt date'}<input required type="date" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} /></label>
            <label>{de ? 'Lieferant' : 'Supplier'}<input value={supplier} onChange={(event) => setSupplier(event.target.value)} /></label>
            <label>{de ? 'Bestellreferenz' : 'Order reference'}<input value={orderReference} onChange={(event) => setOrderReference(event.target.value)} /></label>
            <label>{de ? 'Lieferschein' : 'Delivery note'}<input value={deliveryNoteNumber} onChange={(event) => setDeliveryNoteNumber(event.target.value)} /></label>
          </div>
          <div className="receipt-lines">
            {lines.map((line, index) => <div className="receipt-line" key={line.key}>
              <span className="line-number">{index + 1}</span>
              <label>{de ? 'Artikel' : 'Item'}<select required value={line.itemId} onChange={(event) => patchLine(line.key, { itemId: event.target.value, sourceRecordId: '', sourceExpectedVersion: undefined })}><option value="">—</option>{state.items.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.sku ? `${item.sku} · ` : ''}{item.name}</option>)}</select></label>
              <label>{de ? 'Zugehörige Bestellung' : 'Source order'}<select value={line.sourceRecordId} onChange={(event) => patchLine(line.key, { sourceRecordId: event.target.value, sourceExpectedVersion: state.records.find(record => record.id === event.target.value)?.version })}><option value="">{de ? 'Ohne Bestellung' : 'Unplanned receipt'}</option>{state.records.filter((record) => record.itemId === line.itemId && ['ordered', 'delivered'].includes(record.state) && record.quantity > 0).map((record) => <option key={record.id} value={record.id}>{record.orderReference || record.label || record.id} · {record.quantity}</option>)}</select>{line.sourceRecordId && line.sourceExpectedVersion !== state.records.find(record => record.id === line.sourceRecordId)?.version && <span className="validation-warning">{de ? "Bestellung geändert. Prüfen Sie die Restmenge und wählen Sie die Bestellung erneut." : "Order changed. Review the remaining quantity and select the order again."}</span>}</label>
              <label>{de ? 'Menge' : 'Qty'}<input min="0.0001" required step="any" type="number" value={line.quantity} onChange={(event) => patchLine(line.key, { quantity: event.target.value })} /></label>
              <label>{de ? 'Gebinde / Originaltext' : 'Packaging / original text'}<input placeholder={de ? 'z. B. 4 Kartons à 25' : 'e.g. 4 boxes of 25'} value={line.quantityLabel} onChange={(event) => patchLine(line.key, { quantityLabel: event.target.value })} /></label>
              <label>{de ? 'Lagerort' : 'Location'}<select required value={line.locationId} onChange={(event) => patchLine(line.key, { locationId: event.target.value })}><option value="">—</option>{state.locations.filter((location) => location.active).map((location) => <option key={location.id} value={location.id}>{location.code ? `${location.code} · ` : ''}{location.name}</option>)}</select></label>
              <label>{de ? 'Abweichung' : 'Discrepancy'}<select value={line.discrepancy} onChange={(event) => patchLine(line.key, { discrepancy: event.target.value })}><option value="none">{de ? 'Keine' : 'None'}</option><option value="short">{de ? 'Fehlmenge' : 'Short'}</option><option value="over">{de ? 'Mehrmenge' : 'Over'}</option><option value="damaged">{de ? 'Beschädigt' : 'Damaged'}</option><option value="wrong_item">{de ? 'Falscher Artikel' : 'Wrong item'}</option></select></label>
              <label><ScanLine size={14} /> Barcode / QR<input value={line.barcode} onChange={(event) => scanBarcode(line, event.target.value)} /></label>
              <label className="receipt-notes">{de ? 'Notiz' : 'Notes'}<input value={line.notes} onChange={(event) => patchLine(line.key, { notes: event.target.value })} /></label>
              <button aria-label={de ? 'Zeile entfernen' : 'Remove line'} className="icon-action danger" disabled={lines.length === 1} type="button" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}><Trash2 size={16} /></button>
            </div>)}
          </div>
          <details className="paste-box"><summary><FileSpreadsheet size={16} /> {de ? 'Mehrere Excel-Zeilen einfügen' : 'Paste multiple spreadsheet rows'}</summary><p>{de ? 'Reihenfolge: Artikel, Menge, Gebinde, Lagerort, Notiz (tab-getrennt).' : 'Order: item, quantity, packaging, location, notes (tab-separated).'}</p><textarea rows={4} value={pasteText} onChange={(event) => setPasteText(event.target.value)} /><button className="secondary-action" type="button" onClick={applyPaste}>{de ? 'Zeilen übernehmen' : 'Apply rows'}</button></details>
          <div className="receiving-footer"><label className="file-picker"><Paperclip size={16} />{de ? 'Lieferschein (PDF/Bild, max. 4 MB)' : 'Delivery note (PDF/image, max 4 MB)'}<input ref={attachmentInput} accept=".pdf,.png,.jpg,.jpeg,.webp" type="file" onChange={(event) => { setAttachment(event.target.files?.[0] ?? null); if (event.target.files?.[0]) setMissingAttachment('') }} /><span>{attachment?.name}</span></label><label className="batch-notes">{de ? 'Liefernotiz' : 'Delivery notes'}<input value={batchNotes} onChange={(event) => setBatchNotes(event.target.value)} /></label><button className="primary-action" disabled={!canReceive || loading} type="submit"><Check size={16} />{de ? 'Speichern & nächste Lieferung' : 'Save & next delivery'}</button></div>
          {localError && <div className="inline-error">{localError}</div>}
        </form>
      </section>

      <section className="inventory-panel import-panel">
        <div className="receiving-section-heading"><div><h3>{de ? 'Bestehende Listen importieren' : 'Import existing lists'}</h3><p>{de ? 'CSV, TSV oder XLSX bis 4 MB. Vor dem Speichern sehen Sie Fehler und Vorschläge.' : 'CSV, TSV, or XLSX up to 4 MB. Errors and suggestions are shown before anything is saved.'}</p></div><label className="secondary-action file-button"><Upload size={16} />{de ? 'Datei prüfen' : 'Validate file'}<input accept=".csv,.tsv,.xlsx" type="file" onChange={(event) => void chooseImport(event.target.files?.[0])} /></label></div>
        {previewRows.length > 0 && <><div className="import-summary"><strong>{previewName}</strong><span>{previewRows.length} {de ? 'Zeilen' : 'rows'}</span><span className={previewRows.some((row) => row.errors.length) ? 'status-note warning' : 'status-note success'}>{previewRows.reduce((total, row) => total + row.errors.length, 0)} {de ? 'Fehler' : 'errors'}</span><span>{previewRows.filter((row) => row.warnings.length).length} {de ? 'Hinweise' : 'warnings'}</span></div><div className="table-scroll"><table className="inventory-table receiving-preview"><thead><tr><th>#</th><th>{de ? 'Datum' : 'Date'}</th><th>{de ? 'Artikel' : 'Item'}</th><th>{de ? 'Menge' : 'Quantity'}</th><th>{de ? 'Lagerort' : 'Location'}</th><th>{de ? 'Prüfung' : 'Validation'}</th></tr></thead><tbody>{previewRows.map((row) => <tr key={`${row.sourceReference}-${row.rowNumber}`}><td>{row.rowNumber}</td><td>{row.receivedAt?.slice(0, 10) || '—'}</td><td>{row.itemName}<small>{row.itemId ? ' ✓' : ` · ${de ? 'neu' : 'new'}`}</small></td><td>{row.quantity ?? '—'}<small>{row.quantityLabel}</small></td><td>{row.locationName}<small>{row.locationId ? ' ✓' : ` · ${de ? 'neu' : 'new'}`}</small></td><td>{row.errors.map((value) => <div className="validation-error" key={value}><AlertTriangle size={13} />{value}</div>)}{row.warnings.map((value) => <div className="validation-warning" key={value}>{value}</div>)}</td></tr>)}</tbody></table></div><div className="form-actions"><button className="secondary-action" type="button" onClick={() => setPreviewRows([])}>{de ? 'Verwerfen' : 'Discard'}</button><button className="primary-action" disabled={loading || previewRows.some((row) => row.errors.length)} type="button" onClick={() => void commitImport()}><Upload size={16} />{de ? 'Geprüfte Zeilen importieren' : 'Import reviewed rows'}</button></div></>}
      </section>

      {reviewLines.length > 0 && <section className="inventory-panel review-panel"><div className="receiving-section-heading"><div><h3>{de ? 'Klärfälle' : 'Reconciliation queue'}</h3><p>{de ? 'Mehrdeutige Mengen oder nicht zugeordnete Altangaben warten auf eine begründete Korrektur.' : 'Ambiguous quantities or legacy values wait here for a reasoned correction.'}</p></div><span className="status-note warning">{reviewLines.length}</span></div><div className="review-list">{reviewLines.map((line) => <ReceiptLineCorrection key={line.id} line={line} locations={state.locations} locationName={locationsById.get(line.locationId)?.name} itemName={itemsById.get(line.itemId)?.name} canCorrect={canCorrect} loading={loading} de={de} onCorrect={onCorrect} onRelease={onRelease} items={state.items} />)}</div></section>}

      <section className="inventory-panel receipt-history"><div className="receiving-section-heading"><div><h3>{de ? 'Monatsjournal' : 'Monthly receipt journal'}</h3><p>{de ? 'Unveränderbare Originalbuchungen, Korrekturen und Belege.' : 'Original entries, corrections, and delivery notes remain traceable.'}</p></div><div className="month-export"><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /><button className="secondary-action" type="button" onClick={() => void onExport(month)}><Download size={16} /> Excel CSV</button></div></div><div className="table-scroll"><table className="inventory-table receipt-journal-table"><thead><tr><th>{de ? 'Datum' : 'Date'}</th><th>{de ? 'Artikel' : 'Item'}</th><th>{de ? 'Menge' : 'Qty'}</th><th>{de ? 'Ort' : 'Location'}</th><th>{de ? 'Empfänger' : 'Receiver'}</th><th>{de ? 'Referenzen' : 'References'}</th><th>Status</th></tr></thead><tbody>{monthLines.map((line) => { const receipt = receiptsById.get(line.receiptId); return <tr key={line.id}><td>{receipt?.receivedAt.slice(0, 10)}</td><td>{itemsById.get(line.itemId)?.name}</td><td>{line.quantity}<small>{line.quantityLabel}</small>{Boolean(line.adjustments?.length) && <small>{de ? 'Aktueller Bestand: ' : 'Current stock: '}{line.currentQuantity}</small>}</td><td>{locationsById.get(line.locationId)?.name}</td><td>{receipt?.receiverLabel}</td><td>{receipt?.orderReference || receipt?.deliveryNoteNumber || line.sourceReference || '—'}{receipt?.attachmentPath && <a href={receipt.attachmentPath}>{de ? 'Beleg' : 'Attachment'}</a>}</td><td>{line.reversedByEventId ? <span className="status-note danger"><RotateCcw size={12} /> {de ? 'storniert' : 'reversed'}</span> : line.quarantined ? <span className="status-note warning">{de ? "Gesperrt · prüfen" : "On hold · review"}</span> : line.releasedByEventId ? <span className="status-note success">{de ? "Freigegeben" : "Released"}</span> : correctedLineIds.has(line.id) ? <span className="status-note success">{de ? 'korrigiert' : 'corrected'}</span> : line.reviewRequired ? <span className="status-note warning">{de ? 'prüfen' : 'review'}</span> : <span className="status-note success">{de ? 'gebucht' : 'posted'}</span>}{line.adjustments?.map((adjustment) => <details key={adjustment.id}><summary>{adjustment.createdAt.slice(0, 10)} · {adjustment.quantityBefore} → {adjustment.quantityAfter}</summary><p>{adjustment.reason} · {adjustment.actor}</p></details>)}</td></tr> })}{monthLines.length === 0 && <tr><td colSpan={7}>{de ? 'Keine Wareneingänge in diesem Monat.' : 'No receipts in this month.'}</td></tr>}</tbody></table></div></section>
    </div>
  )
}

function ReceiptLineCorrection({ line, locations, locationName, itemName, canCorrect, loading, de, onCorrect, onRelease, items }: {
  line: InventoryReceiptLine; locations: InventoryLocation[]; locationName?: string; itemName?: string
  canCorrect: boolean; loading: boolean; de: boolean; onCorrect: GoodsReceivingPanelProps['onCorrect']
  onRelease: GoodsReceivingPanelProps['onRelease']; items: InventoryStatePayload['items']
}) {
  const [quantity, setQuantity] = useState(String(line.currentQuantity ?? line.quantity))
  const [quantityLabel, setQuantityLabel] = useState(line.quantityLabel ?? '')
  const [locationId, setLocationId] = useState(line.currentLocationId ?? line.locationId)
  const [expectedVersion, setExpectedVersion] = useState(line.currentVersion)
  const [reason, setReason] = useState('')
  const [releaseItemId, setReleaseItemId] = useState(line.itemId)
  const [releaseCondition, setReleaseCondition] = useState('')
  const [confirmedItem, setConfirmedItem] = useState(false)
  const [releaseReason, setReleaseReason] = useState('')
  const stale = expectedVersion !== line.currentVersion
  function useLatest() {
    if (!window.confirm(de ? 'Die eingegebenen Korrekturwerte durch den aktuellen Bestand ersetzen?' : 'Replace your correction inputs with the current stock values?')) return
    setQuantity(String(line.currentQuantity ?? line.quantity)); setLocationId(line.currentLocationId ?? line.locationId)
    setExpectedVersion(line.currentVersion); setReason(''); setReleaseReason(''); setConfirmedItem(false)
  }
  return <article className="receipt-review">
    <div><strong>{itemName}</strong><small>{line.sourceReference}</small><small>{line.quantityLabel || `${line.quantity}`} · {locationName}</small></div>
    {line.quarantined && <p className="status-note warning">{de ? 'Diese Lieferung ist gesperrt und nicht verfügbar. Artikel und Zustand vor der Freigabe prüfen.' : 'This delivery is on hold and unavailable. Inspect the item and condition before releasing it.'}</p>}
    {stale && <div className="inline-error" role="alert"><p>{de ? 'Der Bestand wurde geändert. Ihre Eingaben bleiben erhalten. Aktuelle Menge: ' : 'Stock changed. Your inputs were kept. Current quantity: '}{line.currentQuantity ?? line.quantity}</p><button className="secondary-action" type="button" onClick={useLatest}>{de ? 'Aktuelle Werte übernehmen' : 'Load current values'}</button></div>}
    <form className="review-row" onSubmit={async (event) => {
      event.preventDefault()
      if (await onCorrect(line.id, { quantity: Number(quantity), quantityLabel, locationId, reason, expectedVersion })) { setReason(''); setExpectedVersion(version => version + 1) }
    }}>
      <label>{de ? 'Menge' : 'Quantity'}<input min="0" step="any" type="number" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label>{de ? 'Originaltext' : 'Original text'}<input value={quantityLabel} onChange={(event) => setQuantityLabel(event.target.value)} /></label>
      <label>{de ? 'Lagerort' : 'Location'}<select value={locationId} onChange={(event) => setLocationId(event.target.value)}>{locations.map((location) => <option key={location.id} value={location.id}>{location.code ? `${location.code} · ` : ''}{location.name}</option>)}</select></label>
      <label>{de ? 'Korrekturbegründung' : 'Correction reason'}<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button className="primary-action" disabled={!canCorrect || loading || stale || !reason.trim()} type="submit"><Check size={15} />{de ? 'Korrigieren' : 'Correct'}</button>
    </form>
    {line.quarantined && <form className="review-row receipt-release" onSubmit={async event => {
      event.preventDefault()
      await onRelease(line.id, { expectedVersion, reason: releaseReason, itemId: releaseItemId, condition: releaseCondition })
    }}>
      <label>{de ? 'Tatsächlich gelieferter Artikel' : 'Actual delivered item'}<select required value={releaseItemId} onChange={event => { setReleaseItemId(event.target.value); setConfirmedItem(false) }}>{items.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}</select></label>
      <label>{de ? 'Geprüfter Zustand' : 'Inspected condition'}<select required value={releaseCondition} onChange={event => setReleaseCondition(event.target.value)}><option value="">{de ? 'Bitte wählen' : 'Choose condition'}</option><option value="new">{de ? 'Neu' : 'New'}</option><option value="usable">{de ? 'Brauchbar' : 'Usable'}</option></select></label>
      <label>{de ? 'Freigabebegründung' : 'Release reason'}<input required value={releaseReason} onChange={event => setReleaseReason(event.target.value)} /></label>
      <label className="toggle-field"><input type="checkbox" checked={confirmedItem} onChange={event => setConfirmedItem(event.target.checked)} />{de ? 'Artikel geprüft und korrekt zugeordnet' : 'Item inspected and correctly identified'}</label>
      <button className="primary-action" disabled={!canCorrect || loading || stale || !confirmedItem || !releaseCondition || !releaseReason.trim() || (line.currentQuantity ?? line.quantity) <= 0} type="submit">{de ? 'Geprüften Bestand freigeben' : 'Release inspected stock'}</button>
    </form>}
  </article>
}
