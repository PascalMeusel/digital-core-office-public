import { createContext, useContext, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Field } from './WorkflowField.tsx'
import { emptyArrival, orderReceiptDraft, hasOrderReceiptDraft, type ArrivalDraft, type OrderReceiptDraft, type UnorderedReceiptDraft } from './receivingDraft.ts'
import { PurchaseListImport } from './PurchaseListImport.tsx'
import type { PurchasePart, PurchaseListRow } from '../shared/purchaseList.ts'
import { UnitSelect, EuroInput, CatalogHistory } from './InventoryCatalog.tsx'
import { catalogLink, euroPrice } from '../shared/catalog.ts'
import type { InventoryAssignment, InventoryProject, InventoryRecord, InventoryStatePayload } from '../shared/inventory.ts'
import { availableStock, buildRequirements, emptyWorkflows, groupWorkRequests, inventorySupply, materialUsageCosts, orderLineCosts, projectPartIds, roundQuantity, stockRequestIssued, usableStock, type InventoryBuild, type InventoryProduct, type InventoryPurchaseOrder, type InventoryWorkRequest, type ItemSupply, type ProductPart } from '../shared/workflows.ts'
import { inventorySearchScore } from '../shared/search.ts'
import { locationDescendantIds, locationPaths } from '../shared/locations.ts'
import { matchingProcurement, orderDraftTotals, requestReference, selectRequestGroups, type ProjectScope, type RequestView } from '../shared/workflowViews.ts'
import './InventoryWorkflows.css'
import { ClickUpProject, ClickUpRequest } from './InventoryClickUp.tsx'
import { WorkflowDialog, WorkspaceTabs } from './InventoryWorkspace.tsx'

type Mutation = (path: string, body: Record<string, unknown>, method?: 'POST' | 'PATCH') => Promise<boolean>
type WorkflowTab = 'overview' | 'projects' | 'products' | 'inventory' | 'orders' | 'requests'
type RequestDecision = 'defer' | 'changes' | 'reject' | 'reopen'
type Editor = { type: 'requestDecision'; request: InventoryWorkRequest; action: RequestDecision } | { type: 'need'; projectId?: string } | { type: 'request'; initial?: Partial<InventoryWorkRequest>; request?: InventoryWorkRequest } | { type: 'product'; product?: InventoryProduct } | { type: 'build'; projectId?: string } | { type: 'project'; project?: InventoryProject } | { type: 'receive' } | { type: 'receiveOrder'; order?: InventoryPurchaseOrder } | { type: 'order'; requestIds?: string[] } | { type: 'reviewBatch'; requests: InventoryWorkRequest[] } | { type: 'move'; record: InventoryRecord } | { type: 'use'; assignment: InventoryAssignment } | { type: 'fulfill'; request: InventoryWorkRequest } | { type: 'complete'; build: InventoryBuild } | { type: 'reserve'; build: InventoryBuild; itemId: string }
interface Context {
  state: InventoryStatePayload; de: boolean; busy: boolean; mutate: Mutation; clearError: () => void; edit: (editor: Editor | null) => void
  can: (permission: InventoryStatePayload['permissions'][number]) => boolean
  t: (en: string, de: string) => string; money: (value: number) => string; projectName: (id?: string) => string; placeName: (id: string) => string
  openRecord: (id: string) => void; openPlace: (id: string) => void
}
const WorkflowContext = createContext<Context | null>(null)
function useWorkflow() { const context = useContext(WorkflowContext); if (!context) throw new Error('Workflow provider missing'); return context }
const general = (de: boolean) => de ? 'Allgemeiner Bedarf / Experimente' : 'General supplies / experiments'
const formValue = (form: FormData, key: string) => String(form.get(key) ?? '')

