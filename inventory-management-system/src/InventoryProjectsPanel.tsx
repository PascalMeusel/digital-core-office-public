import { useMemo, useState, type FormEvent } from 'react'
import { inventorySearchScore } from '../shared/search.ts'
import type { InventoryAssignment, InventoryProject, InventoryStatePayload } from '../shared/inventory.ts'

type Mutation = (path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH') => Promise<boolean>

export function InventoryProjectsPanel({ state, language, loading, onMutation, onOpenRecord, onReturn }: {
  state: InventoryStatePayload
  language: 'en' | 'de'
  loading: boolean
  onMutation: Mutation
  onOpenRecord: (id: string) => void
  onReturn: (assignment: InventoryAssignment) => Promise<void>
}) {
  const de = language === 'de'
  const projects = state.projects ?? []
  const canAdjust = state.permissions.includes('adjust_stock')
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<InventoryProject | 'new' | null>(null)
  const [assigning, setAssigning] = useState(false)
  const selected = projects.find(project => project.id === selectedId)
  const records = useMemo(() => new Map(state.records.map(record => [record.id, record])), [state.records])
  const items = useMemo(() => new Map(state.items.map(item => [item.id, item])), [state.items])
  const users = useMemo(() => new Map(state.users.map(user => [user.id, user])), [state.users])
  const locations = useMemo(() => new Map(state.locations.map(location => [location.id, location])), [state.locations])
  const assignments = state.assignments.filter(assignment => assignment.projectId === selected?.id && assignment.projectId)
  const active = assignments.filter(assignment => !assignment.returnedAt && assignment.quantity > 0)
  const returned = assignments.filter(assignment => assignment.returnedAt)
  const activeByProject = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const assignment of state.assignments) {
      if (!assignment.projectId || assignment.returnedAt || assignment.quantity <= 0) continue
      const ids = result.get(assignment.projectId) ?? new Set<string>()
      ids.add(assignment.recordId)
      result.set(assignment.projectId, ids)
    }
    return result
  }, [state.assignments])

  async function saveProject(body: Record<string, unknown>) {
    const current = editor === 'new' ? undefined : editor
    const saved = await onMutation(current ? `/projects/${current.id}` : '/projects', body, current ? 'PATCH' : 'POST')
    if (saved) { setEditor(null); setSearch('') }
    return saved
  }

  function assignmentRows(rows: InventoryAssignment[]) {
    return <div className="table-scroll"><table className="inventory-table project-stock-table responsive-record-table">
      <thead><tr><th>{de ? 'Artikel' : 'Item'}</th><th>{de ? 'Menge' : 'Quantity'}</th><th>{de ? 'Ort' : 'Location'}</th><th>{de ? 'Verantwortlich' : 'Responsible person'}</th><th>{de ? 'Datum / Notiz' : 'Date / note'}</th><th>{de ? 'Aktion' : 'Action'}</th></tr></thead>
      <tbody>{rows.map(assignment => {
        const record = records.get(assignment.recordId)
        const item = record && items.get(record.itemId)
        const location = record && locations.get(record.locationId)
        return <tr className="inventory-record-row" key={assignment.id}>
          <td><button className="secondary-action" type="button" onClick={() => onOpenRecord(assignment.recordId)}>{record?.label || item?.name || assignment.recordId}</button><small>{item?.sku}{record?.serialNumber ? ` · ${record.serialNumber}` : ''}</small></td>
          <td data-label={de ? 'Menge' : 'Quantity'}>{assignment.quantity.toLocaleString(language)} {item?.unit}</td>
          <td data-label={de ? 'Ort' : 'Location'}>{location?.name || '—'}</td>
          <td data-label={de ? 'Verantwortlich' : 'Responsible person'}>{users.get(assignment.userId)?.name || assignment.userId}</td>
          <td data-label={de ? 'Datum / Notiz' : 'Date / note'}><time>{new Date(assignment.returnedAt || assignment.assignedAt).toLocaleDateString(language)}</time><small>{assignment.notes}</small></td>
          <td>{!assignment.returnedAt && canAdjust ? <button className="secondary-action" disabled={loading} type="button" onClick={() => void onReturn(assignment)}>{de ? 'Zurückgeben' : 'Return items'}</button> : '—'}</td>
        </tr>
      })}</tbody>
    </table></div>
  }

  return <section className="inventory-panel inventory-projects">
    <div className="workspace-page-header workspace-page-header-compact">
      <div><h2>{de ? 'Projektinventar' : 'Project inventory'}</h2><p>{de ? 'Material und Geräte je Projekt zuweisen und zurückgeben.' : 'Assign and return materials and equipment for each project.'}</p></div>
      {canAdjust && <button className="primary-action" type="button" disabled={loading} onClick={() => setEditor('new')}>{de ? 'Projekt anlegen' : 'New project'}</button>}
    </div>
    {editor && <ProjectForm key={editor === 'new' ? 'new' : editor.id} project={editor === 'new' ? undefined : editor} de={de} loading={loading} onSave={saveProject} onCancel={() => setEditor(null)} />}
    <div className="inventory-filters project-filters">
      <label>{de ? 'Projekte suchen' : 'Search projects'}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setSelectedId(''); setAssigning(false) }} /></label>
      <label>{de ? 'Projektübersicht' : 'Project overview'}<select aria-label={de ? 'Projektübersicht' : 'Project overview'} value={selectedId} onChange={event => { setSelectedId(event.target.value); setAssigning(false) }}>
        <option value="">{de ? 'Alle Projekte' : 'All projects'}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.code} — {project.name}{!project.active ? (de ? ' (Archiviert)' : ' (Archived)') : ''}</option>)}
      </select></label>
    </div>
    {!selected ? <div className="project-directory">
      {projects.filter(project => inventorySearchScore(search, [project.code, project.name, project.description])).map(project => <button className="project-directory-row" type="button" key={project.id} onClick={() => setSelectedId(project.id)}>
        <span><strong>{project.name}</strong><small>{project.code}{!project.active ? (de ? ' · Archiviert' : ' · Archived') : ''}</small></span>
        <span>{activeByProject.get(project.id)?.size ?? 0} {de ? 'Bestandspositionen' : 'stock records'}</span>
      </button>)}
      {!projects.some(project => inventorySearchScore(search, [project.code, project.name, project.description])) && <p className="empty-note">{projects.length ? (de ? 'Keine passenden Projekte. Suche ändern.' : 'No matching projects. Change your search.') : (de ? 'Noch keine Projekte angelegt.' : 'No projects created yet.')}</p>}
    </div> : <>
      <div className="workspace-page-header workspace-page-header-compact">
        <div><h3>{selected.name}</h3><p>{selected.code}{!selected.active ? (de ? ' · Archiviert' : ' · Archived') : ''}</p>{selected.description && <p>{selected.description}</p>}</div>
        {canAdjust && <div className="form-actions">
          <button className="secondary-action" type="button" disabled={loading} onClick={() => setEditor(selected)}>{de ? 'Projekt bearbeiten' : 'Edit project'}</button>
          {selected.active && <button className="primary-action" type="button" disabled={loading} onClick={() => setAssigning(true)}>{de ? 'Artikel zuweisen' : 'Assign items'}</button>}
        </div>}
      </div>
      {assigning && selected.active && <ProjectAssignmentForm key={selected.id} state={state} project={selected} de={de} loading={loading} onCancel={() => setAssigning(false)} onSave={async (recordId, body) => {
        const saved = await onMutation(`/records/${recordId}/assignments`, body, 'POST')
        if (saved) setAssigning(false)
        return saved
      }} />}
      <div className="catalog-results-heading"><h3>{de ? 'Zugewiesene Artikel' : 'Assigned items'} ({active.length})</h3></div>
      {active.length ? assignmentRows(active) : <p className="empty-note">{de ? 'Diesem Projekt sind keine Artikel zugewiesen.' : 'No items assigned to this project.'}</p>}
      <details><summary>{de ? 'Rückgabehistorie' : 'Return history'} ({returned.length})</summary>{returned.length ? assignmentRows(returned) : <p className="empty-note">{de ? 'Noch keine Rückgaben.' : 'No returns yet.'}</p>}</details>
    </>}
  </section>
}

