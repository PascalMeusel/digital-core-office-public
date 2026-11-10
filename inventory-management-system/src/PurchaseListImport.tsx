import { useRef, useState } from 'react'
import { Field } from './WorkflowField.tsx'
import { previewPurchaseList, type PurchasePart, type PurchaseListRow } from '../shared/purchaseList.ts'

export function PurchaseListImport({ parts, quantities, pendingName, text, onTextChange, onAdd, de }: { parts: PurchasePart[]; quantities: Record<string, string>; pendingName: string; text: string; onTextChange: (text: string) => void; onAdd: (rows: PurchaseListRow[]) => void; de: boolean }) {
  const [reviewed, setReviewed] = useState(false), [notice, setNotice] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const t = (en: string, german: string) => de ? german : en
  const preview = reviewed ? previewPurchaseList(text, parts, quantities, { language: de ? 'de' : 'en', pendingName }) : undefined
  const ready = preview?.rows.filter(row => !row.alreadySelected) ?? [], invalid = Boolean(preview?.errors.length || preview?.rows.some(row => row.errors.length))
  const number = new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 })
  return <details className="purchase-entry purchase-list-import"><summary>{t('Paste a parts list', 'Teileliste einfügen')}</summary><div>
    <p>{t('Paste cells from Excel or a CSV list. Use Article and Quantity; Unit, Link and Price EUR are optional. Article can also be an existing SKU. Without headers, use this same column order.', 'Zellen aus Excel oder eine CSV-Liste einfügen. Artikel und Menge angeben; Einheit, Link und Preis EUR sind optional. Als Artikel geht auch eine vorhandene SKU. Ohne Überschriften gilt dieselbe Spaltenreihenfolge.')}</p>
    <Field label={t('Parts list', 'Teileliste')}><textarea ref={input} value={text} maxLength={200000} rows={6} spellCheck={false} placeholder={'Artikel\tMenge\tEinheit\tLink\tPreis EUR\nOOB-PCB\t4\tpcs\nMat material\t2,5\tm²\thttps://example.com/material\t12,50'} onChange={event => { onTextChange(event.target.value); setReviewed(false); setNotice('') }} /></Field>
    <div className="form-actions"><button type="button" className="secondary-action" disabled={!text.trim()} onClick={() => { setReviewed(true); setNotice('') }}>{t('Check list', 'Liste prüfen')}</button>{text && <button type="button" className="secondary-action" onClick={() => { onTextChange(''); setReviewed(false); setNotice(''); input.current?.focus() }}>{t('Clear pasted list', 'Eingefügte Liste leeren')}</button>}</div>
    {preview && <>
      {invalid && <div role="alert">{preview.errors.map((error, index) => <p key={index}>{error}</p>)}{preview.rows.filter(row => row.errors.length).map(row => <p key={row.rows[0]}>{t('Row', 'Zeile')} {row.rows.join(', ')} · {row.name}: {row.errors.join(' ')}</p>)}</div>}
      {preview.rows.length > 0 && <><p role="status">{ready.length} {t('parts to add', 'Teile zum Hinzufügen')} · {preview.rows.filter(row => row.alreadySelected).length} {t('already selected — unchanged', 'bereits ausgewählt – bleiben unverändert')}</p><button type="button" className="secondary-action" disabled={invalid || !ready.length} onClick={() => { onAdd(ready); onTextChange(''); setReviewed(false); setNotice(`${ready.length} ${t('parts added. Review the selected quantities below, then send for approval.', 'Teile hinzugefügt. Die ausgewählten Mengen unten prüfen und dann zur Freigabe senden.')}`); input.current?.focus() }}>{t('Add parts to request', 'Teile zur Anfrage hinzufügen')} ({ready.length})</button><div className="workflow-scroll-list workflow-list" role="list" aria-label={t('Parts list preview', 'Teilelisten-Vorschau')}>{preview.rows.map(row => <div className="workflow-row" role="listitem" key={row.rows[0]}><div>
          <strong>{number.format(row.quantity)} {row.unit} · {row.name}</strong>
          <small>{t('Row', 'Zeile')} {row.rows.join(', ')} · {row.errors.length ? t('Correct this row', 'Zeile korrigieren') : row.alreadySelected ? t('Already selected · unchanged', 'Bereits ausgewählt · unverändert') : row.itemId ? t('Existing article', 'Vorhandener Artikel') : t('New part', 'Neues Teil')}</small>
          {row.alreadySelected && row.partId && Number(quantities[row.partId]) > 0 && <small>{t('Keeping', 'Beibehalten')}: {number.format(Number(quantities[row.partId]))} {row.unit}</small>}
          {row.rows.length > 1 && <small>{t('Repeated rows combined', 'Wiederholte Zeilen zusammengefasst')}</small>}
          {row.supplierUrl && <small><a href={row.supplierUrl} target="_blank" rel="noreferrer">{t('Supplier link', 'Lieferantenlink')}</a></small>}
          {row.estimatedUnitCost !== undefined && <small>{new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 }).format(row.estimatedUnitCost)} / {row.unit}</small>}
        </div></div>)}</div>
</>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </div></details>
}