export function InventoryWorkflowProvider({ state, language, loading, suspended = false, error, onMutation, onClearError, onOpenRecord, onOpenPlace, children }: { state: InventoryStatePayload; language: 'en' | 'de'; loading: boolean; suspended?: boolean; error?: string; onMutation: Mutation; onClearError: () => void; onOpenRecord: (id: string) => void; onOpenPlace: (id: string) => void; children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saved, setSaved] = useState('')
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const retryKeys = useRef(new Map<string, string>())
  const de = language === 'de'
  async function mutate(path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') {
    if (pendingRef.current) return false
    pendingRef.current = true; setPending(true); setSaved('')
    const signature = path + JSON.stringify(body)
    const idempotencyKey = retryKeys.current.get(signature) ?? crypto.randomUUID()
    retryKeys.current.set(signature, idempotencyKey)
    try {
      const result = await onMutation(path, { ...body, idempotencyKey }, method)
      if (result) { retryKeys.current.delete(signature); setSaved(path === '/workflows/requests/batch' ? (de ? 'Anfrage gesendet. Die Freigabe ist der nächste Schritt; den Fortschritt findest du unter Anfragen.' : 'Request sent. Approval is next; follow its progress in Requests.') : path === '/workflows/requests' && body.kind === 'stock' ? (de ? 'Bestand angefragt. Das Ausgabeteam bestätigt Menge und Lagerort; den Fortschritt findest du unter Anfragen.' : 'Stock requested. The handout team will confirm quantity and place; follow its progress in Requests.') : path.startsWith('/workflows/orders/') && path.endsWith('/receive') ? (de ? 'Wareneingang gespeichert. Nicht gelieferte Mengen bleiben offen.' : 'Delivery saved. Undelivered quantities remain open.') : (de ? 'Gespeichert.' : 'Saved.')) }
      return result
    } finally { pendingRef.current = false; setPending(false) }
  }
  const placeLabels = locationPaths(state.locations)
  const value: Context = { state, de, busy: loading || pending, mutate, clearError: onClearError, edit: setEditor, can: permission => state.permissions.includes(permission), t: (en, german) => de ? german : en, money: value => new Intl.NumberFormat(language, { style: 'currency', currency: 'EUR' }).format(value), projectName: id => state.projects.find(p => p.id === id)?.name ?? general(de), placeName: id => placeLabels.get(id) ?? (de ? 'Unbekannter Ort' : 'Unknown place'), openRecord: onOpenRecord, openPlace: onOpenPlace }
  return <WorkflowContext.Provider value={value}><div className="inventory-workflows">
    {!editor && error && <div className="inventory-error" role="alert">{error}</div>}
    <div role="status" className="workflow-feedback">{saved}</div>
    {editor && <WorkflowDialog key={JSON.stringify(editor)} open={!suspended} onClose={() => setEditor(null)} de={de} error={error}><WorkflowEditor editor={editor} /></WorkflowDialog>}
    {children}
  </div></WorkflowContext.Provider>
}
function Page({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="inventory-panel workflow-page"><header className="workspace-page-header workspace-page-header-compact"><div><h2>{title}</h2><p>{description}</p></div><div className="form-actions">{actions}</div></header><div className="workflow-body">{children}</div></section>
}
function Action({ children, onClick }: { children: ReactNode; onClick: () => void }) { const { busy } = useWorkflow(); return <button className="secondary-action" type="button" disabled={busy} onClick={onClick}>{children}</button> }
function TextAction({ children, onClick }: { children: ReactNode; onClick: () => void }) { const { busy } = useWorkflow(); return <button className="workflow-text-action" type="button" disabled={busy} onClick={onClick}>{children}</button> }
function Primary({ children, onClick }: { children: ReactNode; onClick: () => void }) { const { busy } = useWorkflow(); return <button className="primary-action" type="button" disabled={busy} onClick={onClick}>{children}</button> }
function Empty({ children }: { children: ReactNode }) { return <p className="empty-note">{children}</p> }
function Quantity({ name = 'quantity', value = 1, max, label, step = 'any' }: { name?: string; value?: number; max?: number; label?: string; step?: string }) { const { t } = useWorkflow(); return <Field label={label ?? t('Quantity', 'Menge')}><input name={name} type="number" required min={step === '1' ? 1 : 0.000001} max={max} step={step} defaultValue={value} /></Field> }
function ProjectSelect({ value, onChange }: { value?: string; onChange?: (value: string) => void }) { const { state, de, t } = useWorkflow(); return <Field label={t('For', 'Für')}><select name="projectId" defaultValue={value ?? ''} onChange={e => onChange?.(e.target.value)}><option value="">{general(de)}</option>{state.projects.filter(p => p.active || p.id === value).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field> }
function SearchSelect({ label, name, options, value, onChange, required = true, emptyLabel }: { label: string; name: string; options: { id: string; name: string }[]; value?: string; onChange?: (value: string) => void; required?: boolean; emptyLabel?: string }) {
  const { t } = useWorkflow(); const [query, setQuery] = useState(''); const [selected, setSelected] = useState(value ?? '')
  const active = value ?? selected
  return <div className="workflow-picker"><Field label={t(`Find ${label.toLowerCase()}`, `${label} suchen`)}><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></Field><Field label={label}><select name={name} required={required} value={active} onChange={e => { setSelected(e.target.value); onChange?.(e.target.value) }}><option value="">{emptyLabel ?? t('Choose…', 'Auswählen…')}</option>{options.filter(o => o.id === active || inventorySearchScore(query, [o.name])).map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></Field></div>
}
function ItemSelect({ value, onChange, required = true }: { value?: string; onChange?: (id: string) => void; required?: boolean }) { const { state, t } = useWorkflow(); return <SearchSelect name="itemId" label={t('Item', 'Artikel')} options={state.items.filter(i => i.active).map(i => ({ id: i.id, name: [i.name, i.sku, i.manufacturerPartNumber, i.value, i.packageForm].filter(Boolean).join(' · ') }))} value={value} onChange={onChange} required={required} emptyLabel={required ? undefined : t('New item — enter its name below', 'Neuer Artikel – Name unten eingeben')} /> }
function storagePlaces(state: InventoryStatePayload) {
  const paths = locationPaths(state.locations)
  return state.locations.filter(place => place.active).map(place => ({ id: place.id, name: [paths.get(place.id), place.rack, place.bin].filter(Boolean).join(' · ') })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}
function PlaceSelect({ name = 'locationId' }: { name?: string }) { const { state, t } = useWorkflow(); return <SearchSelect name={name} label={t('Storage place', 'Lagerort')} options={storagePlaces(state)} /> }
function Status({ request }: { request: InventoryWorkRequest }) { const { t, state } = useWorkflow(); const received = requestDelivery(request, state).received; const status = request.kind === 'purchase' && request.status === 'ordered' && received > 0 ? 'partial' : request.kind === 'stock' && request.status === 'pending' && stockRequestIssued(request) > 0 ? 'partial' : request.status; const labels = { pending: request.kind === 'stock' ? t('Awaiting handout', 'Wartet auf Ausgabe') : t('Awaiting approval', 'Wartet auf Freigabe'), partial: request.kind === 'stock' ? t('Partly handed out', 'Teilweise ausgegeben') : t('Partly received', 'Teilweise eingegangen'), deferred: t('Deferred', 'Zurückgestellt'), changes_requested: t('Changes requested', 'Änderung erbeten'), approved: t('Approved · order next', 'Freigegeben · jetzt bestellen'), ordered: t('Ordered', 'Bestellt'), fulfilled: request.kind === 'stock' ? t('Handed out', 'Ausgegeben') : t('Received', 'Eingegangen'), cancelled: t('Closed', 'Geschlossen') }; return <span className={`workflow-status workflow-status-${status}`}>{labels[status]}</span> }
function Table({ heads, children }: { heads: string[]; children: ReactNode }) { return <div className="table-scroll"><table className="workflow-table"><thead><tr>{heads.map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{children}</tbody></table></div> }

export function WorkflowHome({ onNavigate }: { onNavigate: (tab: WorkflowTab) => void }) {
  const { state, t, can, edit } = useWorkflow(); const w = state.workflows ?? emptyWorkflows
  const incoming = w.orders.filter(o => o.lines.some(l => l.receivedQuantity < l.quantity))
  const approvals = w.requests.filter(r => r.kind === 'purchase' && ['pending', 'deferred'].includes(r.status))
  const handouts = w.requests.filter(r => r.kind === 'stock' && r.status === 'pending')
  const own = w.requests.filter(r => r.requesterId === state.currentUser.id && !['cancelled', 'fulfilled'].includes(r.status))
  const toOrder = w.requests.filter(r => r.status === 'approved' && r.reviewedBy === state.currentUser.id)
  const history = groupWorkRequests(w.requests.filter(r => r.requesterId === state.currentUser.id)).filter(group => group.every(r => ['cancelled', 'fulfilled'].includes(r.status))).flat()
  const review = () => document.getElementById('workflow-approvals')?.scrollIntoView({ block: 'start' })
  const description = can('order_stock') ? t('Review requests together, then place the approved orders.', 'Anfragen gemeinsam prüfen und freigegebene Teile bestellen.') : can('receive_stock') ? t('Receive packages and hand out requested parts.', 'Pakete einlagern und angefragte Teile ausgeben.') : t('Request parts for your project and track what happens next.', 'Teile für dein Projekt anfragen und den Fortschritt verfolgen.')
  return <Page title={t('My work', 'Meine Arbeit')} description={description} actions={<>{can('order_stock') && <Primary onClick={review}>{t('Review requests', 'Anfragen prüfen')}</Primary>}{can('receive_stock') && (can('order_stock') ? <Action onClick={() => edit({ type: 'receiveOrder' })}>{t('Receive delivery', 'Lieferung einbuchen')}</Action> : <Primary onClick={() => edit({ type: 'receiveOrder' })}>{t('Receive delivery', 'Lieferung einbuchen')}</Primary>)}{can('request_stock') && (can('receive_stock') || can('order_stock') ? <Action onClick={() => edit({ type: 'request' })}>{t('Request multiple parts', 'Mehrere Teile anfragen')}</Action> : <Primary onClick={() => edit({ type: 'need' })}>{t('I need something', 'Ich brauche etwas')}</Primary>)}{can('request_stock') && (can('receive_stock') || can('order_stock') ? <Action onClick={() => edit({ type: 'need' })}>{t('I need something', 'Ich brauche etwas')}</Action> : <Action onClick={() => edit({ type: 'request' })}>{t('Request multiple parts', 'Mehrere Teile anfragen')}</Action>)}{can('receive_stock') && <TextAction onClick={() => edit({ type: 'receive' })}>{t('Receive without an order', 'Eingang ohne Bestellung')}</TextAction>}</>}>
    <div className="workflow-summary">
      {can('order_stock') && <button type="button" onClick={() => document.getElementById('workflow-approvals')?.scrollIntoView({ block: 'start' })}><strong>{groupWorkRequests(approvals).length}</strong>{t('Requests to review', 'Anfragen zur Freigabe')}</button>}
      {can('order_stock') && <button type="button" onClick={() => onNavigate('orders')}><strong>{groupWorkRequests(toOrder).length}</strong>{t('Requests to order', 'Anfragen zu bestellen')}</button>}
      {can('receive_stock') && <button type="button" onClick={() => edit({ type: 'receiveOrder' })}><strong>{incoming.length}</strong>{t('Incoming orders', 'Erwartete Bestellungen')}</button>}
      {can('fulfill_requests') && <button type="button" onClick={() => document.getElementById('workflow-handouts')?.scrollIntoView({ block: 'start' })}><strong>{handouts.length}</strong>{t('To hand out', 'Auszugeben')}</button>}
      <button type="button" onClick={() => onNavigate('inventory')}><strong>{state.items.length}</strong>{t('Find stock & places', 'Bestand und Orte finden')}</button>
    </div>
    {can('order_stock') && <section id="workflow-approvals"><h3>{t('Purchase requests to review', 'Kaufanfragen zur Freigabe')}</h3><RequestList requests={approvals} /></section>}
    {can('fulfill_requests') && <section id="workflow-handouts"><h3>{t('Stock to hand out', 'Bestand ausgeben')}</h3><RequestList requests={handouts} /></section>}
    <section><h3>{t('My open requests', 'Meine offenen Anfragen')}</h3><RequestList requests={own} /></section>
    <section><h3>{t('Items assigned to me', 'Mir zugewiesene Artikel')}</h3><Assignments assignments={state.assignments.filter(a => a.userId === state.currentUser.id && !a.buildId && !a.returnedAt && a.quantity > 0)} /></section>
    <details><summary>{t('My request history', 'Meine bisherigen Anfragen')}</summary><RequestList requests={history} /></details>
  </Page>
}
export function WorkflowRequests() {
  const { t, can, edit } = useWorkflow()
  return <Page title={t('Requests', 'Anfragen')} description={t('Purchase requests and stock requests, kept together from submission to completion.', 'Kauf- und Bestandsanfragen bleiben vom Absenden bis zum Abschluss zusammen.')} actions={can('request_stock') && <><Primary onClick={() => edit({ type: 'need' })}>{t('I need something', 'Ich brauche etwas')}</Primary><Action onClick={() => edit({ type: 'request' })}>{t('Request multiple parts', 'Mehrere Teile anfragen')}</Action></>}>
    <RequestQueue scope={{ kind: 'all' }} />
  </Page>
}
function RequestQueue({ scope }: { scope: ProjectScope }) {
  const { state, t, de } = useWorkflow()
  const [view, setView] = useState<RequestView>('open'), [query, setQuery] = useState(''), [projectId, setProjectId] = useState('all')
  const project: ProjectScope = scope.kind === 'project' ? scope : projectId === 'all' ? { kind: 'all' } : { kind: 'project', id: projectId }
  const groups = selectRequestGroups(state, { view, query, project }), requests = groups.flat()
  const filtered = view !== 'open' || Boolean(query) || (scope.kind === 'all' && projectId !== 'all')
  return <section className="request-queue" aria-label={t('Request overview', 'Anfrageübersicht')}>
    <div className="workflow-filters">
      <Field label={t('Show requests', 'Anfragen anzeigen')}><select value={view} onChange={e => setView(e.target.value as RequestView)}>
        <option value="open">{t('Open', 'Offen')}</option><option value="mine">{t('My requests', 'Meine Anfragen')}</option><option value="action">{t('Needs my action', 'Für mich zu erledigen')}</option>
        <option value="approval">{t('Awaiting approval', 'Wartet auf Freigabe')}</option><option value="deferred">{t('Deferred', 'Zurückgestellt')}</option><option value="changes">{t('Changes requested', 'Änderung erbeten')}</option><option value="approved">{t('Approved · order next', 'Freigegeben · jetzt bestellen')}</option><option value="ordered">{t('Awaiting delivery', 'Wartet auf Lieferung')}</option><option value="handout">{t('Awaiting handout', 'Wartet auf Ausgabe')}</option><option value="closed">{t('Completed or withdrawn', 'Abgeschlossen oder zurückgezogen')}</option><option value="all">{t('All, including completed', 'Alle, auch abgeschlossene')}</option>
      </select></Field>
      {scope.kind === 'all' && <Field label={t('Project filter', 'Projektfilter')}><select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="all">{t('All projects & general supplies', 'Alle Projekte & allgemeiner Bedarf')}</option><option value="">{general(de)}</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.code} · {project.name}{!project.active && ` (${t('Archived', 'Archiviert')})`}</option>)}</select></Field>}
      <Field label={t('Search requests', 'Anfragen suchen')}><input type="search" value={query} placeholder={t('Part, person, supplier or reference…', 'Teil, Person, Lieferant oder Nummer…')} onChange={e => setQuery(e.target.value)} /></Field>
    </div>
    <div className="need-catalog-heading"><p role="status" className="workflow-count">{groups.length} {t('requests', 'Anfragen')} · {requests.length} {t('positions', 'Positionen')}{groups.some(group => group.length > 1) && <small>{t('Grouped requests always show all their positions.', 'Sammelanfragen werden immer mit allen Positionen angezeigt.')}</small>}</p>{filtered && <TextAction onClick={() => { setView('open'); setQuery(''); setProjectId('all') }}>{t('Clear filters', 'Filter zurücksetzen')}</TextAction>}</div>
    {requests.length ? <RequestList requests={requests} /> : <Empty>{filtered ? t('No requests match these filters. Clear the filters or choose another project.', 'Keine Anfragen passen zu diesen Filtern. Filter zurücksetzen oder ein anderes Projekt wählen.') : t('No open requests here. Completed requests remain available under “All, including completed”.', 'Hier sind keine offenen Anfragen. Abgeschlossene findest du weiterhin unter „Alle, auch abgeschlossene“.')}</Empty>}
  </section>
}
function RequestList({ requests }: { requests: InventoryWorkRequest[] }) {
  const { state, t, can, edit, projectName, mutate } = useWorkflow()
  if (!requests.length) return <Empty>{t('Nothing waiting here.', 'Hier ist nichts offen.')}</Empty>
  return <><div className="workflow-list">{groupWorkRequests(requests, (state.workflows ?? emptyWorkflows).requests).map(group => {
    const first = group[0], batch = group.length > 1 && first.batchId
    const pending = group.filter(r => r.status === 'pending'), reviewable = group.filter(r => ['pending', 'deferred'].includes(r.status))
    const approved = group.filter(r => r.status === 'approved' && r.reviewedBy === state.currentUser.id)
    return <section key={first.batchId ?? first.id} className={batch ? 'workflow-request-batch' : undefined} data-batch-id={first.batchId}>
      {batch && <header className="workflow-batch-header"><div><h4>{t('Purchase request', 'Sammelanfrage')} · {projectName(first.projectId)}</h4><small>{requestReference(first)} · {group.length} {t('positions', 'Positionen')} · {state.users.find(u => u.id === first.requesterId)?.name ?? t('Colleague', 'Kollege')}</small></div>
        {can('order_stock') && <div className="form-actions">{pending.length > 0 && <Action onClick={() => void mutate(`/workflows/request-batches/${first.batchId}/review`, { lines: pending.map(r => ({ requestId: r.id, expectedVersion: r.version, decision: 'approve' })) })}>{t('Approve open positions', 'Offene Positionen freigeben')} ({pending.length})</Action>}{reviewable.length > 0 && <Action onClick={() => edit({ type: 'reviewBatch', requests: reviewable })}>{t('Review positions', 'Positionen prüfen')}</Action>}{approved.length > 0 && <Action onClick={() => edit({ type: 'order', requestIds: approved.map(r => r.id) })}>{t('Order approved positions', 'Freigegebene Positionen bestellen')} ({approved.length})</Action>}</div>}
      </header>}
      {group.map(r => <article className="workflow-row" key={r.id} data-request-id={r.id}>
    <RequestDetails request={r} /><div className="workflow-row-actions"><Status request={r} />
      {!batch && can('order_stock') && r.kind === 'purchase' && ['pending', 'deferred'].includes(r.status) && <><Action onClick={() => void mutate(`/workflows/requests/${r.id}/review`, { expectedVersion: r.version, decision: 'approve' })}>{t('Approve purchase', 'Kauf freigeben')}</Action><Action onClick={() => edit({ type: 'requestDecision', request: r, action: 'defer' })}>{t('Defer', 'Zurückstellen')}</Action><Action onClick={() => edit({ type: 'requestDecision', request: r, action: 'changes' })}>{t('Request changes', 'Änderung anfragen')}</Action><Action onClick={() => edit({ type: 'requestDecision', request: r, action: 'reject' })}>{t('Decline', 'Ablehnen')}</Action></>}
      {can('order_stock') && r.status === 'approved' && r.reviewedBy === state.currentUser.id && <>{!batch && <Action onClick={() => edit({ type: 'order', requestIds: [r.id] })}>{t('Record supplier order', 'Bestellung erfassen')}</Action>}<Action onClick={() => edit({ type: 'requestDecision', request: r, action: 'reopen' })}>{t('Price changed', 'Preis geändert')}</Action></>}
      {can('fulfill_requests') && r.kind === 'stock' && r.status === 'pending' && <Action onClick={() => edit({ type: 'fulfill', request: r })}>{t('Hand out', 'Ausgeben')}</Action>}
      {r.requesterId === state.currentUser.id && can('request_stock') && stockRequestIssued(r) === 0 && ['pending', 'deferred', 'changes_requested'].includes(r.status) && <Action onClick={() => edit({ type: 'request', request: r })}>{batch ? t('Edit position', 'Position bearbeiten') : t('Edit request', 'Anfrage bearbeiten')}</Action>}
      {r.requesterId === state.currentUser.id && can('request_stock') && ['pending', 'deferred', 'changes_requested', 'approved'].includes(r.status) && <Action onClick={() => void mutate(`/workflows/requests/${r.id}/cancel`, { expectedVersion: r.version })}>{stockRequestIssued(r) > 0 ? t('Withdraw remaining quantity', 'Restmenge zurückziehen') : batch ? t('Withdraw position', 'Position zurückziehen') : t('Cancel request', 'Anfrage zurückziehen')}</Action>}
    </div></article>)}<ClickUpRequest requests={group} /></section>
  })}</div></>
}
function RequestDecisionForm({ request, action }: { request: InventoryWorkRequest; action: RequestDecision }) {
  const { t, edit, mutate } = useWorkflow()
  const labels = { defer: t('Defer', 'Zurückstellen'), changes: t('Request changes', 'Änderung anfragen'), reject: t('Decline', 'Ablehnen'), reopen: t('Price changed', 'Preis geändert') }
  return <InlineForm title={labels[action]} onCancel={() => edit(null)} submitLabel={t('Save decision', 'Entscheidung speichern')} onSubmit={async form => {
    if (await mutate(`/workflows/requests/${request.id}/${action === 'reopen' ? 'reopen' : 'review'}`, { expectedVersion: request.version, decision: action, note: formValue(form, 'note') })) edit(null)
  }}><div className="workflow-wide"><RequestDetails request={request} /></div><Field label={t('Reason', 'Begründung')}><textarea name="note" required maxLength={2000} data-dialog-focus /></Field></InlineForm>
}

function requestDelivery(request: InventoryWorkRequest, state: InventoryStatePayload) {
  const order = (state.workflows ?? emptyWorkflows).orders.find(o => o.id === request.orderId || o.lines.some(l => l.requestId === request.id))
  const lines = order?.lines.filter(l => l.requestId === request.id) ?? []
  const received = roundQuantity(lines.reduce((sum, line) => sum + line.receivedQuantity, 0))
  const locationIds = new Set(lines.flatMap(line => line.receipts).map(receipt => state.records.find(record => record.id === receipt.recordId)?.locationId).filter(Boolean))
  return { order, received, places: state.locations.filter(place => locationIds.has(place.id)) }
}
function RequestProgress({ request: r }: { request: InventoryWorkRequest }) {
  const { state, t, de, placeName } = useWorkflow(), { order, received, places } = requestDelivery(r, state)
  const user = (id?: string) => state.users.find(person => person.id === id)?.name ?? t('the responsible colleague', 'die zuständige Person')
  const stock = r.kind === 'stock', closed = r.status === 'cancelled', done = r.status === 'fulfilled'
  const supplied = stock ? stockRequestIssued(r) : received
  const remaining = roundQuantity(Math.max(0, r.quantity - supplied))
  const next = closed ? t('Closed. No further action for this position.', 'Geschlossen. Für diese Position ist nichts mehr zu tun.')
    : done ? stock ? r.usage === 'borrow' ? t('Handout completed. Borrowed items appear under “Items assigned to me”.', 'Ausgabe abgeschlossen. Ausgeliehene Teile stehen unter „Mir zugewiesene Artikel“.') : t('Handout completed. The material was booked as used.', 'Ausgabe abgeschlossen. Das Material wurde als Verbrauch gebucht.') : t('Delivery received. Current quantities and places are listed under Inventory.', 'Lieferung eingebucht. Aktuelle Mengen und Orte stehen unter Inventar.')
    : stock ? `${t('Next: handout team confirms', 'Als Nächstes: Das Ausgabeteam bestätigt')} ${remaining} ${r.unit}.`
    : r.status === 'changes_requested' ? `${t('Next:', 'Als Nächstes:')} ${user(r.requesterId)} ${t('edits the request using the review note, then resubmits it.', 'passt die Anfrage anhand der Rückmeldung an und sendet sie erneut.')}`
    : r.status === 'deferred' ? `${t('Waiting for a new decision by', 'Wartet auf erneute Entscheidung von')} ${user(r.reviewedBy)}. ${t('See the review note.', 'Siehe Begründung.')}`
    : r.status === 'approved' ? `${t('Next:', 'Als Nächstes:')} ${user(r.reviewedBy)} ${t('places the supplier order and records it here.', 'bestellt beim Lieferanten und erfasst die Bestellung hier.')}`
    : r.status === 'ordered' ? `${t('Waiting for delivery:', 'Wartet auf Lieferung:')} ${remaining} ${r.unit}. ${t('Receiving staff confirm arrivals and storage places.', 'Der Wareneingang bestätigt gelieferte Mengen und Lagerorte.')}`
    : t('Next: an approver reviews this request. Once approved, that person places the order.', 'Als Nächstes prüft eine freigabeberechtigte Person die Anfrage. Nach der Freigabe bestellt diese Person.')
  const stage = done ? (stock ? 2 : 4) : stock ? 1 : r.status === 'ordered' ? 3 : r.status === 'approved' ? 2 : 1
  const steps = stock ? [t('Requested', 'Angefragt'), t('Handout', 'Ausgabe')] : [t('Requested', 'Angefragt'), t('Approval', 'Freigabe'), t('Supplier order', 'Bestellung'), t('Receiving', 'Wareneingang')]
  return <div className="request-progress">
    <p className="request-next">{next}</p>
    {!stock && supplied > 0 && <small>{supplied} / {r.quantity} {r.unit} {t('received', 'eingegangen')}{!done && !closed && ` · ${remaining} ${r.unit} ${t('outstanding', 'offen')}`}</small>}
    <details><summary>{t('Request progress', 'Anfrageverlauf')}</summary>
      <ol className="request-steps">{steps.map((step, index) => <li key={step} className={!closed && index < stage ? 'is-complete' : undefined} aria-current={!closed && index === stage ? 'step' : undefined}><span>{step}</span>{index === 0 && <small>{user(r.requesterId)} · {new Date(r.createdAt).toLocaleDateString(de ? 'de-DE' : 'en-GB')}</small>}{!stock && index === 1 && r.reviewedBy && <small>{user(r.reviewedBy)}{r.status === 'deferred' ? ` · ${t('deferred', 'zurückgestellt')}` : r.status === 'changes_requested' ? ` · ${t('changes requested', 'Änderung erbeten')}` : ''}</small>}{!stock && index === 2 && order && <small>{order.reference} · {user(order.orderedBy)}</small>}{index === steps.length - 1 && <small>{supplied} / {r.quantity} {r.unit}</small>}</li>)}</ol>
      {order?.expectedDate && <small>{t('Expected delivery', 'Lieferung erwartet')}: {order.expectedDate}</small>}
      {places.length > 0 && <small>{t('Stock records at', 'Bestandsbuchungen bei')}: {places.map(p => placeName(p.id)).join(', ')}</small>}
      {closed && <small>{t('Remaining workflow stopped.', 'Weiterer Ablauf beendet.')}</small>}
    </details>
  </div>
}
function RequestDetails({ request: r }: { request: InventoryWorkRequest }) {
  const { state, t, money, projectName } = useWorkflow()
  return <div><strong>{r.quantity} {r.unit} · {r.itemName}</strong><small>{projectName(r.projectId)} · {state.users.find(u => u.id === r.requesterId)?.name ?? t('Colleague', 'Kollege')}</small>{r.reason && <p>{r.reason}</p>}{r.decisionNote && <p className="workflow-note">{r.decisionNote}</p>}
    {r.kind === 'stock' && <p className="workflow-count">{stockRequestIssued(r)} / {r.quantity} {r.unit} {t('handed out', 'ausgegeben')}{r.status === 'pending' && ` · ${roundQuantity(r.quantity - stockRequestIssued(r))} ${r.unit} ${t('still requested', 'noch angefragt')}`}</p>}
    <small>{r.kind === 'stock' ? r.usage === 'borrow' ? t('Borrow and return', 'Ausleihen und zurückgeben') : t('Use up', 'Verbrauchen') : <>{t('Purchase', 'Kauf')} · {r.estimatedUnitCost !== undefined ? money(r.quantity * r.estimatedUnitCost + (r.estimatedShipping ?? 0)) : t('Price not entered', 'Preis fehlt')}{r.estimatedShipping !== undefined ? ` (${t('incl. shipping', 'inkl. Versand')})` : ` · ${t('shipping not estimated', 'Versand nicht geschätzt')}`}</>}</small>
    {r.supplier && <small>{r.supplier}</small>}{r.supplierUrl && <a href={r.supplierUrl} target="_blank" rel="noreferrer">{t('Supplier link', 'Lieferantenlink')}</a>}
    {r.reviewedBy && <small>{t('Reviewed by', 'Geprüft von')}: {state.users.find(u => u.id === r.reviewedBy)?.name ?? t('Colleague', 'Kollege')}</small>}
    <RequestProgress request={r} />
    {r.orderId && <small>{t('Supplier order', 'Bestellung')}: {(state.workflows ?? emptyWorkflows).orders.find(order => order.id === r.orderId)?.reference ?? '—'}</small>}
  </div>
}
function BatchReviewForm({ requests }: { requests: InventoryWorkRequest[] }) {
  const { t, edit, mutate, projectName } = useWorkflow()
  const [decisions, setDecisions] = useState<Record<string, string>>(() => Object.fromEntries(requests.map(r => [r.id, r.status === 'deferred' ? 'defer' : 'approve'])))
  const [notes, setNotes] = useState<Record<string, string>>(() => Object.fromEntries(requests.map(r => [r.id, r.decisionNote ?? ''])))
  const approvedCount = requests.filter(r => decisions[r.id] === 'approve').length
  return <InlineForm title={`${t('Review positions', 'Positionen prüfen')} · ${projectName(requests[0].projectId)}`} onCancel={() => edit(null)} submitLabel={t('Save decisions', 'Entscheidungen speichern')} onSubmit={async form => {
    if (await mutate(`/workflows/request-batches/${requests[0].batchId}/review`, { lines: requests.map(r => ({ requestId: r.id, expectedVersion: r.version, decision: decisions[r.id], note: decisions[r.id] === 'approve' ? '' : formValue(form, `note-${r.id}`) })) })) edit(null)
  }}><p className="workflow-wide">{requestReference(requests[0])} · {t('Deferred positions stay in this request and can be approved later.', 'Zurückgestellte Positionen bleiben in dieser Anfrage und können später freigegeben werden.')}</p>
    <div className="workflow-wide">{requests.map(r => <div className="workflow-review-position" key={r.id} data-request-id={r.id}><RequestDetails request={r} /><div className="workflow-review-decision"><Field label={`${t('Decision', 'Entscheidung')} · ${r.itemName}`}><select value={decisions[r.id]} onChange={e => setDecisions({ ...decisions, [r.id]: e.target.value })}><option value="approve">{t('Approve', 'Freigeben')}</option><option value="defer">{t('Defer', 'Zurückstellen')}</option><option value="changes">{t('Request changes', 'Änderung anfragen')}</option><option value="reject">{t('Decline', 'Ablehnen')}</option></select></Field>{decisions[r.id] !== 'approve' && <Field label={`${t('Reason', 'Begründung')} · ${r.itemName}`}><textarea name={`note-${r.id}`} required maxLength={2000} value={notes[r.id]} onChange={e => setNotes({ ...notes, [r.id]: e.target.value })} /></Field>}</div></div>)}</div>
    <p className="workflow-wide" role="status">{approvedCount} {t('to approve', 'freigeben')} · {requests.filter(r => decisions[r.id] === 'defer').length} {t('to defer', 'zurückstellen')}</p>
  </InlineForm>
}
function Assignments({ assignments }: { assignments: InventoryAssignment[] }) {
  const { state, t, openRecord, openPlace, mutate, can, edit, placeName } = useWorkflow()
  if (!assignments.length) return <Empty>{t('No items assigned.', 'Keine Artikel zugewiesen.')}</Empty>
  return <Table heads={[t('Item', 'Artikel'), t('Quantity', 'Menge'), t('Place', 'Ort'), t('Person / build', 'Person / Bau'), t('Action', 'Aktion')]}>{assignments.map(a => {
    const record = state.records.find(r => r.id === a.recordId), item = state.items.find(i => i.id === record?.itemId)
    const source = (state.workflows ?? emptyWorkflows).requests.find(r => r.id === a.requestId)
    return <tr key={a.id}>
      <td><TextAction onClick={() => openRecord(a.recordId)}>{item?.name ?? '—'}</TextAction></td><td>{a.quantity} {item?.unit}</td>
      <td>{record && <TextAction onClick={() => openPlace(record.locationId)}>{placeName(record.locationId)}</TextAction>}</td>
      <td>{a.buildId ? (state.workflows ?? emptyWorkflows).builds.find(b => b.id === a.buildId)?.name : state.users.find(u => u.id === a.userId)?.name}</td>
      <td><div className="form-actions">{(a.buildId ? can('plan_builds') : can('fulfill_requests') || (can('request_stock') && a.userId === state.currentUser.id)) && <Action onClick={() => void mutate(`/workflows/assignments/${a.id}/return`, { expectedVersion: record?.version })}>{a.buildId ? t('Release reservation', 'Reservierung aufheben') : t('Return items', 'Zurückgeben')}</Action>}
      {can('plan_builds') && a.projectId && !a.buildId && !(source?.kind === 'stock' && source.usage === 'borrow') && <Action onClick={() => edit({ type: 'use', assignment: a })}>{t('Record material used', 'Materialverbrauch erfassen')}</Action>}</div></td>
    </tr>
  })}</Table>
}

export function WorkflowProducts() {
  const { state, t, can, edit, money } = useWorkflow(); const [query, setQuery] = useState(''); const w = state.workflows ?? emptyWorkflows
  const products = w.products.filter(p => inventorySearchScore(query, [p.name, p.code, p.description]))
  return <Page title={t('Products we build', 'Produkte, die wir bauen')} description={t('Reusable hardware designs and their parts lists. Purchased parts and equipment live in Stock & places.', 'Wiederverwendbare Hardwareentwürfe mit Stücklisten. Kaufteile und Geräte stehen unter Bestand & Orte.')} actions={can('manage_products') && <Primary onClick={() => edit({ type: 'product' })}>{t('New product', 'Neues Produkt')}</Primary>}>
    <Field label={t('Search products', 'Produkte suchen')}><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></Field>
    {!products.length && <Empty>{t('Create a product with its parts list, then plan how many to build.', 'Produkt mit Stückliste anlegen und anschließend die Baumenge planen.')}</Empty>}
    {products.map(product => <details className="workflow-product" key={product.id}><summary><strong>{product.name}</strong><span>{product.code} · {t('Revision', 'Revision')} {product.revision} · {product.parts.length} {t('parts', 'Teile')}{!product.active && ` · ${t('Archived', 'Archiviert')}`}</span></summary><p>{product.description}</p>
      <Table heads={[t('Part', 'Teil'), t('Per product', 'Je Produkt'), t('Estimated unit cost', 'Geschätzter Stückpreis')]}>{product.parts.map(part => <tr key={part.itemId}><td>{state.items.find(i => i.id === part.itemId)?.name}</td><td>{part.quantity}</td><td>{part.estimatedUnitCost === undefined ? t('Unknown', 'Unbekannt') : money(part.estimatedUnitCost)}</td></tr>)}</Table>
      <div className="form-actions">{can('manage_products') && <Action onClick={() => edit({ type: 'product', product })}>{t('Edit parts list', 'Stückliste bearbeiten')}</Action>}{can('plan_builds') && product.active && <Action onClick={() => edit({ type: 'build' })}>{t('Plan a build', 'Bau planen')}</Action>}</div>
    </details>)}
  </Page>
}
export function WorkflowProjects({ legacy }: { legacy: ReactNode }) {
  const { state, de, t, can, edit, money } = useWorkflow()
  const [selectedId, setSelectedId] = useState(() => { const active = state.projects.filter(p => p.active); return active.length === 1 ? active[0].id : 'all' })
  const [query, setQuery] = useState(''), [section, setSection] = useState('parts')
  const w = state.workflows ?? emptyWorkflows, selected = state.projects.find(p => p.id === selectedId)
  const inScope = (id?: string) => selectedId === 'all' || (id ?? '') === selectedId
  const builds = w.builds.filter(b => inScope(b.projectId) && inventorySearchScore(query, [b.name, b.productName, b.productRevision]))
  const projectOrders = w.orders.filter(o => o.lines.some(line => inScope(line.projectId)))
  const orders = w.orders.flatMap(o => orderLineCosts(o)).filter(c => inScope(c.line.projectId))
  const costs = materialUsageCosts(w, state.records, selectedId === 'all' ? null : selectedId)
  const startBuild = () => { setSection('builds'); edit({ type: 'build', projectId: selectedId === 'all' ? undefined : selectedId }) }
  return <Page title={t('Projects & builds', 'Projekte & Bauvorhaben')} description={t('Request parts for a project and follow its stock, orders and costs.', 'Teile für ein Projekt anfragen und Bestand, Bestellungen und Kosten verfolgen.')} actions={<>{can('request_stock') && <><Primary onClick={() => edit({ type: 'need', projectId: selectedId === 'all' ? undefined : selectedId })}>{t('I need something', 'Ich brauche etwas')}</Primary><Action onClick={() => edit({ type: 'request', initial: { projectId: selectedId === 'all' ? undefined : selectedId } })}>{t('Request parts', 'Teile anfragen')}</Action></>}{can('manage_projects') && <Action onClick={() => edit({ type: 'project' })}>{t('New project', 'Neues Projekt')}</Action>}{can('plan_builds') && <Action onClick={startBuild}>{t('Plan a build', 'Bau planen')}</Action>}</>}>
    <Field label={t('Project overview', 'Projektübersicht')}><select value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="all">{t('All projects & general supplies', 'Alle Projekte & allgemeiner Bedarf')}</option><option value="">{general(de)}</option>{state.projects.map(p => <option value={p.id} key={p.id}>{p.code} · {p.name}{!p.active && ' (' + t('Archived', 'Archiviert') + ')'}</option>)}</select></Field>
    <div className="project-scope-header"><div><h3>{selected?.name ?? (selectedId === 'all' ? t('All projects & general supplies', 'Alle Projekte & allgemeiner Bedarf') : general(de))}</h3></div>{selected && can('manage_projects') && <TextAction onClick={() => edit({ type: 'project', project: selected })}>{t('Edit project', 'Projekt bearbeiten')}</TextAction>}</div>
    <details className="project-options"><summary>{t('Project details & ClickUp', 'Projektdetails & ClickUp')}</summary>{selected?.description && <p>{selected.description}</p>}<ClickUpProject key={'clickup:' + selectedId} projectId={selected?.id} /></details>
    {selected && <CatalogHistory key={selected.id} projectId={selected.id} />}
    <WorkspaceTabs label={t('Project sections', 'Projektbereiche')} value={section} onChange={setSection} tabs={[
      { id: 'parts', label: t('Parts', 'Teile'), content: selected ? <ProjectParts key={selected.id} project={selected} /> : <Empty>{t('Choose a project to see its parts. General supplies can be requested without a project; all office stock is in Articles & stock.', 'Wähle ein Projekt für seine Teileübersicht. Allgemeiner Bedarf kann ohne Projekt angefragt werden; den gesamten Bürobestand findest du unter Artikel & Bestand.')}</Empty> },
      { id: 'requests', label: t('Requests', 'Anfragen'), content: <RequestQueue key={selectedId} scope={selectedId === 'all' ? { kind: 'all' } : { kind: 'project', id: selectedId }} /> },
      { id: 'orders', label: t('Orders', 'Bestellungen'), content: projectOrders.length ? <Table heads={[t('Order / supplier', 'Bestellung / Lieferant'), t('Part', 'Teil'), t('Received', 'Eingegangen'), t('Outstanding', 'Noch offen')]}>{projectOrders.flatMap(order => order.lines.filter(line => inScope(line.projectId)).map(line => <tr key={order.id + line.id}><td><strong>{order.reference}</strong><small>{order.supplier}</small>{order.expectedDate && <small>{t('Expected', 'Erwartet')}: {order.expectedDate}</small>}</td><td>{line.itemName}</td><td>{line.receivedQuantity} {line.unit}</td><td>{roundQuantity(line.quantity - line.receivedQuantity)} {line.unit}</td></tr>))}</Table> : <Empty>{t('No orders for this selection.', 'Keine Bestellungen für diese Auswahl.')}</Empty> },
      { id: 'costs', label: t('Costs', 'Kosten'), content: <div className="workflow-totals"><div><span>{t('Purchases incl. shipping', 'Einkäufe inkl. Versand')}</span><strong>{money(orders.reduce((sum, c) => sum + c.total, 0))}</strong><small>{t('Orders placed, including arrivals', 'Bestellte Ware einschließlich Eingängen')}</small></div><div><span>{t('Materials used', 'Verbrauchtes Material')}</span><strong>{money(costs.known)}{costs.incomplete ? ' + ?' : ''}</strong><small>{costs.incomplete ? t('Some used materials have no recorded price.', 'Für einige verbrauchte Teile fehlt der Preis.') : t('Shown separately; may be included in purchases', 'Separat ausgewiesen; kann in Einkäufen enthalten sein')}</small></div></div> },
      { id: 'builds', label: t('Builds', 'Bauvorhaben'), content: <><Field label={t('Find a build', 'Bauvorhaben suchen')}><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></Field>{builds.length ? builds.map(b => <BuildDetail key={b.id} build={b} />) : <Empty>{t('No builds for this selection.', 'Keine Bauvorhaben für diese Auswahl.')}</Empty>}</> },
      { id: 'assignments', label: t('Assignments', 'Zuweisungen'), content: <><h3>{t('Assigned stock & equipment', 'Zugewiesenes Material & Geräte')}</h3><Assignments assignments={state.assignments.filter(a => inScope(a.projectId) && !a.returnedAt && a.quantity > 0)} /><details><summary>{t('Assign stock directly / manage existing assignments', 'Bestand direkt zuweisen / bestehende Zuweisungen verwalten')}</summary>{legacy}</details></> },
    ]} />
  </Page>
}
function ProjectParts({ project }: { project: InventoryProject }) {
  const { state, de, t, can, edit, openPlace, placeName } = useWorkflow()
  const [query, setQuery] = useState('')
  const ids = projectPartIds(state, project.id), supply = inventorySupply(state, project.id)
  const newParts = (state.workflows ?? emptyWorkflows).requests.filter(request => request.projectId === project.id && request.kind === 'purchase' && !request.itemId && !['cancelled', 'fulfilled'].includes(request.status) && inventorySearchScore(query, [request.itemName, request.supplier, request.supplierUrl, requestReference(request)]))
  const formatter = new Intl.NumberFormat(de ? 'de' : 'en', { maximumFractionDigits: 6 })
  const quantity = (value: number, unit: string) => `${formatter.format(value)} ${unit}`
  const items = state.items.filter(item => ids.has(item.id) && inventorySearchScore(query, [item.name, item.sku, item.manufacturerPartNumber, item.category, ...supply.get(item.id)!.locationIds.map(placeName)]))
  const heldLabel = t('For this project', 'Für dieses Projekt')
  return <section className="project-parts" aria-label={t('Project parts', 'Projektteile')}>
    <h3>{t('Parts & availability', 'Teile & Verfügbarkeit')}</h3>
    <p className="workflow-count">{t('Stock covers the whole office. Allocated stock, requests and orders belong to this project. On order shows only quantities not yet received.', 'Der Bestand gilt büroweit. Zugewiesener Bestand, Anfragen und Bestellungen gehören zu diesem Projekt. Bestellt zeigt nur noch nicht eingegangene Mengen.')}</p>
    <Field label={t('Search project parts', 'Projektteile suchen')}><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Part, number or place…', 'Teil, Nummer oder Lagerort…')} /></Field>
    {newParts.length > 0 && <details className="project-pending-parts"><summary>{t('New parts not yet in the catalog', 'Neue Teile noch ohne Katalogeintrag')} ({newParts.length})</summary><p className="workflow-count">{t('These parts have already been requested or ordered for this project. They enter the catalog with their first recorded delivery. Follow or edit them in Requests.', 'Diese Teile sind für dieses Projekt bereits angefragt oder bestellt. Beim ersten erfassten Wareneingang erscheinen sie im Katalog. Den Ablauf findest du unter Anfragen.')}</p><ProcurementEntries requests={newParts} /></details>}
    {items.length ? <Table heads={[t('Part / place', 'Teil / Lagerort'), t('Free in office', 'Frei im Büro'), heldLabel, t('Requested', 'Angefragt'), t('On order', 'Bestellt'), t('Action', 'Aktion')]}>{items.map(item => {
      const value = supply.get(item.id)!
      return <tr key={item.id}>
        <td className="project-part-name"><strong>{item.name}</strong><small>{item.sku}{!item.active && ` · ${t('Archived', 'Archiviert')}`}</small><ProcurementHint projectId={project.id} itemId={item.id} /><div className="project-part-places">{value.locationIds.map(id => <TextAction key={id} onClick={() => openPlace(id)}>{placeName(id)}</TextAction>)}</div></td>
        <td data-label={t('Free in office', 'Frei im Büro')}><strong>{quantity(value.available, item.unit)}</strong><small>{quantity(value.physical, item.unit)} {t('physically in stock', 'physisch vorhanden')}</small>{value.unavailable > 0 && <small>{quantity(value.unavailable, item.unit)} {t('not usable', 'nicht nutzbar')}</small>}</td>
        <td data-label={heldLabel}>{quantity(value.assigned, item.unit)}</td>
        <td data-label={t('Requested', 'Angefragt')}>{quantity(value.requested, item.unit)}{value.approved > 0 && <small>{quantity(value.approved, item.unit)} {t('approved', 'freigegeben')}</small>}</td>
        <td data-label={t('On order', 'Bestellt')}>{quantity(value.ordered, item.unit)}</td>
        <td className="project-part-actions">{project.active && item.active && can('request_stock') && <div className="form-actions">{value.available > 0 && <Action onClick={() => edit({ type: 'request', initial: { kind: 'stock', projectId: project.id, itemId: item.id } })}>{t('Request from stock', 'Bestand anfragen')}</Action>}<Action onClick={() => edit({ type: 'request', initial: { kind: 'purchase', projectId: project.id, itemId: item.id } })}>{t('Request purchase', 'Kauf anfragen')}</Action></div>}</td>
      </tr>
    })}</Table> : !newParts.length && <Empty>{query ? t('No matching project parts.', 'Keine passenden Projektteile.') : t('No catalog articles linked yet. Choose catalog articles through Request parts to add them here.', 'Noch keine Katalogartikel zugeordnet. Über Teile anfragen können Katalogartikel hinzugefügt werden.')}</Empty>}
  </section>
}
function ProcurementEntries({ requests }: { requests: InventoryWorkRequest[] }) {
  const { state, t, de } = useWorkflow()
  const users = new Map(state.users.map(user => [user.id, user.name]))
  const quantity = (value: number, unit: string) => `${value.toLocaleString(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 })} ${unit}`
  return <div className="workflow-list procurement-entries">{requests.map(request => {
    const { order, received } = requestDelivery(request, state)
    return <article className="workflow-row" key={request.id} data-procurement-id={request.id}><div><strong>{quantity(request.quantity, request.unit)} · {request.itemName}</strong><small>{users.get(request.requesterId) ?? t('Colleague', 'Kollege')} · {requestReference(request)} · {new Date(request.createdAt).toLocaleDateString(de ? 'de-DE' : 'en-GB')}</small><Status request={request} />
      {request.reviewedBy && <small>{t('Reviewed by', 'Geprüft von')}: {users.get(request.reviewedBy) ?? t('Colleague', 'Kollege')}</small>}
      {request.decisionNote && <p>{request.decisionNote}</p>}
      {order && <><small>{order.reference} · {order.supplier}</small><small>{quantity(Math.max(0, roundQuantity(request.quantity - received)), request.unit)} {t('outstanding', 'noch offen')}{received > 0 && ` · ${quantity(received, request.unit)} ${t('received', 'eingegangen')}`}</small>{order.expectedDate && <small>{t('Expected delivery', 'Lieferung erwartet')}: {new Date(order.expectedDate + 'T12:00:00').toLocaleDateString(de ? 'de-DE' : 'en-GB')}</small>}</>}
      {request.supplierUrl && <a href={request.supplierUrl} target="_blank" rel="noreferrer">{t('Supplier link', 'Lieferantenlink')}</a>}
    </div></article>
  })}</div>
}
function ProcurementHint({ projectId, itemId, itemName, supplierUrl }: { projectId?: string; itemId?: string; itemName?: string; supplierUrl?: string }) {
  const { state, t } = useWorkflow()
  const requests = matchingProcurement((state.workflows ?? emptyWorkflows).requests, { projectId, itemId, itemName, supplierUrl })
  if (!requests.length) return null
  return <details className="procurement-hint"><summary>{t('Already requested or on order', 'Bereits angefragt oder bestellt')} ({requests.length})</summary><p className="workflow-count">{projectId ? t('Open purchases for this project. Check whether these cover your need before requesting additional quantities.', 'Offene Käufe für dieses Projekt. Prüfe, ob diese deinen Bedarf abdecken, bevor du weitere Mengen anfragst.') : t('Open purchases for general supplies. Check whether these cover your need before requesting additional quantities.', 'Offene Käufe für allgemeinen Bedarf. Prüfe, ob diese deinen Bedarf abdecken, bevor du weitere Mengen anfragst.')}{!itemId && ` ${t('Matched by part name or supplier link; check the exact variant.', 'Über Teilnamen oder Lieferantenlink gefunden; die genaue Variante bitte prüfen.')}`}</p><ProcurementEntries requests={requests} /></details>
}
function SupplyNote({ supply, unit, projectId }: { supply: ItemSupply; unit: string; projectId?: string }) {
  const { t, de } = useWorkflow()
  const formatter = new Intl.NumberFormat(de ? 'de' : 'en', { maximumFractionDigits: 6 })
  const q = (value: number) => `${formatter.format(value)} ${unit}`
  return <div className="purchase-supply">
    <span>{q(supply.available)} {t('freely available', 'frei verfügbar')}</span>
    {supply.assigned > 0 && <span>{q(supply.assigned)} {projectId ? t('allocated to this project', 'diesem Projekt zugewiesen') : t('allocated without a project', 'ohne Projekt zugewiesen')}</span>}
    <span>{q(supply.requested)} {t('requested', 'angefragt')} · {q(supply.ordered)} {t('on order', 'bestellt')}</span>
    {supply.unavailable > 0 && <span>{q(supply.unavailable)} {t('not usable', 'nicht nutzbar')}</span>}
  </div>
}
function BuildDetail({ build }: { build: InventoryBuild }) {
  const { state, t, can, edit, projectName, mutate } = useWorkflow(); const requirements = buildRequirements(build, state)
  const open = !build.cancelled && build.completedQuantity < build.quantity
  return <details className="workflow-build" open><summary><strong>{build.name}</strong><span>{projectName(build.projectId)} · {build.completedQuantity} / {build.quantity} {t('built', 'gebaut')}{build.cancelled ? ` · ${t('Cancelled', 'Abgebrochen')}` : ''}</span></summary>
    <p>{build.productName} · {t('Parts list revision', 'Stücklistenrevision')} {build.productRevision}</p>
    <Table heads={[t('Part / places', 'Teil / Orte'), t('Needed', 'Bedarf'), t('Reserved', 'Reserviert'), t('Free stock', 'Frei'), t('On order', 'Bestellt'), t('Requested', 'Angefragt'), t('Still missing', 'Fehlt noch'), t('Action', 'Aktion')]}>{requirements.map(part => <tr key={part.itemId}><td>{state.items.find(i => i.id === part.itemId)?.name}<small>{Array.from(new Set(state.records.filter(r => r.itemId === part.itemId && usableStock(r)).map(r => state.locations.find(l => l.id === r.locationId)?.name))).join(' · ') || '—'}</small></td><td>{part.needed}</td><td>{part.reserved}</td><td>{part.available}</td><td>{part.ordered}</td><td>{part.requested}</td><td className={part.missing > 0 ? 'workflow-warning' : ''}>{part.missing}</td><td><div className="form-actions">{open && can('plan_builds') && part.available > 0 && part.reserved < part.needed && <Action onClick={() => edit({ type: 'reserve', build, itemId: part.itemId })}>{t('Reserve', 'Reservieren')}</Action>}{open && can('request_stock') && part.toRequest > 0 && <Action onClick={() => edit({ type: 'request', initial: { kind: 'purchase', buildId: build.id, projectId: build.projectId, itemId: part.itemId, quantity: Math.max(0, part.toRequest - Math.min(part.available, part.toRequest)) || part.toRequest, reason: build.name, estimatedUnitCost: part.estimatedUnitCost } })}>{t('Request purchase', 'Kauf anfragen')}</Action>}</div></td></tr>)}</Table>
    {open && can('plan_builds') && <div className="form-actions"><Action onClick={() => edit({ type: 'complete', build })}>{t('Record completed units', 'Fertige Einheiten erfassen')}</Action><details><summary>{t('Stop this build', 'Bauvorhaben beenden')}</summary><p>{t('Unused reservations are released. Close open requests and deliveries first.', 'Ungenutzte Reservierungen werden freigegeben. Offene Anfragen und Lieferungen zuerst abschließen.')}</p><Action onClick={() => void mutate(`/workflows/builds/${build.id}/cancel`, { expectedVersion: build.version })}>{t('Cancel remaining build', 'Restlichen Bau abbrechen')}</Action></details></div>}
  </details>
}

export function WorkflowStock({ onRoomPlan, onCatalog, legacy, legacyOpen }: { onRoomPlan: () => void; onCatalog: () => void; legacy: ReactNode; legacyOpen: boolean }) {
  const { state, t, de, can, edit, openPlace, openRecord, placeName } = useWorkflow()
  const [query, setQuery] = useState(''), [placeId, setPlaceId] = useState('')
  const locationIds = placeId ? locationDescendantIds(placeId, state.locations) : undefined
  const projects = new Map(state.projects.map(project => [project.id, project]))
  const recordsByItem = new Map<string, InventoryRecord[]>(), assignmentsByRecord = new Map<string, InventoryAssignment[]>()
  for (const record of state.records) if (record.quantity > 0 && ['in_stock', 'in_use', 'reserved', 'delivered', 'maintenance', 'damaged'].includes(record.state) && (!locationIds || locationIds.has(record.locationId))) recordsByItem.set(record.itemId, [...(recordsByItem.get(record.itemId) ?? []), record])
  for (const assignment of state.assignments) if (!assignment.returnedAt && assignment.quantity > 0) assignmentsByRecord.set(assignment.recordId, [...(assignmentsByRecord.get(assignment.recordId) ?? []), assignment])
  const projectTerms = (id?: string) => { const project = projects.get(id ?? ''); return [project?.name, project?.code] }
  const items = state.items.filter(item => {
    const records = recordsByItem.get(item.id) ?? []
    return (!placeId || records.length > 0) && inventorySearchScore(query, [item.name, item.sku, item.category, item.description, item.manufacturer, item.model, item.manufacturerPartNumber, item.lcscPartNumber, item.value, item.packageForm, ...(item.projectIds ?? []).flatMap(projectTerms), ...records.flatMap(record => [record.label, record.assetTag, record.serialNumber, record.notes, placeName(record.locationId), ...(assignmentsByRecord.get(record.id) ?? []).flatMap(assignment => projectTerms(assignment.projectId))])])
  })
  const quantity = (value: number) => new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 }).format(value)
  return <Page title={t('Stock & places', 'Bestand & Orte')} description={t('Parts, equipment and general supplies. Find a place, request an item, or move stock when the office changes.', 'Bauteile, Geräte und allgemeiner Bedarf. Lagerorte finden, Artikel anfragen und Bestände einfach umräumen.')} actions={<><Primary onClick={onRoomPlan}>{t('Open room plan', 'Raumplan öffnen')}</Primary><Action onClick={onCatalog}>{t('Parts & equipment catalog', 'Katalog für Teile & Geräte')}</Action>{can('receive_stock') && <Action onClick={() => edit({ type: 'receive' })}>{t('Add arriving stock', 'Eingang erfassen')}</Action>}</>}>
    <div className="workflow-filters"><Field label={t('Search stock', 'Bestand suchen')}><input type="search" value={query} placeholder={t('Name, part number, project, place…', 'Name, Teilenummer, Projekt, Ort…')} onChange={e => setQuery(e.target.value)} /></Field><Field label={t('Place', 'Ort')}><select value={placeId} onChange={e => setPlaceId(e.target.value)}><option value="">{t('All places', 'Alle Orte')}</option>{state.locations.map(place => <option value={place.id} key={place.id}>{placeName(place.id)}</option>)}</select></Field></div>
    <div className="need-catalog-heading"><p className="workflow-count" role="status">{items.length} {t('items', 'Artikel')}{placeId && <small>{placeName(placeId)} · {t('including shelves and containers within this place', 'einschließlich zugehöriger Regale und Behälter')}</small>}</p>{(query || placeId) && <TextAction onClick={() => { setQuery(''); setPlaceId('') }}>{t('Clear search and filters', 'Suche und Filter zurücksetzen')}</TextAction>}</div>
    {!items.length && <Empty>{t('No matching stock. Try a different name, value, or part number.', 'Kein passender Bestand. Anderen Namen, Wert oder andere Teilenummer versuchen.')}</Empty>}
    {items.map(item => {
      const records = recordsByItem.get(item.id) ?? [], free = roundQuantity(records.reduce((sum, record) => sum + availableStock(record, state.assignments), 0)), held = roundQuantity(records.reduce((sum, record) => sum + (assignmentsByRecord.get(record.id) ?? []).reduce((amount, assignment) => amount + assignment.quantity, 0), 0))
      return <details className="workflow-stock-item" key={item.id}>
        <summary><div><strong>{item.name}</strong><small>{[item.sku, item.value, item.manufacturerPartNumber, item.packageForm].filter(Boolean).join(' · ')}</small></div><span><b>{quantity(free)} {item.unit}</b> {t('available', 'verfügbar')} · {quantity(held)} {item.unit} {t('reserved / borrowed', 'reserviert / ausgeliehen')}</span></summary>
        <p>{item.description}</p><div className="form-actions">{can('request_stock') && <><Action onClick={() => edit({ type: 'request', initial: { kind: 'stock', itemId: item.id, usage: 'borrow' } })}>{t('Request from stock', 'Aus Bestand anfragen')}</Action><Action onClick={() => edit({ type: 'request', initial: { kind: 'purchase', itemId: item.id } })}>{t('Request purchase', 'Kauf anfragen')}</Action></>}</div>
        {records.length ? <Table heads={[t('Place', 'Ort'), t('Physical stock', 'Physischer Bestand'), t('Available', 'Verfügbar'), t('Condition', 'Zustand'), t('Action', 'Aktion')]}>{records.map(record => <tr key={record.id}><td><Action onClick={() => openPlace(record.locationId)}>{placeName(record.locationId)}</Action><small>{record.label}</small></td><td>{quantity(record.quantity)} {item.unit}</td><td>{quantity(availableStock(record, state.assignments))} {item.unit}</td><td>{record.quarantined ? t('Held for inspection', 'Zur Prüfung gesperrt') : usableStock(record) ? t('Usable', 'Nutzbar') : t('Unavailable', 'Nicht verfügbar')}</td><td><div className="form-actions"><Action onClick={() => openRecord(record.id)}>{t('Details', 'Details')}</Action>{can('move_stock') && <Action onClick={() => edit({ type: 'move', record })}>{t('Move', 'Verschieben')}</Action>}</div></td></tr>)}</Table> : <Empty>{t('No physical stock yet.', 'Noch kein physischer Bestand.')}</Empty>}
      </details>
    })}
    <details className="workflow-advanced" open={legacyOpen || undefined}><summary>{t('Advanced stock records', 'Detaillierte Bestandsbuchungen')}</summary>{legacy}</details>
  </Page>
}
export function WorkflowOrders({ onReceivingJournal, legacy }: { onReceivingJournal: () => void; legacy: ReactNode }) {
  const { state, t, can, edit, money, projectName } = useWorkflow(); const [query, setQuery] = useState(''); const [showClosed, setShowClosed] = useState(false); const w = state.workflows ?? emptyWorkflows
  const orders = w.orders.filter(o => (showClosed || o.lines.some(l => l.quantity > l.receivedQuantity)) && inventorySearchScore(query, [o.reference, o.supplier, ...o.lines.flatMap(l => [l.itemName, projectName(l.projectId)])]))
  return <Page title={t('Orders & arrivals', 'Bestellungen & Eingänge')} description={t('The approver places the order. Receiving staff record what arrived and where it was put.', 'Die freigebende Person bestellt. Der Wareneingang erfasst die gelieferte Menge und den Lagerort.')} actions={<>{can('receive_stock') && <Primary onClick={() => edit({ type: 'receiveOrder' })}>{t('Receive delivery', 'Lieferung einbuchen')}</Primary>}{can('order_stock') && <Primary onClick={() => edit({ type: 'order' })}>{t('Record supplier order', 'Bestellung erfassen')}</Primary>}{(can('receive_stock') || can('adjust_stock')) && <Action onClick={onReceivingJournal}>{t('Receiving journal & imports', 'Eingangsjournal & Importe')}</Action>}</>}>
    <details open={can('order_stock')}><summary>{t('Approved requests waiting to be ordered', 'Freigegebene Anfragen zur Bestellung')}</summary><RequestList requests={w.requests.filter(r => r.status === 'approved')} /></details>
    <div className="workflow-filters"><Field label={t('Find an order or package', 'Bestellung oder Paket suchen')}><input type="search" value={query} placeholder={t('Supplier, order reference, item, project…', 'Lieferant, Bestellnummer, Artikel, Projekt…')} onChange={e => setQuery(e.target.value)} /></Field><label className="workflow-check"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />{t('Include fully received orders', 'Vollständig eingegangene Bestellungen zeigen')}</label></div>
    {!orders.length && <Empty>{t('No matching orders awaiting delivery.', 'Keine passenden offenen Lieferungen.')}</Empty>}
    {orders.map(order => <details className="workflow-order" open key={order.id}><summary><strong>{order.supplier} · {order.reference}</strong><span>{order.expectedDate ? `${t('Expected', 'Erwartet')} ${order.expectedDate} · ` : ''}{money(orderLineCosts(order).reduce((sum, c) => sum + c.total, 0))} {t('incl. shipping', 'inkl. Versand')}</span></summary>
      <Table heads={[t('Item / project', 'Artikel / Projekt'), t('Ordered', 'Bestellt'), t('Received', 'Eingegangen'), t('Outstanding', 'Offen'), t('Cost incl. shipping', 'Kosten inkl. Versand')]}>{orderLineCosts(order).map(({ line, total }) => <tr key={line.id}><td>{line.itemName}<small>{projectName(line.projectId)}</small></td><td>{line.quantity} {line.unit}</td><td>{line.receivedQuantity}</td><td>{roundQuantity(line.quantity - line.receivedQuantity)}</td><td>{money(total)}</td></tr>)}</Table>
      {can('receive_stock') && order.lines.some(l => l.quantity > l.receivedQuantity) && <Action onClick={() => edit({ type: 'receiveOrder', order })}>{t('Receive this delivery', 'Diese Lieferung einbuchen')}</Action>}
    </details>)}
    <details className="workflow-advanced"><summary>{t('Earlier purchase records', 'Frühere Beschaffungsbuchungen')}</summary>{legacy}</details>
  </Page>
}