function ProjectForm({ project, de, loading, onSave, onCancel }: { project?: InventoryProject; de: boolean; loading: boolean; onSave: (body: Record<string, unknown>) => Promise<boolean>; onCancel: () => void }) {
  const [values, setValues] = useState(() => ({ name: project?.name ?? '', code: project?.code ?? '', description: project?.description ?? '', active: project?.active ?? true, expectedUpdatedAt: project?.updatedAt }))
  async function submit(event: FormEvent) { event.preventDefault(); await onSave(values) }
  return <form className="inventory-form project-editor" onSubmit={submit}>
    <label>{de ? 'Projektname' : 'Project name'}<input required maxLength={200} value={values.name} onChange={event => setValues({ ...values, name: event.target.value })} /></label>
    <label>{de ? 'Projektcode' : 'Project code'}<input required maxLength={80} value={values.code} onChange={event => setValues({ ...values, code: event.target.value })} /></label>
    <label className="form-wide">{de ? 'Beschreibung' : 'Description'}<textarea rows={3} maxLength={2000} value={values.description} onChange={event => setValues({ ...values, description: event.target.value })} /></label>
    {project && <label>Status<select aria-label="Status" value={values.active ? 'active' : 'archived'} onChange={event => setValues({ ...values, active: event.target.value === 'active' })}><option value="active">{de ? 'Aktiv' : 'Active'}</option><option value="archived">{de ? 'Archiviert (alle Artikel zuerst zurückgeben)' : 'Archived (return all items first)'}</option></select></label>}
    <div className="form-actions"><button className="primary-action" disabled={loading} type="submit">{de ? 'Projekt speichern' : 'Save project'}</button><button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>{de ? 'Abbrechen' : 'Cancel'}</button></div>
  </form>
}

