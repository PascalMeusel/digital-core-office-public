import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Check, Download, Edit3, ExternalLink, MapPin, Package, Printer, QrCode, RotateCcw, Search, ShieldOff, Tag } from 'lucide-react'
import QRCode from 'qrcode'
import type { InventoryQrLabel, InventoryQrTargetType, InventoryStatePayload } from '../shared/inventory.ts'

interface QrWorkspaceProps {
  state: InventoryStatePayload
  language: 'en' | 'de'
  loading: boolean
  routeLabelId?: string
  targetPath: (type: InventoryQrTargetType, id: string) => string
  labelPath: (id: string) => string
  onNavigate: (path: string) => void
  onSave: (id: string, body: Record<string, unknown>, isNew: boolean) => Promise<boolean>
  onDeactivate: (id: string) => Promise<boolean>
  onScan?: () => Promise<void>
}

function targetIcon(type: InventoryQrTargetType) {
  if (type === 'place') return <MapPin size={17} />
  if (type === 'category') return <Tag size={17} />
  return type === 'item' ? <Package size={17} /> : <QrCode size={17} />
}

export function QrWorkspace({ state, language, loading, routeLabelId, targetPath, labelPath, onNavigate, onSave, onDeactivate, onScan }: QrWorkspaceProps) {
  const de = language === 'de'
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [targetType, setTargetType] = useState<InventoryQrTargetType>('item')
  const [targetId, setTargetId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [lookup, setLookup] = useState('')
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')

  const targetOptions = useMemo(() => {
    if (targetType === 'record') return state.records.map((record) => {
      const item = state.items.find((candidate) => candidate.id === record.itemId)
      const location = state.locations.find((candidate) => candidate.id === record.locationId)
      return { id: record.id, label: `${record.label || item?.name || record.id} · ${location?.name || record.locationId}` }
    })
    if (targetType === 'item') return state.items.filter((item) => item.active).map((item) => ({ id: item.id, label: `${item.sku ? `${item.sku} · ` : ''}${item.name}` }))
    if (targetType === 'place') return state.locations.filter((location) => location.active).map((location) => ({ id: location.id, label: `${location.code ? `${location.code} · ` : ''}${location.name}` }))
    return state.categories.map((category) => ({ id: category, label: category }))
  }, [state.categories, state.items, state.locations, state.records, targetType])
  const labels = useMemo(() => state.qrLabels ?? [], [state.qrLabels])
  const selectedLabel = labels.find((label) => label.id === selectedId)
  const editingLabel = labels.find((label) => label.id === editingId)
  const visibleLabels = labels.filter((label) => {
    const needle = filter.trim().toLowerCase()
    return !needle || `${label.name} ${targetDescription(label, state)} ${label.targetType}`.toLowerCase().includes(needle)
  })

  useEffect(() => {
    if (!targetOptions.some((option) => option.id === targetId)) setTargetId(targetOptions[0]?.id ?? '')
  }, [targetId, targetOptions])

  useEffect(() => {
    if (!routeLabelId) return
    const label = labels.find((candidate) => candidate.id === routeLabelId)
    if (!label) { setNotice(de ? 'Dieses QR-Etikett wurde nicht gefunden.' : 'This QR label was not found.'); return }
    setSelectedId(label.id)
    if (!label.active) { setNotice(de ? 'Dieses QR-Etikett wurde deaktiviert und öffnet kein Ziel mehr.' : 'This QR label has been deactivated and no longer opens a destination.'); return }
    setNotice(de ? `Etikett „${label.name}“ erkannt. Ziel wird geöffnet …` : `Label “${label.name}” recognized. Opening its destination…`)
    const timer = window.setTimeout(() => onNavigate(targetPath(label.targetType, label.targetId)), 700)
    return () => window.clearTimeout(timer)
  }, [de, labels, onNavigate, routeLabelId, targetPath])

  useEffect(() => {
    if (!selectedLabel) { setQrImage(''); return }
    const url = new URL(labelPath(selectedLabel.id), window.location.origin).toString()
    void QRCode.toDataURL(url, { margin: 2, width: 420, errorCorrectionLevel: 'M' }).then(setQrImage)
  }, [labelPath, selectedLabel])

  function beginEdit(label: InventoryQrLabel) {
    setEditingId(label.id); setName(label.name); setTargetType(label.targetType); setTargetId(label.targetId); setSelectedId(label.id); setNotice('')
  }

  function resetForm() {
    setEditingId(''); setName(''); setTargetType('item'); setTargetId(''); setNotice('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const id = editingId || crypto.randomUUID()
    const saved = await onSave(id, { id, name, targetType, targetId, active: editingLabel?.active ?? true }, !editingId)
    if (saved) { setSelectedId(id); setEditingId(''); setName(''); setNotice(de ? 'QR-Etikett gespeichert. Jetzt herunterladen oder drucken und am Gegenstand anbringen.' : 'QR label saved. Download or print it, then attach it to the physical object.') }
  }

  function openLookup() {
    const value = lookup.trim()
    if (!value) return
    const direct = labels.find((label) => label.id === value)
    if (direct) { onNavigate(labelPath(direct.id)); return }
    try {
      const url = new URL(value, window.location.origin)
      if (url.origin !== window.location.origin) throw new Error()
      onNavigate(`${url.pathname}${url.search}`)
    } catch { setNotice(de ? 'Bitte einen QR-Etikett-Code oder einen Link von dieser Inventarseite einfügen.' : 'Paste a QR label id or a link from this inventory site.') }
  }

  function downloadLabel() {
    if (!selectedLabel || !qrImage) return
    const link = document.createElement('a')
    link.href = qrImage
    link.download = `${selectedLabel.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'inventory-label'}.png`
    document.body.append(link); link.click(); link.remove()
  }

  return <div className="qr-workspace">
    {notice && <div className="qr-notice" role="status"><Check size={17} />{notice}</div>}
    <section className="inventory-panel qr-introduction">
      <div><span className="eyebrow">{de ? 'Physische Etiketten verwalten' : 'Manage physical labels'}</span><h2><QrCode size={23} /> {de ? 'QR-Etiketten' : 'QR labels'}</h2><p>{de ? 'Ein Etikett öffnet nach dem Scannen direkt den richtigen Artikel, Bestand oder Lagerort.' : 'A label opens the correct item, stock position, or storage place immediately after scanning.'}</p></div>
      <ol><li><strong>1</strong><span>{de ? 'Ziel auswählen' : 'Choose destination'}</span></li><li><strong>2</strong><span>{de ? 'Etikett speichern' : 'Save label'}</span></li><li><strong>3</strong><span>{de ? 'Drucken und aufkleben' : 'Print and attach'}</span></li></ol>
    </section>

    <div className="qr-primary-grid">
      <section className="inventory-panel qr-label-editor">
        <div className="qr-section-heading"><div><h3>{editingId ? (de ? 'Etikett bearbeiten' : 'Edit label') : (de ? 'Neues Etikett erstellen' : 'Create a label')}</h3><p>{editingId ? (de ? 'Das gedruckte Etikett behält seinen Code; Sie ändern nur Name oder Ziel.' : 'The printed code remains valid; only its name or destination changes.') : (de ? 'Geben Sie dem physischen Aufkleber einen eindeutigen Namen.' : 'Give the physical sticker an unambiguous name.')}</p></div>{editingId && <button className="secondary-action" type="button" onClick={resetForm}>{de ? 'Abbrechen' : 'Cancel'}</button>}</div>
        <form className="qr-label-form" onSubmit={submit}>
          <label>{de ? 'Etikettname' : 'Label name'}<input autoFocus placeholder={de ? 'z. B. Regal A – Fach 3' : 'e.g. Shelf A – bin 3'} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{de ? 'Öffnet' : 'Opens'}<select value={targetType} onChange={(event) => { setTargetType(event.target.value as InventoryQrTargetType); setTargetId('') }}><option value="item">{de ? 'Artikel (alle Bestände)' : 'Item (all stock)'}</option><option value="record">{de ? 'Bestimmte Bestandsposition' : 'Specific stock position'}</option><option value="place">{de ? 'Lagerort / Regal / Fach' : 'Location / shelf / bin'}</option><option value="category">{de ? 'Kategorie' : 'Category'}</option></select></label>
          <label className="qr-label-target">{de ? 'Ziel' : 'Destination'}<select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">—</option>{targetOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <div className="qr-form-explanation">{targetIcon(targetType)}<span>{targetExplanation(targetType, de)}</span></div>
          <button className="primary-action" disabled={loading || !name.trim() || !targetId} type="submit"><QrCode size={17} />{editingId ? (de ? 'Änderungen speichern' : 'Save changes') : (de ? 'Etikett erstellen' : 'Create label')}</button>
        </form>
      </section>

      <section className="inventory-panel qr-label-preview">
        <div className="qr-section-heading"><div><h3>{de ? 'Druckvorschau' : 'Print preview'}</h3><p>{de ? 'Etikett auswählen, herunterladen oder direkt drucken.' : 'Select a label, then download or print it.'}</p></div></div>
        {selectedLabel && qrImage ? <div className="qr-print-card"><div className="qr-print-brand">DIGITAL CORE OFFICE · INVENTORY</div><img alt={`${selectedLabel.name} QR`} src={qrImage} /><strong>{selectedLabel.name}</strong><span>{targetDescription(selectedLabel, state)}</span><small>{selectedLabel.id}</small></div> : <div className="qr-preview-empty"><QrCode size={44} /><strong>{de ? 'Noch kein Etikett ausgewählt' : 'No label selected'}</strong><span>{de ? 'Erstellen Sie links ein Etikett oder wählen Sie unten eines aus.' : 'Create a label on the left or select one below.'}</span></div>}
        <div className="qr-preview-actions"><button className="secondary-action" disabled={!qrImage} type="button" onClick={downloadLabel}><Download size={16} /> PNG</button><button className="primary-action" disabled={!qrImage} type="button" onClick={() => window.print()}><Printer size={16} />{de ? 'Drucken' : 'Print'}</button>{selectedLabel?.active && <button className="secondary-action" type="button" onClick={() => onNavigate(targetPath(selectedLabel.targetType, selectedLabel.targetId))}><ExternalLink size={16} />{de ? 'Ziel testen' : 'Test destination'}</button>}</div>
      </section>
    </div>

    <section className="inventory-panel qr-label-library">
      <div className="qr-section-heading"><div><h3>{de ? 'Vorhandene Etiketten' : 'Existing labels'}</h3><p>{de ? 'Bearbeiten ändert das Ziel eines vorhandenen Aufklebers. Deaktivieren sperrt ihn, ohne die Historie zu löschen.' : 'Editing changes where an existing sticker leads. Deactivating blocks it without deleting its history.'}</p></div><label className="qr-search"><Search size={16} /><input placeholder={de ? 'Etiketten suchen' : 'Search labels'} value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
      {visibleLabels.length === 0 ? <div className="qr-library-empty"><QrCode size={34} /><strong>{de ? 'Noch keine verwalteten QR-Etiketten' : 'No managed QR labels yet'}</strong><span>{de ? 'Ältere direkt erzeugte Codes funktionieren weiter. Neue Etiketten erscheinen nach dem Speichern hier.' : 'Older direct codes continue to work. New managed labels appear here after saving.'}</span></div> : <div className="qr-label-list">{visibleLabels.map((label) => <article className={`qr-label-row${label.active ? '' : ' is-inactive'}`} key={label.id}><button className="qr-label-main" type="button" onClick={() => setSelectedId(label.id)}>{targetIcon(label.targetType)}<span><strong>{label.name}</strong><small>{targetDescription(label, state)}</small></span><span className={`status-note ${label.active ? 'success' : 'muted-state'}`}>{label.active ? (de ? 'Aktiv' : 'Active') : (de ? 'Deaktiviert' : 'Inactive')}</span></button><div className="qr-label-actions"><button className="icon-action" title={de ? 'Bearbeiten' : 'Edit'} type="button" onClick={() => beginEdit(label)}><Edit3 size={16} /></button>{label.active ? <button className="icon-action danger" title={de ? 'Deaktivieren' : 'Deactivate'} type="button" onClick={() => void onDeactivate(label.id)}><ShieldOff size={16} /></button> : <button className="icon-action" title={de ? 'Reaktivieren' : 'Reactivate'} type="button" onClick={() => void onSave(label.id, { ...label, active: true }, false)}><RotateCcw size={16} /></button>}</div></article>)}</div>}
    </section>

    <section className="inventory-panel qr-desktop-lookup">
      <div className="qr-section-heading"><div><h3>{onScan ? (de ? 'Code scannen oder öffnen' : 'Scan or open a code') : (de ? 'Code am Desktop öffnen' : 'Open a code on desktop')}</h3><p>{onScan ? (de ? 'Nutzen Sie den sicheren Systemscanner oder fügen Sie einen Link beziehungsweise eine Etikett-ID ein.' : 'Use the secure system scanner, or paste a link or label id.') : (de ? 'Am Desktop ist keine Kamera nötig. Fügen Sie einfach den Link oder die Etikett-ID ein. Die Kamera-Funktion bleibt in der mobilen Inventar-App.' : 'A desktop camera is unnecessary. Paste the link or label id instead; camera scanning remains in the mobile inventory app.')}</p></div>{onScan && <button className="primary-action" disabled={loading} type="button" onClick={() => void onScan()}><QrCode size={16} />{de ? 'QR scannen' : 'Scan QR'}</button>}</div>
      <div className="qr-lookup-row"><label><Search size={16} /><input placeholder={de ? 'QR-Link oder Etikett-ID einfügen' : 'Paste QR link or label id'} value={lookup} onChange={(event) => setLookup(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') openLookup() }} /></label><button className="secondary-action" disabled={!lookup.trim()} type="button" onClick={openLookup}>{de ? 'Öffnen' : 'Open'}</button></div>
    </section>
  </div>
}

function targetDescription(label: InventoryQrLabel, state: InventoryStatePayload) {
  if (label.targetType === 'item') { const item = state.items.find((entry) => entry.id === label.targetId); return item ? `${item.sku ? `${item.sku} · ` : ''}${item.name}` : label.targetId }
  if (label.targetType === 'place') { const place = state.locations.find((entry) => entry.id === label.targetId); return place ? `${place.code ? `${place.code} · ` : ''}${place.name}` : label.targetId }
  if (label.targetType === 'record') { const record = state.records.find((entry) => entry.id === label.targetId); const item = record && state.items.find((entry) => entry.id === record.itemId); return record ? `${record.label || item?.name || record.id} · ${record.quantity}` : label.targetId }
  return label.targetId
}

function targetExplanation(type: InventoryQrTargetType, de: boolean) {
  if (type === 'place') return de ? 'Für Türen, Regale, Schränke und Fächer. Öffnet den Lagerort mit seinem gesamten Inhalt.' : 'For doors, shelves, cabinets, and bins. Opens the place and everything stored there.'
  if (type === 'record') return de ? 'Für ein einzelnes physisches Teil oder eine bestimmte Charge an einem Lagerort.' : 'For one physical asset or a specific batch at one location.'
  if (type === 'category') return de ? 'Öffnet alle Artikel einer Kategorie.' : 'Opens every item in a category.'
  return de ? 'Für eine Artikelart. Öffnet alle vorhandenen Bestände und Lagerorte dieses Artikels.' : 'For an item type. Opens all stock and locations for that item.'
}