function InlineForm({ title, children, onSubmit, onCancel, submitLabel, submitDisabled = false }: { title: string; children: ReactNode; onSubmit: (form: FormData) => Promise<void>; onCancel: () => void; submitLabel?: string; submitDisabled?: boolean }) {
  const { busy, t } = useWorkflow()
  const [problem, setProblem] = useState('')
  const errorMessage = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => { if (problem) { errorMessage.current?.focus({ preventScroll: true }); errorMessage.current?.scrollIntoView({ block: 'nearest' }) } }, [problem])
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setProblem(''); try { await onSubmit(new FormData(event.currentTarget)) } catch (error) { setProblem(error instanceof Error ? error.message : t('Could not save.', 'Speichern fehlgeschlagen.')) } }
  return <form className="inventory-workflow-editor" onSubmit={submit} onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'search') event.preventDefault() }} onInput={() => setProblem('')} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true }} aria-label={title}><h3>{title}</h3><fieldset disabled={busy}>{children}<div className="form-actions"><button className="primary-action" type="submit" disabled={submitDisabled}>{busy ? t('Saving…', 'Speichern…') : submitLabel ?? t('Save', 'Speichern')}</button><button className="secondary-action" type="button" onClick={onCancel}>{t('Cancel', 'Abbrechen')}</button></div></fieldset>{problem && <p ref={errorMessage} role="alert" tabIndex={-1}>{problem}</p>}</form>
}
function WorkflowEditor({ editor }: { editor: Editor }) {
  const { t, edit, mutate, state, money, placeName } = useWorkflow()
  const cancel = () => edit(null)
  async function save(path: string, body: Record<string, unknown>, method?: 'POST' | 'PATCH') { if (await mutate(path, body, method)) edit(null) }
  if (editor.type === 'requestDecision') return <RequestDecisionForm request={editor.request} action={editor.action} />
  if (editor.type === 'need') return <NeedForm projectId={editor.projectId} />
  if (editor.type === 'request') return (editor.request ?? editor.initial)?.kind === 'stock' ? <StockRequestForm initial={editor.initial} request={editor.request} /> : !editor.request ? <PurchaseRequestForm initial={editor.initial} /> : <RequestForm initial={editor.initial} request={editor.request} />
  if (editor.type === 'product') return <ProductForm product={editor.product} />
  if (editor.type === 'receive') return <ReceivingWorkspace initialMode="unordered" />
  if (editor.type === 'receiveOrder') return <ReceivingWorkspace initialOrder={editor.order} />
  if (editor.type === 'order') return <OrderForm requestIds={editor.requestIds} />
  if (editor.type === 'reviewBatch') return <BatchReviewForm requests={editor.requests} />
  if (editor.type === 'fulfill') return <FulfillForm request={editor.request} />
  if (editor.type === 'reserve') return <ReserveForm build={editor.build} itemId={editor.itemId} />
  if (editor.type === 'use') { const a = editor.assignment; const r = state.records.find(r => r.id === a.recordId); return <InlineForm title={t('Record material used', 'Materialverbrauch erfassen')} onCancel={cancel} onSubmit={form => save(`/workflows/assignments/${a.id}/use`, { expectedVersion: r?.version, quantity: Number(formValue(form, 'quantity')) })}><p>{state.items.find(i => i.id === r?.itemId)?.name} · {t('Reserved for this project', 'Für dieses Projekt reserviert')}</p><Quantity value={a.quantity} max={a.quantity} /><p>{t('This removes the used units from physical stock and records their cost for the project.', 'Die verbrauchten Einheiten werden aus dem Bestand gebucht und ihre Kosten für das Projekt erfasst.')}</p></InlineForm> }
  if (editor.type === 'project') { const p = editor.project; return <InlineForm title={p ? t('Edit project', 'Projekt bearbeiten') : t('New project', 'Neues Projekt')} onCancel={cancel} onSubmit={form => save(p ? `/projects/${p.id}` : '/projects', { name: formValue(form, 'name'), code: formValue(form, 'code'), description: formValue(form, 'description'), active: form.get('active') === 'on', expectedUpdatedAt: p?.updatedAt }, p ? 'PATCH' : 'POST')}><Field label={t('Project name', 'Projektname')}><input name="name" required defaultValue={p?.name} maxLength={200} /></Field><Field label={t('Project code', 'Projektcode')}><input name="code" required defaultValue={p?.code} maxLength={80} /></Field><Field label={t('Notes', 'Notizen')}><textarea name="description" defaultValue={p?.description} maxLength={2000} /></Field><label className="workflow-check"><input type="checkbox" name="active" defaultChecked={p?.active ?? true} />{t('Active', 'Aktiv')}</label></InlineForm> }
  if (editor.type === 'build') return <InlineForm title={t('Plan a build', 'Bau planen')} onCancel={cancel} onSubmit={form => save('/workflows/builds', { productId: formValue(form, 'productId'), projectId: formValue(form, 'projectId'), name: formValue(form, 'name'), quantity: Number(formValue(form, 'quantity')) })}><Field label={t('Product', 'Produkt')}><select name="productId" required defaultValue=""><option value="">{t('Choose a product…', 'Produkt auswählen…')}</option>{(state.workflows ?? emptyWorkflows).products.filter(p => p.active).map(p => <option value={p.id} key={p.id}>{p.name} · {p.revision}</option>)}</select></Field><ProjectSelect value={editor.projectId} /><Quantity step="1" /><Field label={t('Build name (optional)', 'Name des Bauvorhabens (optional)')}><input name="name" maxLength={200} /></Field><p>{t('This build keeps a copy of the current parts list. Later product edits will not change it.', 'Dieses Bauvorhaben behält die aktuelle Stückliste. Spätere Produktänderungen ändern sie nicht.')}</p></InlineForm>
  if (editor.type === 'move') { const r = editor.record; return <InlineForm title={t('Move stock', 'Bestand verschieben')} onCancel={cancel} onSubmit={form => save('/workflows/move', { recordId: r.id, expectedVersion: r.version, locationId: formValue(form, 'locationId'), quantity: Number(formValue(form, 'quantity')) })}><p>{state.items.find(i => i.id === r.itemId)?.name} · {t('From', 'Von')} {placeName(r.locationId)}</p><Quantity value={r.quantity} max={r.quantity} /><PlaceSelect /><p>{t('Move all units together to keep reservations attached. Partial moves use unreserved stock.', 'Beim Verschieben aller Einheiten bleiben Reservierungen erhalten. Teilmengen müssen frei sein.')}</p></InlineForm> }
  if (editor.type === 'complete') { const b = editor.build; const requirements = buildRequirements(b, state); const possible = Math.max(0, Math.min(b.quantity - b.completedQuantity, ...requirements.map(p => Math.floor(p.reserved / p.quantity)))); return <InlineForm title={t('Record completed units', 'Fertige Einheiten erfassen')} onCancel={cancel} onSubmit={form => save(`/workflows/builds/${b.id}/complete`, { expectedVersion: b.version, quantity: Number(formValue(form, 'quantity')), locationId: formValue(form, 'locationId'), recordVersions: Object.fromEntries(state.records.map(r => [r.id, r.version])) })}><p>{b.name} · {possible} {t('can be built from reserved parts', 'aus reservierten Teilen baubar')}</p><Quantity value={possible || 1} max={possible} step="1" /><PlaceSelect /><p>{t('Saving consumes the reserved parts and adds the finished products at this place.', 'Speichern verbraucht die reservierten Teile und bucht die fertigen Produkte an diesem Ort ein.')}</p><p>{requirements.every(p => p.estimatedUnitCost !== undefined) ? `${t('Estimated parts cost per unit', 'Geschätzte Materialkosten je Einheit')}: ${money(requirements.reduce((sum, p) => sum + p.quantity * p.estimatedUnitCost!, 0))}` : t('Some part estimates are unknown. Actual stock costs are recorded when the build is completed.', 'Einige Schätzpreise fehlen. Die tatsächlichen Bestandskosten werden bei Fertigstellung erfasst.')}</p></InlineForm> }
  return null
}
type NeedDraft = { quantity: string; unit: string; source: 'purchase' | 'stock'; usage: 'borrow' | 'consume'; link?: string }
const emptyNeedDraft: NeedDraft = { quantity: '1', unit: 'pcs', source: 'purchase', usage: 'borrow' }
function NeedForm({ projectId: initialProject }: { projectId?: string }) {
  const { state, t, edit, mutate, placeName } = useWorkflow()
  const [query, setQuery] = useState(''), [itemId, setItemId] = useState(''), [creating, setCreating] = useState(false)
  const [catalogScope, setCatalogScope] = useState<'project' | 'all'>('project')
  const searchInput = useRef<HTMLInputElement>(null)
  const quantityInput = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (itemId) quantityInput.current?.focus() }, [itemId])
  const [projectId, setProjectId] = useState(initialProject ?? '')
  const [newName, setNewName] = useState(''), [newQuery, setNewQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, NeedDraft>>({})
  const draftKey = itemId || 'new', draft = drafts[draftKey] ?? emptyNeedDraft
  const { quantity, unit, link, source, usage } = draft
  function changeDraft(change: Partial<NeedDraft>) { setDrafts(previous => ({ ...previous, [draftKey]: { ...draft, ...change } })) }
  const item = state.items.find(i => i.id === itemId), isLink = /^https?:\/\//i.test(query.trim())
  const supply = inventorySupply(state, projectId), available = item ? supply.get(item.id) : undefined
  const suggested = projectPartIds(state, projectId), choosing = !item && !creating && !isLink
  const projectOnly = Boolean(projectId) && catalogScope === 'project' && !query.trim()
  const matches = choosing ? state.items.filter(i => i.active && (!projectOnly || suggested.has(i.id))).map(i => ({ item: i, exact: Boolean(query.trim()) && [i.name, i.sku, i.manufacturerPartNumber].some(value => value?.toLocaleLowerCase() === query.trim().toLocaleLowerCase()), score: inventorySearchScore(query, [i.name, i.sku, i.manufacturerPartNumber, i.value, i.category, i.packageForm]) })).filter(match => match.score > 0).sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score) : []
  const name = item?.name ?? (isLink ? newName.trim() : query.trim()), supplierUrl = isLink ? query.trim() : link ?? item?.supplierUrl ?? ''
  const existingName = !item ? state.items.find(i => i.active && i.name.toLocaleLowerCase() === name.toLocaleLowerCase()) : undefined
  const places = new Map<string, number>()
  if (item) for (const record of state.records) if (record.itemId === item.id) { const free = availableStock(record, state.assignments); if (free > 0) places.set(record.locationId, roundQuantity((places.get(record.locationId) ?? 0) + free)) }
  function chooseArticle(id: string) {
    setDrafts(previous => previous[id] ? previous : { ...previous, [id]: { ...emptyNeedDraft, source: (supply.get(id)?.available ?? 0) > 0 ? 'stock' : 'purchase' } })
    setItemId(id); setCreating(false); setQuery(state.items.find(i => i.id === id)!.name)
  }
  function chooseAnother() { if (creating || isLink) setNewQuery(query); setItemId(''); setCreating(false); setQuery(''); searchInput.current?.focus() }
  return <InlineForm title={t('I need something', 'Ich brauche etwas')} onCancel={() => edit(null)} submitDisabled={choosing || !name} submitLabel={source === 'stock' && item ? t('Request from stock', 'Bestand anfragen') : t('Send for approval', 'Zur Freigabe senden')} onSubmit={async form => {
    if (!item && !creating && !isLink) throw new Error(t('Choose a matching article or select “Request as a new part”.', 'Wähle einen passenden Artikel oder „Als neues Teil anfragen“.'))
    if (!name) throw new Error(t('Enter a name for the new part.', 'Gib einen Namen für das neue Teil ein.'))
    if (existingName) throw new Error(t('This article already exists. Select it to keep its stock and requests together.', 'Diesen Artikel gibt es bereits. Wähle ihn aus, damit Bestand und Anfragen zusammenbleiben.'))
    const stock = source === 'stock' && item
    const body = stock ? { kind: 'stock', itemId: item.id, projectId, quantity: Number(quantity), usage: formValue(form, 'usage'), reason: formValue(form, 'reason') } : { projectId, reason: formValue(form, 'reason'), lines: [{ itemId: item?.id, itemName: name, unit: item?.unit ?? unit, quantity: Number(quantity), supplierUrl, estimatedUnitCost: item?.estimatedUnitCost }] }
    if (await mutate(stock ? '/workflows/requests' : '/workflows/requests/batch', body)) edit(null)
  }}>
    <div className="workflow-wide workflow-need">
      <ProjectSelect value={projectId} onChange={id => { setProjectId(id); setCatalogScope('project') }} />
      <Field label={t('Part name or supplier link', 'Teilname oder Lieferantenlink')}><input ref={searchInput} data-dialog-focus type="text" required maxLength={2000} placeholder={choosing ? t('Filter parts or paste a link…', 'Teile eingrenzen oder Link einfügen…') : t('e.g. IMU or https://…', 'z. B. IMU oder https://…')} value={query} onKeyDown={e => { if (e.key === 'Enter' && choosing) e.preventDefault() }} onChange={e => { setQuery(e.target.value); setItemId(''); if (creating || /^https?:\/\//i.test(e.target.value.trim())) setNewQuery(e.target.value) }} /></Field>
      {choosing ? <>
        {!existingName && <div><Action onClick={() => { setCreating(true); setQuery(query || newQuery); searchInput.current?.focus() }}>{query.trim() ? <>{t('Request as a new part:', 'Als neues Teil anfragen:')} {query.trim()}</> : t('Request a new part', 'Neues Teil anfragen')}</Action></div>}
        <section className="need-catalog" aria-label={t('Choose an article', 'Artikel auswählen')}>
          <div className="need-catalog-heading"><strong>{query.trim() ? t('Matches across all articles', 'Treffer in allen Artikeln') : projectOnly ? t('Choose a project part', 'Projektteil auswählen') : t('Choose an article', 'Artikel auswählen')} ({matches.length})</strong>{projectId && !query.trim() && <TextAction onClick={() => setCatalogScope(projectOnly ? 'all' : 'project')}>{projectOnly ? t('Show all articles', 'Alle Artikel anzeigen') : t('Show project parts', 'Projektteile anzeigen')}</TextAction>}</div>
          {/* A new result set gets its own scroll container; the form and focused filter stay mounted. */}
          {matches.length ? <div key={JSON.stringify([projectId, catalogScope, query.trim()])} className="need-matches" role="group" aria-label={t('Matching articles', 'Passende Artikel')}>
            {matches.map(({ item: match }) => { const stock = supply.get(match.id)!; return <button type="button" key={match.id} onClick={() => chooseArticle(match.id)}><strong>{match.name}</strong><small>{match.sku && `${match.sku} · `}{stock.available} {match.unit} {t('freely available', 'frei verfügbar')}</small>{(stock.requested > 0 || stock.ordered > 0) && <small>{stock.requested} {match.unit} {t('requested to purchase', 'zum Kauf angefragt')} · {stock.ordered} {match.unit} {t('on order', 'bestellt')}</small>}</button> })}
          </div> : <p className="workflow-count">{query.trim() ? t('No matching article. Adjust the search or request a new part above.', 'Kein passender Artikel. Suche anpassen oder oben ein neues Teil anfragen.') : projectOnly ? t('No parts are linked to this project yet. Use “Show all articles” to choose from the catalog.', 'Diesem Projekt sind noch keine Teile zugeordnet. Über „Alle Artikel anzeigen“ kannst du aus dem Katalog wählen.') : t('The catalog is empty. Request a new part above.', 'Der Katalog ist leer. Frage oben ein neues Teil an.')}</p>}
        </section>
      </> : <div><TextAction onClick={chooseAnother}>{item ? t('Choose another article', 'Anderen Artikel auswählen') : t('Choose an existing article', 'Vorhandenen Artikel auswählen')}</TextAction></div>}
      {isLink && <Field label={t('New part name', 'Name des neuen Teils')}><input required maxLength={160} value={newName} onChange={e => setNewName(e.target.value)} /></Field>}
      {(creating || isLink) && existingName && <Action onClick={() => { setDrafts(previous => ({ ...previous, [existingName.id]: { ...draft, link: supplierUrl || existingName.supplierUrl, source: 'purchase' } })); setItemId(existingName.id); setCreating(false); setNewQuery(query); setQuery(existingName.name) }}>{t('Use existing article:', 'Vorhandenen Artikel verwenden:')} {existingName.name}</Action>}
      {(creating || isLink) && <p className="workflow-count">{t('New part: this goes to approval. You do not need to create a catalog article first.', 'Neues Teil: Diese Anfrage geht zur Freigabe. Du musst vorher keinen Katalogartikel anlegen.')}</p>}
      {!choosing && <ProcurementHint projectId={projectId} itemId={item?.id} itemName={name} supplierUrl={supplierUrl} />}
      {!choosing && <div className="need-quantity"><Field label={t('Quantity', 'Menge')}><input ref={quantityInput} type="number" required min="0.000001" step="any" inputMode="decimal" value={quantity} onChange={e => changeDraft({ quantity: e.target.value })} /></Field>{item ? <span>{item.unit}</span> : <Field label={t('Unit', 'Einheit')}><UnitSelect value={unit} onChange={e => changeDraft({ unit: e.target.value })} /></Field>}</div>}
      {item && available && <>
        <div className="workflow-availability"><strong>{available.available} {item.unit} {t('freely available', 'frei verfügbar')}</strong>{[...places].map(([id, count]) => <small key={id}>{placeName(id)} · {count} {item.unit}</small>)}<small>{projectId ? t('For this project', 'Für dieses Projekt') : t('For general supplies', 'Für allgemeinen Bedarf')}: {available.requested} {item.unit} {t('requested', 'angefragt')} · {available.ordered} {item.unit} {t('on order', 'bestellt')}</small>{available.assigned > 0 && <small>{available.assigned} {item.unit} {t('already allocated', 'bereits zugewiesen')}</small>}{available.unavailable > 0 && <small>{available.unavailable} {item.unit} {t('not usable', 'nicht nutzbar')}</small>}</div>
        <fieldset className="need-source"><legend>{t('How do you want to get it?', 'Wie möchtest du das Teil erhalten?')}</legend><label className="workflow-check"><input type="radio" name="source" checked={source === 'stock'} onChange={() => changeDraft({ source: 'stock' })} />{t('Request from stock', 'Aus Bestand anfragen')}</label><label className="workflow-check"><input type="radio" name="source" checked={source === 'purchase'} onChange={() => changeDraft({ source: 'purchase' })} />{t('Request a purchase', 'Kauf anfragen')}</label></fieldset>
        {source === 'stock' && <><Field label={t('Use', 'Verwendung')}><select name="usage" value={usage} onChange={e => changeDraft({ usage: e.target.value as NeedDraft['usage'] })}><option value="borrow">{t('Borrow and return', 'Ausleihen und zurückgeben')}</option><option value="consume">{t('Use up / install in a build', 'Verbrauchen / verbauen')}</option></select></Field><p>{Number(quantity) > available.available ? t('The full quantity is not free yet. You can request it; the handout team can issue partial quantities. This does not place a purchase request.', 'Die volle Menge ist noch nicht frei. Du kannst sie anfragen; das Ausgabeteam kann Teilmengen ausgeben. Dadurch wird kein Kauf angefragt.') : t('The handout team confirms the quantity and storage place.', 'Das Ausgabeteam bestätigt Menge und Lagerort.')}</p></>}
      </>}
      {source === 'purchase' && !isLink && (item || creating) && <Field label={t('Supplier link (optional)', 'Lieferantenlink (optional)')}><input type="url" maxLength={2000} value={link ?? item?.supplierUrl ?? ''} onChange={e => changeDraft({ link: e.target.value })} placeholder="https://…" /></Field>}
      <details hidden={choosing}><summary>{t('Add a note (optional)', 'Notiz ergänzen (optional)')}</summary><Field label={t('Note (optional)', 'Notiz (optional)')}><textarea name="reason" maxLength={2000} /></Field></details>
    </div>
  </InlineForm>
}

function PurchaseRequestForm({ initial }: { initial?: Partial<InventoryWorkRequest> }) {
  const { state, t, de, edit, mutate, projectName } = useWorkflow()
  const [projectId, setProjectId] = useState(initial?.projectId ?? '')
  const [query, setQuery] = useState('')
  const [focusedItemId, setFocusedItemId] = useState(initial?.itemId)
  const [pastedList, setPastedList] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>(initial?.itemId ? { [initial.itemId]: String(initial.quantity ?? 1) } : {})
  const [custom, setCustom] = useState<PurchasePart[]>([])
  const [newName, setNewName] = useState('')
  const [newQuantity, setNewQuantity] = useState('1')
  const [newUnit, setNewUnit] = useState('pcs')
  const [newLink, setNewLink] = useState('')
  const [entryProblem, setEntryProblem] = useState('')
  const [reason, setReason] = useState(initial?.reason ?? ''), [supplier, setSupplier] = useState(initial?.supplier ?? '')
  const [links, setLinks] = useState<Record<string, string>>({})
  const [prices, setPrices] = useState<Record<string, string>>({})
  const build = (state.workflows ?? emptyWorkflows).builds.find(b => b.id === initial?.buildId)
  const catalog = state.items.filter(i => i.active && (!build || build.parts.some(p => p.itemId === i.id)))
  const suggested = projectPartIds(state, projectId)
  const supply = inventorySupply(state, projectId)
  const parts: PurchasePart[] = [...catalog.map(i => ({ ...i, itemId: i.id })), ...custom]
  const selected = parts.filter(p => Number(quantities[p.id]) > 0)
  const visible = new Set(catalog.filter(i => focusedItemId ? i.id === focusedItemId : query.trim() ? inventorySearchScore(query, [i.name, i.sku, i.manufacturerPartNumber, i.category, i.value, i.packageForm]) : !suggested.size || suggested.has(i.id)).map(i => i.id))
  // Keep entered quantities visible even when a subsequent search has different results.
  for (const part of parts) if (quantities[part.id] || !part.itemId) visible.add(part.id)
  const rows = parts.filter(p => visible.has(p.id)).sort((a, b) => Number(Number(quantities[b.id]) > 0) - Number(Number(quantities[a.id]) > 0))
  function addImported(imported: PurchaseListRow[]) {
    const added = [...custom], nextQuantities = { ...quantities }, nextLinks = { ...links }, nextPrices = { ...prices }
    for (const row of imported) {
      const id = row.partId ?? crypto.randomUUID()
      if (!row.partId) added.push({ id, name: row.name, unit: row.unit })
      nextQuantities[id] = String(row.quantity)
      if (row.supplierUrl !== undefined) nextLinks[id] = row.supplierUrl
      if (row.estimatedUnitCost !== undefined) nextPrices[id] = String(row.estimatedUnitCost)
    }
    setCustom(added); setQuantities(nextQuantities); setLinks(nextLinks); setPrices(nextPrices); setFocusedItemId(undefined); setQuery('')
  }
  function removeCustom(id: string) {
    // Remove the draft values as well, so deleted rows no longer occupy a
    // position when the next pasted list checks the request's 100-part limit.
    const withoutPart = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([key]) => key !== id))
    setCustom(current => current.filter(part => part.id !== id))
    setQuantities(withoutPart); setLinks(withoutPart); setPrices(withoutPart)
  }
  function addCustom(input = query, draft?: { quantity: string; unit: string; link: string }) {
    const name = input.trim()
    setEntryProblem('')
    if (!name) { setEntryProblem(t('Enter the new part name.', 'Bitte den Namen des neuen Teils eingeben.')); return }
    if (draft && (!Number.isFinite(Number(draft.quantity)) || Number(draft.quantity) < 0.000001)) { setEntryProblem(t('Enter a quantity greater than zero.', 'Bitte eine Menge größer als null eingeben.')); return }
    try { catalogLink(draft?.link) } catch { setEntryProblem(t('Enter a valid http(s) supplier link.', 'Bitte einen gültigen http(s)-Lieferantenlink eingeben.')); return }
    const existing = parts.find(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (existing && Number(quantities[existing.id]) > 0) { setEntryProblem(t('This part is already selected. Adjust its quantity in the list.', 'Dieses Teil ist bereits ausgewählt. Passe seine Menge in der Liste an.')); return }
    const id = existing?.id ?? crypto.randomUUID()
    if (!existing) setCustom([...custom, { id, name, unit: draft?.unit ?? 'pcs' }])
    setQuantities({ ...quantities, [id]: draft?.quantity ?? quantities[id] ?? '1' })
    if (draft?.link) setLinks({ ...links, [id]: draft.link })
    setQuery('')
    if (draft) { setNewName(''); setNewQuantity('1'); setNewUnit('pcs'); setNewLink('') }
  }
  return <div className="purchase-request-composer"><InlineForm title={t('Request parts', 'Teile anfragen')} onCancel={() => edit(null)} submitDisabled={Boolean(pastedList.trim()) || selected.length + Number(Boolean(newName.trim())) > 100} submitLabel={t('Send for approval', 'Zur Freigabe senden')} onSubmit={async form => {
    if (pastedList.trim()) throw new Error(t('Check and add the pasted list before sending, or clear it.', 'Die eingefügte Liste zuerst prüfen und übernehmen oder leeren.'))
    const lines = selected.map(p => ({ itemId: p.itemId, itemName: p.name, unit: p.unit, quantity: Number(quantities[p.id]), estimatedUnitCost: euroPrice(formValue(form, `cost-${p.id}`)), supplierUrl: formValue(form, `url-${p.id}`) }))
    if (!build && (newName.trim() || newLink.trim() || newQuantity !== '1' || newUnit !== 'pcs')) {
      if (!newName.trim()) throw new Error(t('Enter the new part name.', 'Bitte den Namen des neuen Teils eingeben.'))
      const existing = parts.find(p => p.name.toLocaleLowerCase() === newName.trim().toLocaleLowerCase())
      if (existing && selected.some(p => p.id === existing.id)) throw new Error(t('This part is already selected. Adjust its quantity in the list.', 'Dieses Teil ist bereits ausgewählt. Passe seine Menge in der Liste an.'))
      lines.push({ itemId: existing?.itemId, itemName: existing?.name ?? newName.trim(), unit: existing?.unit ?? newUnit, quantity: Number(newQuantity), supplierUrl: newLink, estimatedUnitCost: undefined })
    }
    if (!lines.length) throw new Error(t('Enter a new part or a quantity for an existing part.', 'Ein neues Teil oder eine Menge bei einem vorhandenen Teil eingeben.'))
    if (await mutate('/workflows/requests/batch', { projectId, buildId: initial?.buildId, reason: formValue(form, 'reason'), supplier: formValue(form, 'supplier'), lines })) edit(null)
  }}>
    <div className="workflow-wide purchase-request-content" onInput={() => setEntryProblem('')}>
      {initial?.projectId !== undefined || build ? <p className="purchase-project">{t('For', 'Für')} <strong>{projectName(projectId)}</strong>{build && <small>{build.name}</small>}</p> : <Field label={t('For', 'Für')}><select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">{general(de)}</option>{state.projects.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>}
      {!build && <details className="purchase-entry purchase-new-part"><summary>{t('Request a new part', 'Neues Teil anfragen')}</summary><div>
        <Field label={t('New part name', 'Name des neuen Teils')}><input value={newName} maxLength={160} onChange={e => setNewName(e.target.value)} /></Field>
        <div className="purchase-new-part-quantity"><Field label={t('Quantity for new part', 'Menge des neuen Teils')}><input type="number" min="0.000001" step="any" inputMode="decimal" required={Boolean(newName.trim())} value={newQuantity} onChange={e => setNewQuantity(e.target.value)} /></Field><Field label={t('Unit for new part', 'Einheit des neuen Teils')}><UnitSelect value={newUnit} onChange={e => setNewUnit(e.target.value)} /></Field></div>
        <Field label={t('Supplier link for new part (optional)', 'Lieferantenlink für neues Teil (optional)')}><input type="url" maxLength={2000} placeholder="https://…" value={newLink} onChange={e => setNewLink(e.target.value)} /></Field>
        <ProcurementHint projectId={projectId} itemName={newName} supplierUrl={newLink} />
        <p>{t('You can send this part directly for approval, or add it to request more parts together.', 'Du kannst dieses Teil direkt zur Freigabe senden oder es hinzufügen, um weitere Teile gemeinsam anzufragen.')}</p>
        <Action onClick={() => addCustom(newName, { quantity: newQuantity, unit: newUnit, link: newLink })}>{t('Add to request', 'Zur Anfrage hinzufügen')}</Action>
      </div></details>}
      {!build && <PurchaseListImport parts={[...state.items.map(item => ({ ...item, itemId: item.id })), ...custom]} quantities={quantities} pendingName={newName} text={pastedList} onTextChange={setPastedList} onAdd={addImported} de={de} />}
      {entryProblem && <p role="alert">{entryProblem}</p>}
      <p>{t('Enter quantities for the parts you need. Leave the others blank.', 'Mengen bei den benötigten Teilen eintragen. Die anderen Felder bleiben leer.')}</p>
      <p className="workflow-count">{projectId ? t('Requests and outstanding orders shown below are for this project.', 'Die angezeigten Anfragen und noch ausstehenden Bestellungen gelten für dieses Projekt.') : t('Requests and outstanding orders shown below are for general supplies, without a project.', 'Die angezeigten Anfragen und noch ausstehenden Bestellungen gelten für allgemeinen Bedarf ohne Projekt.')}</p>
      <Field label={t('Search parts', 'Teile suchen')}><input type="search" value={query} maxLength={200} placeholder={t('Name or part number…', 'Name oder Teilenummer…')} onChange={e => { setQuery(e.target.value); setFocusedItemId(undefined) }} /></Field>
      {query.trim() && !build && !parts.some(p => p.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase()) && <Action onClick={() => addCustom()}>{t('Request as a new item:', 'Als neuen Artikel anfragen:')} {query.trim()}</Action>}
      <div className="purchase-parts" role="group" aria-label={t('Parts and quantities', 'Teile und Mengen')}>
        {rows.map(part => <div className="purchase-part" key={part.id}>
          <div><strong>{part.name}</strong><small>{part.itemId ? part.sku : t('New item', 'Neuer Artikel')}</small>{part.itemId && <SupplyNote supply={supply.get(part.itemId)!} unit={part.unit} projectId={projectId} />}</div>
          <label><span className="purchase-quantity-label">{t('Quantity', 'Menge')}</span><input type="number" min="0" step="any" inputMode="decimal" aria-label={`${t('Quantity', 'Menge')} · ${part.name}`} placeholder="—" value={quantities[part.id] ?? ''} onChange={e => setQuantities({ ...quantities, [part.id]: e.target.value })} /></label>
          {part.itemId ? <span className="purchase-unit">{part.unit}</span> : <Field label={t('Unit', 'Einheit')}><UnitSelect value={part.unit} onChange={e => setCustom(custom.map(p => p.id === part.id ? { ...p, unit: e.target.value } : p))} /></Field>}
          {!part.itemId && <button type="button" className="secondary-action purchase-remove" onClick={() => removeCustom(part.id)}>{t('Remove', 'Entfernen')}</button>}
          {Number(quantities[part.id]) > 0 && <div className="purchase-part-link"><ProcurementHint projectId={projectId} itemId={part.itemId} itemName={part.name} supplierUrl={links[part.id] ?? part.supplierUrl} /><Field label={`${t('Supplier link', 'Lieferantenlink')} · ${part.name}`}><input name={`url-${part.id}`} type="url" maxLength={2000} placeholder="https://…" value={links[part.id] ?? (part.id === initial?.itemId ? initial.supplierUrl : undefined) ?? part.supplierUrl ?? ''} onChange={e => setLinks({ ...links, [part.id]: e.target.value })} /></Field></div>}
        </div>)}
        {!rows.length && <Empty>{t('No matching parts.', 'Keine passenden Teile.')}</Empty>}
      </div>
      {focusedItemId && <Action onClick={() => setFocusedItemId(undefined)}>{t('Choose more parts', 'Weitere Teile auswählen')}</Action>}
      <p className="purchase-selection" role="status">{selected.length + Number(Boolean(newName.trim())) ? `${selected.length + Number(Boolean(newName.trim()))} ${t('parts selected', 'Teile ausgewählt')}` : t('No parts selected yet', 'Noch keine Teile ausgewählt')}</p>
      {pastedList.trim() && <p role="status" className="workflow-note">{t('The pasted list has not been added yet. Check and add it above, or clear it before sending.', 'Die eingefügte Liste ist noch nicht übernommen. Oben prüfen und hinzufügen oder vor dem Senden leeren.')}</p>}
      {selected.length + Number(Boolean(newName.trim())) > 100 && <p role="alert">{t('Choose at most 100 parts per request.', 'Höchstens 100 Teile pro Anfrage auswählen.')}</p>}
      <details className="purchase-extras"><summary>{t('Add a note, supplier or prices (optional)', 'Notiz, Lieferant oder Preise ergänzen (optional)')}</summary>
        <Field label={t('Note (optional)', 'Notiz (optional)')}><textarea name="reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} /></Field>
        <Field label={t('Supplier (optional)', 'Lieferant (optional)')}><input name="supplier" value={supplier} onChange={e => setSupplier(e.target.value)} maxLength={200} /></Field>
        {selected.map(part => <div className="purchase-part-details" key={part.id}><strong>{part.name}</strong><Field label={`${t('Estimated unit price (€)', 'Geschätzter Stückpreis (€)')} · ${part.name}`}><EuroInput name={`cost-${part.id}`} value={prices[part.id] ?? String((part.id === initial?.itemId ? initial.estimatedUnitCost : undefined) ?? part.estimatedUnitCost ?? '')} onChange={e => setPrices({ ...prices, [part.id]: e.target.value })} /></Field></div>)}
      </details>
      {!initial?.itemId && initial?.projectId === undefined && !selected.length && !custom.length && !newName && !newLink && newQuantity === '1' && newUnit === 'pcs' && !reason && !supplier && !pastedList.trim() && <Action onClick={() => edit({ type: 'request', initial: { kind: 'stock', projectId } })}>{t('Request existing stock instead', 'Vorhandenen Bestand anfragen')}</Action>}
    </div>
  </InlineForm></div>
}
function StockRequestForm({ initial, request }: { initial?: Partial<InventoryWorkRequest>; request?: InventoryWorkRequest }) {
  const { state, t, de, edit, mutate, projectName, placeName } = useWorkflow(); const values = request ?? initial
  const [itemId, setItemId] = useState(values?.itemId ?? ''), [projectId, setProjectId] = useState(values?.projectId ?? '')
  const [quantities, setQuantities] = useState<Record<string, string>>({ [values?.itemId ?? '']: String(values?.quantity ?? 1) })
  const quantity = quantities[itemId] ?? '1'
  const [chooseItem, setChooseItem] = useState(!values?.itemId)
  const item = state.items.find(item => item.id === itemId), supply = item ? inventorySupply(state, projectId || undefined).get(item.id) : undefined
  // Only a project-part shortcut fixes the context. Switching from the generic
  // purchase form must still allow choosing a project, including general supplies.
  const fixedProject = !request && initial?.projectId !== undefined && Boolean(initial?.itemId)
  const places = new Map<string, number>()
  for (const record of state.records) if (record.itemId === itemId) { const free = availableStock(record, state.assignments); if (free > 0) places.set(record.locationId, roundQuantity((places.get(record.locationId) ?? 0) + free)) }
  const q = (value: number) => `${value.toLocaleString(de ? 'de' : 'en', { maximumFractionDigits: 6 })} ${item?.unit ?? ''}`
  return <InlineForm title={request ? t('Edit stock request', 'Bestandsanfrage bearbeiten') : t('Request from stock', 'Bestand anfragen')} onCancel={() => edit(null)} submitLabel={t('Submit request', 'Anfrage senden')} onSubmit={async form => {
    if (await mutate(request ? `/workflows/requests/${request.id}/edit` : '/workflows/requests', { kind: 'stock', itemId, projectId, quantity: Number(quantity), usage: formValue(form, 'usage'), reason: formValue(form, 'reason'), expectedVersion: request?.version })) edit(null)
  }}>
    {fixedProject ? <p><strong>{projectName(projectId)}</strong></p> : <ProjectSelect value={projectId} onChange={setProjectId} />}
    {chooseItem ? <ItemSelect value={itemId} onChange={setItemId} /> : <div className="workflow-wide workflow-batch-header"><strong>{item?.name}</strong><Action onClick={() => setChooseItem(true)}>{t('Choose another article', 'Anderen Artikel auswählen')}</Action></div>}
    {item && supply && <div className="workflow-wide workflow-availability"><strong>{q(supply.available)} {t('freely available', 'frei verfügbar')}</strong>{[...places].map(([id, amount]) => <small key={id}>{placeName(id)} · {q(amount)}</small>)}{supply.assigned > 0 && <small>{q(supply.assigned)} {projectId ? t('already allocated to this project', 'diesem Projekt bereits zugewiesen') : t('already assigned', 'bereits zugewiesen')}</small>}{Number(quantity) > supply.available && <p>{t('The full quantity is not currently free. Partial handouts are possible.', 'Die gesamte Menge ist derzeit nicht frei verfügbar. Teilmengen können ausgegeben werden.')}</p>}</div>}
    <div><Field label={t('Quantity', 'Menge')}><input type="number" required min="0.000001" step="any" value={quantity} onChange={e => setQuantities({ ...quantities, [itemId]: e.target.value })} /></Field><small>{item?.unit}</small></div>
    <Field label={t('Use', 'Verwendung')}><select name="usage" defaultValue={values?.usage ?? 'borrow'}><option value="borrow">{t('Borrow and return', 'Ausleihen und zurückgeben')}</option><option value="consume">{t('Use up / install in a build', 'Verbrauchen / verbauen')}</option></select></Field>
    <details className="workflow-wide"><summary>{t('Add a note (optional)', 'Notiz ergänzen (optional)')}</summary><Field label={t('Note (optional)', 'Notiz (optional)')}><textarea name="reason" defaultValue={values?.reason} maxLength={2000} /></Field></details>
  </InlineForm>
}
type RequestDraft = { quantity: string; name: string; unit: string; usage: string; cost: string; shipping: string; supplier: string; link: string }
function RequestForm({ initial, request }: { initial?: Partial<InventoryWorkRequest>; request?: InventoryWorkRequest }) {
  const { t, edit, mutate, state, projectName } = useWorkflow(); const values = request ?? initial
  const [kind, setKind] = useState<'purchase' | 'stock'>(values?.kind ?? 'purchase'); const [itemId, setItemId] = useState(values?.itemId ?? '')
  const item = state.items.find(i => i.id === itemId)
  const [drafts, setDrafts] = useState<Record<string, RequestDraft>>({ [values?.itemId ?? '']: { quantity: String(values?.quantity ?? 1), name: values?.itemName ?? '', unit: values?.unit ?? 'pcs', usage: values?.usage ?? 'borrow', cost: String(values?.estimatedUnitCost ?? ''), shipping: String(values?.estimatedShipping ?? ''), supplier: values?.supplier ?? '', link: values?.supplierUrl ?? '' } })
  const draft = drafts[itemId] ?? { quantity: '1', name: item?.name ?? '', unit: item?.unit ?? 'pcs', usage: 'borrow', cost: String(item?.estimatedUnitCost ?? ''), shipping: '', supplier: '', link: item?.supplierUrl ?? '' }
  function changeDraft(change: Partial<RequestDraft>) { setDrafts(previous => ({ ...previous, [itemId]: { ...draft, ...change } })) }
  return <InlineForm title={request ? t('Edit request', 'Anfrage bearbeiten') : t('New request', 'Neue Anfrage')} onCancel={() => edit(null)} submitLabel={t('Submit request', 'Anfrage senden')} onSubmit={async form => {
    const body = { kind, itemId, itemName: formValue(form, 'itemName'), quantity: Number(formValue(form, 'quantity')), unit: formValue(form, 'unit'), reason: formValue(form, 'reason'), projectId: values?.buildId || values?.batchId ? values.projectId : formValue(form, 'projectId'), buildId: values?.buildId, usage: formValue(form, 'usage'), supplier: formValue(form, 'supplier'), supplierUrl: formValue(form, 'supplierUrl'), estimatedUnitCost: euroPrice(formValue(form, 'estimatedUnitCost'), { decimalPlaces: 6, maximum: 1e9 }), estimatedShipping: euroPrice(formValue(form, 'estimatedShipping'), { decimalPlaces: 2 }), expectedVersion: request?.version }
    if (await mutate(request ? `/workflows/requests/${request.id}/edit` : '/workflows/requests', body)) edit(null)
  }}>
    {!values?.batchId && <Field label={t('What do you need?', 'Was wird benötigt?')}><select value={kind} onChange={e => setKind(e.target.value as 'purchase' | 'stock')} disabled={Boolean(values?.buildId)}><option value="purchase">{t('Buy items', 'Artikel kaufen')}</option><option value="stock">{t('Use existing stock', 'Vorhandenen Bestand nutzen')}</option></select></Field>}
    {values?.buildId ? <p>{state.items.find(i => i.id === itemId)?.name} · {projectName(values.projectId)}</p> : <><ItemSelect required={kind === 'stock'} value={itemId} onChange={setItemId} />{!itemId && kind === 'purchase' && <><Field label={t('New item name', 'Neuer Artikelname')}><input name="itemName" required value={draft.name} onChange={e => changeDraft({ name: e.target.value })} maxLength={200} /></Field><Field label={t('Unit', 'Einheit')}><UnitSelect name="unit" value={draft.unit} onChange={e => changeDraft({ unit: e.target.value })} /></Field></>}{values?.batchId ? <p>{requestReference(values as InventoryWorkRequest)} · {projectName(values.projectId)}</p> : <ProjectSelect value={values?.projectId} />}</>}
    <div><Field label={t('Quantity', 'Menge')}><input name="quantity" type="number" required min="0.000001" step="any" value={draft.quantity} onChange={e => changeDraft({ quantity: e.target.value })} /></Field><small>{item?.unit}</small></div>
    {kind === 'stock' ? <Field label={t('Use', 'Verwendung')}><select name="usage" value={draft.usage} onChange={e => changeDraft({ usage: e.target.value })}><option value="borrow">{t('Borrow and return', 'Ausleihen und zurückgeben')}</option><option value="consume">{t('Use up / install in a build', 'Verbrauchen / verbauen')}</option></select></Field> : <><Field label={t('Estimated unit price (€)', 'Geschätzter Stückpreis (€)')}><EuroInput name="estimatedUnitCost" decimalPlaces={6} maximum={1e9} value={draft.cost} onChange={e => changeDraft({ cost: e.target.value })} /></Field><Field label={t('Estimated shipping (€)', 'Geschätzter Versand (€)')}><EuroInput name="estimatedShipping" decimalPlaces={2} value={draft.shipping} onChange={e => changeDraft({ shipping: e.target.value })} /></Field><Field label={t('Supplier (optional)', 'Lieferant (optional)')}><input name="supplier" value={draft.supplier} onChange={e => changeDraft({ supplier: e.target.value })} maxLength={200} /></Field><Field label={t('Supplier link (optional)', 'Lieferantenlink (optional)')}><input name="supplierUrl" type="url" value={draft.link} onChange={e => changeDraft({ link: e.target.value })} maxLength={2000} /></Field></>}
    <Field label={kind === 'purchase' ? t('Note (optional)', 'Notiz (optional)') : t('What is it for?', 'Wofür wird es benötigt?')}><textarea name="reason" required={kind === 'stock'} defaultValue={values?.reason} maxLength={2000} /></Field>
  </InlineForm>
}
function ProductForm({ product }: { product?: InventoryProduct }) {
  const { t, state, edit, mutate } = useWorkflow(); const [parts, setParts] = useState<ProductPart[]>(product?.parts ?? [{ itemId: '', quantity: 1 }]); const [chosen, setChosen] = useState('')
  function change(index: number, value: Partial<ProductPart>) { setParts(parts.map((part, i) => i === index ? { ...part, ...value } : part)) }
  return <InlineForm title={product ? t('Edit product', 'Produkt bearbeiten') : t('New product', 'Neues Produkt')} onCancel={() => edit(null)} onSubmit={async form => { if (await mutate(`/workflows/products${product ? `/${product.id}` : ''}`, { name: formValue(form, 'name'), code: formValue(form, 'code'), revision: formValue(form, 'revision'), description: formValue(form, 'description'), active: form.get('active') === 'on', parts, expectedVersion: product?.version })) edit(null) }}>
    <Field label={t('Product name', 'Produktname')}><input name="name" required maxLength={200} defaultValue={product?.name} /></Field><Field label={t('Product code', 'Produktcode')}><input name="code" required readOnly={Boolean(product)} maxLength={80} defaultValue={product?.code} /></Field><Field label={t('Revision', 'Revision')}><input name="revision" required maxLength={80} defaultValue={product?.revision ?? '1'} /></Field><Field label={t('Description', 'Beschreibung')}><textarea name="description" defaultValue={product?.description} maxLength={2000} /></Field>
    <div className="workflow-wide"><h4>{t('Parts needed for one finished product', 'Teile für ein fertiges Produkt')}</h4>{parts.map((part, index) => <div className="workflow-part-row" key={index}><Field label={`${t('Part', 'Teil')} ${index + 1}`}><select required value={part.itemId} onChange={e => change(index, { itemId: e.target.value })}><option value="">{t('Choose…', 'Auswählen…')}</option>{state.items.filter(i => i.active && i.id !== product?.outputItemId).map(i => <option key={i.id} value={i.id}>{i.name} {i.sku}</option>)}</select></Field><Field label={t('Quantity per product', 'Menge je Produkt')}><input type="number" min="0.000001" step="any" required value={part.quantity} onChange={e => change(index, { quantity: Number(e.target.value) })} /></Field><Field label={t('Estimated unit price (€)', 'Geschätzter Stückpreis (€)')}><input type="number" min="0" step="any" value={part.estimatedUnitCost ?? ''} onChange={e => change(index, { estimatedUnitCost: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field><Action onClick={() => setParts(parts.filter((_, i) => i !== index))}>{t('Remove part', 'Teil entfernen')}</Action></div>)}
      <details><summary>{t('Find and add another part', 'Weiteres Teil suchen und hinzufügen')}</summary><ItemSelect value={chosen} onChange={setChosen} required={false} /><Action onClick={() => { if (chosen && !parts.some(p => p.itemId === chosen)) { setParts([...parts, { itemId: chosen, quantity: 1 }]); setChosen('') } }}>{t('Add selected part', 'Ausgewähltes Teil hinzufügen')}</Action></details>
    </div><label className="workflow-check"><input type="checkbox" name="active" defaultChecked={product?.active ?? true} />{t('Active product', 'Aktives Produkt')}</label><p>{t('Existing builds keep their original parts list and revision.', 'Bestehende Bauvorhaben behalten ihre ursprüngliche Stückliste und Revision.')}</p>
  </InlineForm>
}
function OrderForm({ requestIds = [] }: { requestIds?: string[] }) {
  const { state, t, edit, mutate, projectName, money, de } = useWorkflow()
  // Approval versions and spending limits belong to the selection reviewed on
  // opening. A background refresh must not silently accept a changed approval.
  const [approved] = useState(() => (state.workflows ?? emptyWorkflows).requests.filter(r => r.status === 'approved' && r.reviewedBy === state.currentUser.id && (!requestIds.length || requestIds.includes(r.id))))
  const [selected, setSelected] = useState<string[]>(() => requestIds.filter(id => approved.some(r => r.id === id)))
  const [costs, setCosts] = useState<Record<string, string>>({}), [shipping, setShipping] = useState('0')
  const [supplier, setSupplier] = useState<string | undefined>(), [query, setQuery] = useState('')
  const chosen = approved.filter(request => selected.includes(request.id)), totals = orderDraftTotals(chosen, costs, shipping)
  const suppliers = [...new Map(chosen.filter(request => request.supplier?.trim()).map(request => [request.supplier!.trim().toLocaleLowerCase(), request.supplier!.trim()])).values()]
  const supplierName = supplier ?? (suppliers.length === 1 ? suppliers[0] : '')
  const visible = approved.filter(request => selected.includes(request.id) || inventorySearchScore(query, [request.itemName, request.supplier, projectName(request.projectId), requestReference(request), state.users.find(user => user.id === request.requesterId)?.name]))
  return <InlineForm title={t('Record supplier order', 'Bestellung erfassen')} onCancel={() => edit(null)} submitDisabled={!selected.length || totals.overLimit.length > 0 || selected.length > 100} submitLabel={t('Save placed order', 'Getätigte Bestellung speichern')} onSubmit={async form => {
    if (!selected.length) throw new Error(t('Select at least one approved request.', 'Mindestens eine freigegebene Anfrage auswählen.'))
    if (totals.missingPrices || totals.shipping === undefined) throw new Error(t('Enter the confirmed EUR prices and shipping.', 'Bestätigte EUR-Preise und Versand eingeben.'))
    if (totals.overLimit.length) throw new Error(t('A price exceeds its approval. Request a revised approval first.', 'Ein Preis überschreitet die Freigabe. Zuerst eine neue Freigabe anfordern.'))
    if (await mutate('/workflows/orders', { reference: formValue(form, 'reference'), supplier: supplierName, shipping: totals.shipping, expectedDate: formValue(form, 'expectedDate'), lines: totals.lines.map(({ request, unitCost }) => ({ requestId: request.id, expectedVersion: request.version, unitCost })) })) edit(null)
  }}>
    <p className="workflow-wide">{t('Place the order with the supplier, then enter its confirmation here. This does not send an order to the supplier.', 'Beim Lieferanten bestellen und danach hier die Bestätigung erfassen. Hiermit wird keine Bestellung an den Lieferanten gesendet.')}</p>
    <div className="workflow-wide"><Field label={t('Find approved parts', 'Freigegebene Teile suchen')}><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Part, project, supplier or person…', 'Teil, Projekt, Lieferant oder Person…')} /></Field>
      {!approved.length && <Empty>{t('You have no approved requests to order.', 'Sie haben keine freigegebenen Anfragen zur Bestellung.')}</Empty>}
      {approved.length > 0 && !visible.length && <Empty>{t('No matching approved parts. Clear the search to see all requests you approved.', 'Keine passenden freigegebenen Teile. Suche leeren, um alle von dir freigegebenen Anfragen zu sehen.')}</Empty>}
      {groupWorkRequests(visible).map(group => <section key={group[0].batchId ?? group[0].id}><h4>{requestReference(group[0])} · {projectName(group[0].projectId)}</h4>{group.map(r => <div className="workflow-order-selection" key={r.id} data-request-id={r.id}><div><label className="workflow-check"><input type="checkbox" checked={selected.includes(r.id)} onChange={e => setSelected(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} /><span>{r.quantity} {r.unit} · {r.itemName}</span></label>{r.supplier && <small>{r.supplier}</small>}{r.supplierUrl && <small><a href={r.supplierUrl} target="_blank" rel="noreferrer">{t('Open supplier link', 'Lieferantenlink öffnen')}</a></small>}</div>{selected.includes(r.id) && <div><Field label={t('Confirmed unit price (€)', 'Bestätigter Stückpreis (€)')}><EuroInput name={`cost-${r.id}`} decimalPlaces={6} maximum={1e9} required value={costs[r.id] ?? String(r.estimatedUnitCost ?? '')} onChange={e => setCosts({ ...costs, [r.id]: e.target.value })} /></Field>{r.estimatedUnitCost !== undefined && <small>{t('Approved up to', 'Freigegeben bis')}: {new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 6 }).format(r.estimatedUnitCost)} / {r.unit}</small>}{totals.overLimit.includes(r.id) && <p className="workflow-warning">{t('Above the approved price. Use “Price changed” on this request to obtain a revised approval.', 'Über dem freigegebenen Preis. Über „Preis geändert“ an dieser Anfrage eine neue Freigabe einholen.')}</p>}</div>}</div>)}</section>)}
    </div>
    <Field label={t('Supplier', 'Lieferant')}><input name="supplier" required maxLength={200} value={supplierName} onChange={e => setSupplier(e.target.value)} /></Field><Field label={t('Supplier order reference', 'Bestellnummer des Lieferanten')}><input name="reference" required maxLength={200} /></Field><Field label={t('Shipping for the entire order (€)', 'Versand für die gesamte Bestellung (€)')}><EuroInput name="shipping" decimalPlaces={2} required value={shipping} onChange={e => setShipping(e.target.value)} /></Field><Field label={t('Expected delivery (optional)', 'Erwartete Lieferung (optional)')}><input name="expectedDate" type="date" /></Field>
    <div className="workflow-wide workflow-totals" role="status"><div><span>{selected.length} {t('selected positions', 'ausgewählte Positionen')}</span><strong>{money(totals.materials)}{totals.missingPrices > 0 && ' + ?'}</strong><small>{totals.missingPrices ? `${totals.missingPrices} ${t('unit prices still missing or invalid', 'Stückpreise fehlen oder sind ungültig')}` : t('Materials', 'Material')}</small></div><div><span>{t('Shipping', 'Versand')}</span><strong>{totals.shipping === undefined ? '—' : money(totals.shipping)}</strong></div><div><span>{t('Order total', 'Bestellsumme')}</span><strong>{totals.total === undefined ? t('Incomplete', 'Unvollständig') : money(totals.total)}</strong></div></div>
    {selected.length > 100 && <p className="workflow-wide workflow-warning" role="alert">{t('Select at most 100 positions for one order.', 'Höchstens 100 Positionen für eine Bestellung auswählen.')}</p>}
  </InlineForm>
}
function ReceivingWorkspace({ initialOrder, initialMode = 'picker' }: { initialOrder?: InventoryPurchaseOrder; initialMode?: 'picker' | 'unordered' }) {
  const { state, edit, t } = useWorkflow()
  const [active, setActive] = useState(initialOrder?.id ?? initialMode)
  const [drafts, setDrafts] = useState<Record<string, OrderReceiptDraft>>(() => initialOrder ? { [initialOrder.id]: orderReceiptDraft(initialOrder) } : {})
  const [unordered, setUnordered] = useState<UnorderedReceiptDraft>({ itemId: '', locationId: '', parts: {}, deliveryNote: '', notes: '' })
  const [notice, setNotice] = useState(''), surface = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const heading = surface.current?.querySelector('h3'); heading?.setAttribute('tabindex', '-1')
    const target = surface.current?.querySelector<HTMLElement>('[data-dialog-focus]') ?? heading
    target?.focus({ preventScroll: true })
    const dialog = surface.current?.closest('dialog'); if (dialog) dialog.scrollTop = 0
  }, [active])
  function select(order: InventoryPurchaseOrder) { setDrafts(current => current[order.id] ? current : { ...current, [order.id]: orderReceiptDraft(order) }); setActive(order.id); setNotice('') }
  function saved(id: string) {
    const remaining = Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id))
    setDrafts(remaining)
    if (id === 'unordered') setUnordered({ itemId: '', locationId: '', parts: {}, deliveryNote: '', notes: '' })
    if (Object.values(remaining).some(hasOrderReceiptDraft) || (id !== 'unordered' && unordered.itemId)) {
      setActive('picker'); setNotice(t('Delivery saved. Your other entries are still available below.', 'Wareneingang gespeichert. Deine weiteren Eingaben sind unten weiterhin verfügbar.'))
    } else edit(null)
  }
  const current = drafts[active]
  return <div ref={surface}>{notice && <p role="status">{notice}</p>}{active === 'picker' ? <ReceiveOrderPicker drafts={drafts} onSelect={select} onUnordered={() => setActive('unordered')} unorderedPending={Boolean(unordered.itemId)} /> : active === 'unordered' ? <UnorderedReceiveForm draft={unordered} onChange={setUnordered} onBack={() => setActive('picker')} onSaved={() => saved('unordered')} /> : current && <OrderReceiveForm key={active} draft={current} onChange={draft => setDrafts(previous => ({ ...previous, [active]: draft }))} latest={(state.workflows ?? emptyWorkflows).orders.find(order => order.id === active)} onBack={() => setActive('picker')} onSaved={() => saved(active)} />}</div>
}
function ReceiveOrderPicker({ drafts, onSelect, onUnordered, unorderedPending }: { drafts: Record<string, OrderReceiptDraft>; onSelect: (order: InventoryPurchaseOrder) => void; onUnordered: () => void; unorderedPending: boolean }) {
  const { state, t, edit, projectName } = useWorkflow(); const [query, setQuery] = useState('')
  const orders = (state.workflows ?? emptyWorkflows).orders.filter(order => (order.lines.some(line => line.quantity > line.receivedQuantity) || (drafts[order.id] && hasOrderReceiptDraft(drafts[order.id]))) && inventorySearchScore(query, [order.reference, order.supplier, ...order.lines.flatMap(line => [line.itemName, projectName(line.projectId)])]))
  return <section className="inventory-workflow-editor" aria-label={t('Choose a delivery', 'Lieferung auswählen')}>
    <h3>{t('Choose a delivery', 'Lieferung auswählen')}</h3><Field label={t('Find an order or package', 'Bestellung oder Paket suchen')}><input data-dialog-focus type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Order reference, supplier, article or project', 'Bestellnummer, Lieferant, Artikel oder Projekt')} /></Field>
    {Object.values(drafts).some(hasOrderReceiptDraft) && <p className="workflow-wide">{t('Entries are kept when you switch deliveries in this window. Closing the window discards unsaved entries.', 'Beim Wechsel der Lieferung bleiben Eingaben in diesem Fenster erhalten. Beim Schließen werden ungespeicherte Eingaben verworfen.')}</p>}
    {!orders.length && <Empty>{t('No matching open orders. Clear the search or record a delivery without an order.', 'Keine passenden offenen Bestellungen. Suche leeren oder einen Eingang ohne Bestellung erfassen.')}</Empty>}
    <div className="workflow-list">{orders.map(order => <article className="workflow-row" key={order.id}><div><strong>{order.reference} · {order.supplier}</strong><small>{[...new Set(order.lines.map(line => projectName(line.projectId)))].join(', ')}</small><p>{order.lines.filter(line => line.quantity > line.receivedQuantity).map(line => line.itemName).join(', ')}</p><small>{order.lines.filter(line => line.quantity > line.receivedQuantity).length} {t('positions outstanding', 'Positionen offen')}{order.expectedDate && ` · ${t('Expected', 'Erwartet')} ${order.expectedDate}`}</small>{drafts[order.id] && hasOrderReceiptDraft(drafts[order.id]) && <strong>{t('Unsaved entries', 'Ungespeicherte Eingaben')}</strong>}</div><Action onClick={() => onSelect(order)}>{t('Select order', 'Bestellung auswählen')}</Action></article>)}</div>
    <div className="form-actions"><Action onClick={onUnordered}>{t('Receive without an order', 'Eingang ohne Bestellung')}{unorderedPending && ` · ${t('Unsaved entries', 'Ungespeicherte Eingaben')}`}</Action><Action onClick={() => edit(null)}>{t('Cancel', 'Abbrechen')}</Action></div>
  </section>
}
function OrderReceiveForm({ draft, onChange, latest, onBack, onSaved }: { draft: OrderReceiptDraft; onChange: (draft: OrderReceiptDraft) => void; latest?: InventoryPurchaseOrder; onBack: () => void; onSaved: () => void }) {
  const { t, edit, mutate, state, clearError } = useWorkflow(); const { order } = draft
  const lines = order.lines.filter(line => line.quantity > line.receivedQuantity || Number(draft.lines[line.id]?.quantity) > 0)
  const selected = lines.filter(line => Number(draft.lines[line.id]?.quantity) > 0)
  const stale = latest && latest.version !== order.version
  const updateLine = (id: string, value: Partial<ArrivalDraft>) => onChange({ ...draft, lines: { ...draft.lines, [id]: { ...emptyArrival(), ...draft.lines[id], ...value } } })
  return <InlineForm title={`${t('Receive delivery', 'Lieferung einbuchen')} · ${order.reference}`} onCancel={() => edit(null)} submitLabel={t('Save received stock', 'Wareneingang speichern')} submitDisabled={Boolean(stale)} onSubmit={async () => {
    if (stale) throw new Error(t('Update the outstanding quantities and review your entries first.', 'Zuerst offene Mengen aktualisieren und Eingaben prüfen.'))
    if (!selected.length) throw new Error(t('Enter the delivered quantity for at least one article.', 'Für mindestens einen Artikel die gelieferte Menge eintragen.'))
    const rows = selected.map(line => ({ lineId: line.id, quantity: Number(draft.lines[line.id].quantity), locationId: draft.lines[line.id].locationId || draft.locationId, condition: draft.lines[line.id].condition, notes: draft.lines[line.id].notes }))
    if (await mutate(`/workflows/orders/${order.id}/receive`, { expectedVersion: order.version, deliveryNote: draft.deliveryNote, notes: draft.notes, lines: rows })) onSaved()
  }}>
    <div className="workflow-wide workflow-batch-header"><div><strong>{order.supplier}</strong><small>{t('Blank or zero quantities stay open. The storage place applies to all delivered articles.', 'Leere Felder oder 0 bleiben offen. Der Lagerort gilt für alle gelieferten Artikel.')}</small></div><Action onClick={onBack}>{t('Choose another order', 'Andere Bestellung auswählen')}</Action></div>
    {stale && <div className="workflow-wide workflow-warning" role="alert"><p>{t('This order changed while you were entering the delivery. Your entries are retained. Update the outstanding quantities, then check them before saving.', 'Diese Bestellung wurde während der Erfassung geändert. Deine Eingaben bleiben erhalten. Aktualisiere die offenen Mengen und prüfe sie vor dem Speichern.')}</p><Action onClick={() => { onChange({ ...draft, order: latest }); clearError() }}>{t('Update outstanding quantities', 'Offene Mengen aktualisieren')}</Action></div>}
    <SearchSelect name="locationId" label={t('Storage place', 'Lagerort')} options={storagePlaces(state)} value={draft.locationId} onChange={locationId => onChange({ ...draft, locationId })} required={selected.some(line => !draft.lines[line.id]?.locationId)} />
    <div className="workflow-wide"><div className="form-actions"><Action onClick={() => onChange({ ...draft, lines: { ...draft.lines, ...Object.fromEntries(lines.map(line => [line.id, { ...emptyArrival(), ...draft.lines[line.id], quantity: String(roundQuantity(line.quantity - line.receivedQuantity)) }])) } })}>{t('All outstanding quantities arrived', 'Alle offenen Mengen geliefert')}</Action></div>
      {lines.map(line => <OrderArrivalLine key={line.id} line={line} draft={draft.lines[line.id] ?? emptyArrival()} onChange={value => updateLine(line.id, value)} />)}
      {!lines.length && <Empty>{t('This order has already been fully received.', 'Diese Bestellung ist bereits vollständig eingegangen.')}</Empty>}
    </div><p className="workflow-wide workflow-count" role="status">{selected.length} {selected.length === 1 ? t('position to receive', 'Position wird eingebucht') : t('positions to receive', 'Positionen werden eingebucht')}</p><DeliveryNotes draft={draft} onChange={value => onChange({ ...draft, ...value })} />
  </InlineForm>
}
function OrderArrivalLine({ line, draft, onChange }: { line: InventoryPurchaseOrder['lines'][number]; draft: ArrivalDraft; onChange: (value: Partial<ArrivalDraft>) => void }) {
  const { t, de, state, projectName } = useWorkflow(); const { quantity, condition } = draft
  const outstanding = roundQuantity(line.quantity - line.receivedQuantity), amount = Number(quantity), remaining = condition === 'wrong_item' ? outstanding : roundQuantity(Math.max(0, outstanding - (Number.isFinite(amount) ? amount : 0)))
  const format = (value: number) => value.toLocaleString(de ? 'de' : 'en', { maximumFractionDigits: 6 })
  return <div className="workflow-arrival-line" data-line-id={line.id}><div><strong>{line.itemName}</strong><small>{projectName(line.projectId)} · {format(line.quantity)} {line.unit} {t('ordered', 'bestellt')} · {format(line.receivedQuantity)} {line.unit} {t('already received', 'bereits eingegangen')}</small><p className="workflow-arrival-balance">{format(outstanding)} {line.unit} {t('outstanding', 'offen')} · {t('Remaining afterwards', 'Danach noch offen')}: {format(remaining)} {line.unit}</p></div>
    <label><span>{t('Arrived today', 'Heute eingegangen')} ({line.unit})</span><input aria-label={`${t('Arrived today', 'Heute eingegangen')} · ${line.itemName}`} type="number" min="0" max={outstanding} step="any" value={quantity} placeholder="0" onChange={e => onChange({ quantity: e.target.value })} /></label>
    {amount > outstanding && <p className="workflow-warning">{t('More than the outstanding quantity. Check this delivery before saving.', 'Mehr als die offene Menge. Diese Lieferung vor dem Speichern prüfen.')}</p>}
    <details className="workflow-arrival-extras" open={Boolean(draft.locationId || draft.notes || condition !== 'new') || undefined}><summary>{t('Different place or a problem', 'Anderer Lagerort oder Problem')}{condition !== 'new' && ` · ${t('Held for review', 'Zur Prüfung gesperrt')}`}</summary><div className="workflow-arrival-fields">
      <SearchSelect name={`location-${line.id}`} label={t('Different storage place (optional)', 'Abweichender Lagerort (optional)')} options={storagePlaces(state)} required={false} value={draft.locationId} onChange={locationId => onChange({ locationId })} emptyLabel={t('Use the delivery storage place', 'Lagerort der Lieferung verwenden')} />
      <ConditionSelect name={`condition-${line.id}`} value={condition} onChange={condition => onChange({ condition })} /><Field label={t('Note for this article (optional)', 'Notiz zu diesem Artikel (optional)')}><textarea name={`notes-${line.id}`} maxLength={2000} value={draft.notes} onChange={e => onChange({ notes: e.target.value })} /></Field><p>{t('Damaged, incorrect or unchecked articles are held for review. Incorrect articles do not reduce the outstanding quantity.', 'Beschädigte, falsche oder ungeprüfte Artikel werden zur Prüfung gesperrt. Falsche Artikel verringern die offene Menge nicht.')}</p>
    </div></details>
  </div>
}
function DeliveryNotes({ draft, onChange }: { draft: { deliveryNote: string; notes: string }; onChange: (value: Partial<{ deliveryNote: string; notes: string }>) => void }) { const { t } = useWorkflow(); return <details className="workflow-wide" open={Boolean(draft.deliveryNote || draft.notes) || undefined}><summary>{t('Delivery note or comment (optional)', 'Lieferschein oder Notiz (optional)')}</summary><div className="workflow-arrival-fields"><Field label={t('Delivery note (optional)', 'Lieferschein (optional)')}><input name="deliveryNote" maxLength={200} value={draft.deliveryNote} onChange={e => onChange({ deliveryNote: e.target.value })} /></Field><Field label={t('Notes (optional)', 'Notizen (optional)')}><textarea name="notes" maxLength={2000} value={draft.notes} onChange={e => onChange({ notes: e.target.value })} /></Field></div></details> }
function UnorderedReceiveForm({ draft, onChange, onBack, onSaved }: { draft: UnorderedReceiptDraft; onChange: (draft: UnorderedReceiptDraft) => void; onBack: () => void; onSaved: () => void }) {
  const { t, edit, mutate, state } = useWorkflow()
  const part = draft.parts[draft.itemId] ?? { ...emptyArrival(), quantity: '1', unitCost: '' }
  const item = state.items.find(item => item.id === draft.itemId)
  const changePart = (value: Partial<typeof part>) => onChange({ ...draft, parts: { ...draft.parts, [draft.itemId]: { ...part, ...value } } })
  return <InlineForm title={t('Receive without an order', 'Eingang ohne Bestellung')} onCancel={() => edit(null)} submitLabel={t('Save received stock', 'Wareneingang speichern')} submitDisabled={!item} onSubmit={async () => {
    if (await mutate('/workflows/receive', { deliveryNote: draft.deliveryNote, notes: draft.notes, lines: [{ itemId: draft.itemId, quantity: Number(part.quantity), locationId: draft.locationId, condition: part.condition, unitCost: part.unitCost.trim() ? euroPrice(part.unitCost, { decimalPlaces: 6, maximum: 1e9 }) : undefined }] })) onSaved()
  }}><div className="workflow-wide"><Action onClick={onBack}>{t('Choose an order', 'Bestellung auswählen')}</Action></div><ItemSelect value={draft.itemId} onChange={itemId => onChange({ ...draft, itemId })} /><Field label={item ? `${t('Quantity', 'Menge')} (${item.unit})` : t('Quantity', 'Menge')}><input name="quantity" aria-label={t('Quantity', 'Menge')} type="number" required min="0.000001" step="any" value={part.quantity} onChange={e => changePart({ quantity: e.target.value })} /></Field><SearchSelect name="locationId" label={t('Storage place', 'Lagerort')} options={storagePlaces(state)} value={draft.locationId} onChange={locationId => onChange({ ...draft, locationId })} /><ConditionSelect value={part.condition} onChange={condition => changePart({ condition })} /><Field label={t('Unit cost incl. shipping, if known (€)', 'Stückkosten inkl. Versand, falls bekannt (€)')}><EuroInput name="unitCost" decimalPlaces={6} maximum={1e9} value={part.unitCost} onChange={e => changePart({ unitCost: e.target.value })} /></Field><DeliveryNotes draft={draft} onChange={value => onChange({ ...draft, ...value })} /></InlineForm>
}
function ConditionSelect({ name = 'condition', value, onChange }: { name?: string; value?: string; onChange?: (value: string) => void }) { const { t } = useWorkflow(); return <Field label={t('Arrival condition', 'Zustand bei Eingang')}><select name={name} value={value} onChange={e => onChange?.(e.target.value)}><option value="new">{t('Ready to use', 'Nutzbar')}</option><option value="needs_check">{t('Needs inspection', 'Prüfung nötig')}</option><option value="wrong_item">{t('Wrong item — order stays open', 'Falscher Artikel – Bestellung bleibt offen')}</option><option value="damaged">{t('Damaged', 'Beschädigt')}</option></select></Field> }
function ReserveForm({ build, itemId }: { build: InventoryBuild; itemId: string }) {
  const { state, t, edit, mutate, placeName } = useWorkflow(); const [recordId, setRecordId] = useState(''); const records = state.records.filter(r => r.itemId === itemId && availableStock(r, state.assignments) > 0)
  const record = records.find(r => r.id === recordId); const requirement = buildRequirements(build, state).find(p => p.itemId === itemId)!
  const maximum = Math.min(record ? availableStock(record, state.assignments) : 0, requirement.needed - requirement.reserved)
  return <InlineForm title={t('Reserve parts for this build', 'Teile für diesen Bau reservieren')} onCancel={() => edit(null)} onSubmit={async form => { if (await mutate(`/workflows/builds/${build.id}/reserve`, { expectedVersion: build.version, recordId, recordVersion: record?.version, quantity: Number(formValue(form, 'quantity')) })) edit(null) }}>
    <p>{build.name} · {state.items.find(i => i.id === itemId)?.name}</p><Field label={t('Take from', 'Entnehmen aus')}><select required value={recordId} onChange={e => setRecordId(e.target.value)}><option value="">{t('Choose stock…', 'Bestand auswählen…')}</option>{records.map(r => <option key={r.id} value={r.id}>{placeName(r.locationId)} · {availableStock(r, state.assignments)} {t('available', 'verfügbar')}{r.label ? ` · ${r.label}` : ''}</option>)}</select></Field>{record && <Quantity key={recordId} value={maximum} max={maximum} />}
  </InlineForm>
}
function FulfillForm({ request }: { request: InventoryWorkRequest }) {
  const { state, t, de, edit, mutate, projectName, placeName } = useWorkflow()
  // Keep the quantities and versions the receiver reviewed, even if a live refresh arrives.
  const [sources] = useState(() => state.records.filter(r => r.itemId === request.itemId).map(record => ({ record, available: availableStock(record, state.assignments) })).filter(source => source.available > 0).sort((a, b) => (a.record.stockedAt ?? a.record.createdAt).localeCompare(b.record.stockedAt ?? b.record.createdAt) || a.record.id.localeCompare(b.record.id)))
  const places = new Map<string, number>()
  for (const source of sources) places.set(source.record.locationId, roundQuantity((places.get(source.record.locationId) ?? 0) + source.available))
  const remaining = roundQuantity(request.quantity - stockRequestIssued(request)), initialPlace = places.size === 1 ? [...places.keys()][0] : ''
  const [locationId, setLocationId] = useState(initialPlace), [quantities, setQuantities] = useState<Record<string, string>>({})
  // Each place keeps its own draft. Switching to a smaller stock must not
  // overwrite the amount the receiver entered for another place.
  const quantity = locationId ? quantities[locationId] ?? String(Math.min(remaining, places.get(locationId) ?? 0)) : ''
  const available = places.get(locationId) ?? 0, q = (value: number) => `${value.toLocaleString(de ? 'de' : 'en', { maximumFractionDigits: 6 })} ${request.unit}`
  return <InlineForm title={t('Hand out requested stock', 'Angefragten Bestand ausgeben')} onCancel={() => edit(null)} submitLabel={t('Confirm handout', 'Ausgabe bestätigen')} onSubmit={async () => {
    let needed = Number(quantity)
    if (!Number.isFinite(needed) || needed <= 0 || needed > remaining || needed > available) throw new Error(t('Choose a place and an available quantity within the remaining request.', 'Lagerort und eine verfügbare Menge innerhalb der offenen Anfrage wählen.'))
    const lines = []
    for (const source of sources.filter(source => source.record.locationId === locationId)) {
      if (needed <= 0) break
      const amount = Math.min(needed, source.available)
      lines.push({ recordId: source.record.id, expectedVersion: source.record.version, quantity: amount }); needed = roundQuantity(needed - amount)
    }
    if (await mutate(`/workflows/requests/${request.id}/fulfill`, { expectedVersion: request.version, lines })) edit(null)
  }}>
    <div className="workflow-wide workflow-availability"><strong>{request.itemName}</strong><p>{state.users.find(user => user.id === request.requesterId)?.name} · {projectName(request.projectId)}</p><small>{request.usage === 'borrow' ? t('Borrow and return', 'Ausleihen und zurückgeben') : t('Use up / install in a build', 'Verbrauchen / verbauen')}</small><small>{q(stockRequestIssued(request))} / {q(request.quantity)} {t('handed out', 'ausgegeben')} · {q(remaining)} {t('still requested', 'noch angefragt')}</small>{request.reason && <p>{request.reason}</p>}</div>
    <Field label={t('Storage place', 'Lagerort')}><select required value={locationId} onChange={e => setLocationId(e.target.value)}><option value="">{t('Choose a place…', 'Lagerort auswählen…')}</option>{[...places].map(([id, free]) => <option key={id} value={id}>{placeName(id)} · {q(free)} {t('free', 'frei')}</option>)}</select></Field>
    <Field label={t('Hand out now', 'Jetzt ausgeben')}><input type="number" min="0.000001" max={Math.min(remaining, available)} step="any" required disabled={!locationId} value={quantity} onChange={e => setQuantities(current => ({ ...current, [locationId]: e.target.value }))} /></Field>
    {sources.length ? <p role="status">{t('Remaining afterwards', 'Danach noch offen')}: {q(Math.max(0, roundQuantity(remaining - (Number(quantity) || 0))))}</p> : <Empty>{t('No free usable stock. Receive stock or release an existing reservation first.', 'Kein freier nutzbarer Bestand. Zuerst Ware einbuchen oder eine bestehende Reservierung aufheben.')}</Empty>}
  </InlineForm>
}