function ProjectAssignmentForm({ state, project, de, loading, onSave, onCancel }: { state: InventoryStatePayload; project: InventoryProject; de: boolean; loading: boolean; onSave: (recordId: string, body: Record<string, unknown>) => Promise<boolean>; onCancel: () => void }) {
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<{ id: string; version: number } | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [userId, setUserId] = useState(state.currentUser.id)
  const [notes, setNotes] = useState('')
  const items = new Map(state.items.map(item => [item.id, item]))
  const locations = new Map(state.locations.map(location => [location.id, location]))
  const assigned = new Map<string, number>()
  for (const assignment of state.assignments) if (!assignment.returnedAt) assigned.set(assignment.recordId, (assigned.get(assignment.recordId) ?? 0) + assignment.quantity)
  const available = (id: string, total: number) => Math.max(0, total - (assigned.get(id) ?? 0))
  const record = state.records.find(candidate => candidate.id === selection?.id)
  const stale = Boolean(selection && (!record || record.version !== selection.version))
  const candidates = state.records.filter(candidate => !candidate.quarantined && ['in_stock', 'reserved', 'in_use'].includes(candidate.state) && ['new', 'usable'].includes(candidate.condition) && available(candidate.id, candidate.quantity) > 0)
  const matches = candidates.filter(candidate => {
    const item = items.get(candidate.itemId)
    return candidate.id === selection?.id || inventorySearchScore(search, [candidate.label, item?.name, item?.sku, item?.manufacturer, item?.model, item?.manufacturerPartNumber, item?.lcscPartNumber, item?.description, candidate.serialNumber, locations.get(candidate.locationId)?.name])
  })
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!record || stale) return
    await onSave(record.id, { projectId: project.id, userId, quantity, notes, expectedVersion: selection?.version })
  }
  return <form className="inventory-form project-editor" onSubmit={submit}>
    <label>{de ? 'Bestand suchen' : 'Search stock'}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <label>{de ? 'Bestandsposition' : 'Stock record'}<select aria-label={de ? 'Bestandsposition' : 'Stock record'} required value={selection?.id ?? ''} onChange={event => { const next = state.records.find(candidate => candidate.id === event.target.value); setSelection(next ? { id: next.id, version: next.version } : null) }}>
      <option value="">{de ? 'Artikel auswählen' : 'Choose an item'}</option>
      {matches.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label || items.get(candidate.itemId)?.name} · {locations.get(candidate.locationId)?.name} · {available(candidate.id, candidate.quantity)} {items.get(candidate.itemId)?.unit}</option>)}
    </select></label>
    <label>{de ? 'Menge' : 'Quantity'}<input required type="number" min="0.01" step="0.01" max={record ? available(record.id, record.quantity) : 0} value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
    <label>{de ? 'Verantwortlich' : 'Responsible person'}<select aria-label={de ? 'Verantwortlich' : 'Responsible person'} required value={userId} onChange={event => setUserId(event.target.value)}>{state.users.filter(user => user.active).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
    <label className="form-wide">{de ? 'Notiz' : 'Note'}<textarea maxLength={1000} rows={2} value={notes} onChange={event => setNotes(event.target.value)} /></label>
    {stale && <p role="alert" className="form-wide">{de ? 'Bestand geändert. Artikel erneut auswählen und Menge prüfen.' : 'Stock changed. Select the item again and review the quantity.'}</p>}
    {!candidates.length && <p className="empty-note form-wide">{de ? 'Kein verfügbarer Bestand. Zugewiesene Artikel zuerst zurückgeben.' : 'No stock available. Return assigned items first.'}</p>}
    <div className="form-actions"><button className="primary-action" disabled={loading || !record || stale || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > available(record.id, record.quantity)} type="submit">{de ? 'Zuweisung speichern' : 'Save assignment'}</button><button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>{de ? 'Abbrechen' : 'Cancel'}</button></div>
  </form>
}
