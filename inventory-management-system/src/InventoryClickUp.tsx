import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InventoryStatePayload } from '../shared/inventory.ts'
import type { InventoryWorkRequest } from '../shared/workflows.ts'
import { clickUpReport, type ClickUpApi, type ClickUpConnection, type ClickUpListLink, type ClickUpOption, type ClickUpTaskLink } from '../shared/clickup.ts'
import { Field } from './WorkflowField.tsx'

interface ProjectListResult { lists: ClickUpListLink[]; setup: 'disconnected' | 'unmapped' | 'inaccessible' | 'ready' }
interface Context { api: ClickUpApi; state: InventoryStatePayload; t: (en: string, de: string) => string; version: number; changed: () => void }
const ClickUpContext = createContext<Context | null>(null)
export function InventoryClickUpProvider({ api, state, de, children }: { api: ClickUpApi; state: InventoryStatePayload; de: boolean; children: ReactNode }) {
  const [version, setVersion] = useState(0)
  return <ClickUpContext.Provider value={{ api, state, version, changed: () => setVersion(v => v + 1), t: (en, german) => de ? german : en }}>{children}</ClickUpContext.Provider>
}
function useClickUp() { const context = useContext(ClickUpContext); if (!context) throw new Error('ClickUp provider missing'); return context }
function useResource<T>(path: string) {
  const { api, version } = useClickUp()
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>({ path })
  useEffect(() => {
    let alive = true
    void api<T>(path).then(data => { if (alive) setResult({ path, data }) }, error => { if (alive) setResult({ path, error: error.message }) })
    return () => { alive = false }
  }, [api, path, version])
  return result.path === path ? result : { path }
}
function useAction() {
  const { api, changed } = useClickUp(), [pending, setPending] = useState(false), [error, setError] = useState(''), busy = useRef(false)
  async function run(path: string, body: Record<string, unknown>, done?: () => void) {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try { await api(path, body); changed(); done?.() }
    catch (e) { setError(e instanceof Error ? e.message : 'ClickUp request failed'); changed() }
    finally { busy.current = false; setPending(false) }
  }
  return { pending, error, run }
}
function ErrorNote({ error }: { error?: string }) { return error ? <p role="alert" className="workflow-warning">{error}</p> : null }
function Account({ connection }: { connection: ClickUpConnection }) {
  const { t } = useClickUp(), { run, pending, error } = useAction(), [saved, setSaved] = useState(false)
  return <div className="clickup-account">
    {connection.connected ? <><p>{t('Connected as', 'Verbunden als')} <strong>{connection.name}</strong></p><button type="button" className="secondary-action" disabled={pending} onClick={() => void run('/disconnect', {})}>{t('Disconnect my account', 'Meine Verbindung trennen')}</button><small>{t('Disconnecting pauses your automatic updates. Existing ClickUp tasks remain.', 'Trennen pausiert deine automatischen Statusmeldungen. Bestehende ClickUp-Aufgaben bleiben erhalten.')}</small></> : <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget, value = String(new FormData(form).get('token') ?? ''); void run('/connect', { token: value }, () => { form.reset(); setSaved(true) }) }}>
      <p>{t('Connect your personal ClickUp account. Only your accessible workspaces, lists and tasks are offered.', 'Verbinde dein persönliches ClickUp-Konto. Zur Auswahl stehen deine zugänglichen Workspaces, Listen und Aufgaben.')}</p>
      {!connection.configured && <p role="status">{t('An administrator needs to configure ClickUp encryption on the server first.', 'Ein Administrator muss zuerst die ClickUp-Verschlüsselung auf dem Server einrichten.')}</p>}
      <label>{t('Personal ClickUp API token', 'Persönlicher ClickUp-API-Token')}<input name="token" type="password" required autoComplete="off" spellCheck={false} maxLength={260} disabled={!connection.configured || pending} /></label>
      <small>{t('ClickUp → Settings → Apps → API Token. Saved encrypted on the server.', 'ClickUp → Einstellungen → Apps → API-Token. Wird verschlüsselt auf dem Server gespeichert.')} <a href="https://developer.clickup.com/docs/authentication" target="_blank" rel="noreferrer">{t('ClickUp instructions', 'ClickUp-Anleitung')}</a></small>
      <div className="form-actions"><button className="primary-action" disabled={!connection.configured || pending}>{pending ? t('Connecting…', 'Verbinde…') : t('Connect ClickUp', 'ClickUp verbinden')}</button></div>
    </form>}
    <ErrorNote error={error} />{saved && <p role="status">{t('ClickUp connected.', 'ClickUp verbunden.')}</p>}
  </div>
}
function ConnectionGate({ children }: { children: ReactNode }) {
  const { data, error } = useResource<ClickUpConnection>('/connection'), { t, changed } = useClickUp()
  if (error) return <><ErrorNote error={error} /><button type="button" className="secondary-action" onClick={changed}>{t('Retry', 'Erneut versuchen')}</button></>
  if (!data) return <p role="status">{t('Loading ClickUp connection…', 'ClickUp-Verbindung wird geladen…')}</p>
  return <>{data.connected ? <><details className="clickup-account-details"><summary>{t('My ClickUp account', 'Mein ClickUp-Konto')} · {data.name}</summary><Account connection={data} /></details>{children}</> : <Account connection={data} />}</>
}
function Choice({ label, value, onChange, path, empty }: { label: string; value: string; onChange: (id: string) => void; path: string; empty?: string }) {
  const { data, error } = useResource<{ options: ClickUpOption[] }>(path), { t } = useClickUp()
  return <div><Field label={label}><select value={value} onChange={e => onChange(e.target.value)} disabled={!data} required={!empty}>
    <option value="">{data ? empty ?? t('Choose…', 'Auswählen…') : t('Loading…', 'Wird geladen…')}</option>
    {data?.options.map(option => <option key={option.id} value={option.id}>{option.name} · {option.id}</option>)}
  </select></Field><ErrorNote error={error} /></div>
}
function ListPicker({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const { t } = useClickUp(), { run, pending, error } = useAction()
  const [workspace, setWorkspace] = useState(''), [space, setSpace] = useState(''), [folder, setFolder] = useState(''), [list, setList] = useState('')
  return <form onSubmit={e => { e.preventDefault(); void run(`/projects/${projectId}/lists`, { workspaceId: workspace, listId: list }, onDone) }}>
    <fieldset disabled={pending} className="clickup-fields"><legend>{t('Link a team list', 'Team-Liste verknüpfen')}</legend>
      <Choice label="Workspace" path="/browse?kind=workspaces" value={workspace} onChange={value => { setWorkspace(value); setSpace(''); setFolder(''); setList('') }} />
      {workspace && <Choice label="Space / Team" path={`/browse?kind=spaces&parent=${workspace}`} value={space} onChange={value => { setSpace(value); setFolder(''); setList('') }} />}
      {space && <Choice label={t('Folder', 'Ordner')} path={`/browse?kind=folders&parent=${space}`} value={folder} onChange={value => { setFolder(value); setList('') }} empty={t('Lists without a folder', 'Listen ohne Ordner')} />}
      {space && <Choice label={t('Project list', 'Projektliste')} path={`/browse?kind=lists&parent=${folder || space}&folder=${!!folder}`} value={list} onChange={setList} />}
    </fieldset><ErrorNote error={error} /><div className="form-actions"><button className="primary-action" disabled={pending || !list}>{t('Link list', 'Liste verknüpfen')}</button><button type="button" className="secondary-action" onClick={onDone} disabled={pending}>{t('Cancel', 'Abbrechen')}</button></div>
  </form>
}
function ListSetupNote({ setup, projectId }: { setup: ProjectListResult['setup']; projectId: string }) {
  const { state, t, changed } = useClickUp()
  const canManage = state.permissions.includes('manage_projects')
  const project = state.projects.find(p => p.id === projectId)?.name ?? t('this project', 'dieses Projekt')
  return <div className="workflow-setup-note" role="status">
    <strong>{setup === 'inaccessible' ? t('Project lists exist, but your ClickUp account cannot access them.', 'Projektlisten sind verknüpft, aber dein ClickUp-Konto hat darauf keinen Zugriff.') : setup === 'disconnected' ? t('Connect your personal ClickUp account first.', 'Verbinde zuerst dein persönliches ClickUp-Konto.') : <>{t('Account connected. No ClickUp list is linked to', 'Konto verbunden. Noch keine ClickUp-Liste verknüpft mit')} {project}.</>}</strong>
    <p>{setup === 'inaccessible' ? t('Ask the ClickUp list owner to give your account access, or check that you connected the right account under “My ClickUp account”. Then refresh.', 'Bitte die verantwortliche Person in ClickUp um Zugriff oder prüfe unter „Mein ClickUp-Konto“, ob das richtige Konto verbunden ist. Danach aktualisieren.') : setup === 'disconnected' ? t('Open “My ClickUp account” and reconnect, then refresh.', 'Öffne „Mein ClickUp-Konto“, verbinde dich erneut und aktualisiere.') : canManage ? t('In Projects, select this project and open Project details & ClickUp → Team lists & connection → Add team list. Link each team’s project list separately.', 'Wähle unter Projekte dieses Projekt und öffne Projektdetails & ClickUp → Team-Listen & Verbindung → Team-Liste hinzufügen. Verknüpfe die Projektliste jedes Teams einzeln.') : t('An inventory administrator or someone who manages projects must link the team lists once in Projects → Project details & ClickUp. Your role can then link its own requests to those lists. Ask your administrator to set this up.', 'Ein Inventar-Admin oder eine Person mit Projektverwaltung muss die Team-Listen einmal unter Projekte → Projektdetails & ClickUp verknüpfen. Danach kannst du deine eigenen Anfragen damit verbinden. Bitte euren Admin um diese Einrichtung.')}</p>
    <button type="button" className="secondary-action" onClick={changed}>{t('Refresh setup', 'Einrichtung aktualisieren')}</button>
  </div>
}
function ProjectLists({ projectId }: { projectId: string }) {
  const { state, t, changed } = useClickUp(), { data, error } = useResource<ProjectListResult>(`/projects/${projectId}/lists`), [adding, setAdding] = useState(false), action = useAction()
  const canManage = state.permissions.includes('manage_projects')
  return <><p>{canManage ? t('Link all team lists that belong to this inventory project. Identical names stay separate by their full path and ID.', 'Verknüpfe die Team-Listen, die zu diesem Inventarprojekt gehören. Gleiche Namen bleiben durch Pfad und ID unterscheidbar.') : t('Your requests can be linked to the project lists shown here. The path identifies each team.', 'Deine Anfragen können mit den hier angezeigten Projektlisten verknüpft werden. Der Pfad zeigt das jeweilige Team.')}</p>
    <ErrorNote error={error || action.error} />{data?.lists.map(list => <div className="workflow-row" key={list.listId}><div><strong>{list.path}</strong><small>{t('List', 'Liste')} {list.listId}</small></div>{canManage && <button className="secondary-action" type="button" disabled={action.pending} onClick={() => void action.run(`/projects/${projectId}/unlink`, { listId: list.listId })}>{t('Unlink list', 'Listenzuordnung entfernen')}</button>}</div>)}
    {data?.lists.length === 0 && <ListSetupNote setup={data.setup} projectId={projectId} />}
    {!data && !error && <p role="status">{t('Loading team lists…', 'Team-Listen werden geladen…')}</p>}
    {error && <button type="button" className="secondary-action" onClick={changed}>{t('Retry', 'Erneut versuchen')}</button>}
    {canManage && (adding ? <ListPicker projectId={projectId} onDone={() => setAdding(false)} /> : <div className="form-actions"><button className="secondary-action" type="button" onClick={() => setAdding(true)}>{t('Add team list', 'Team-Liste hinzufügen')}</button></div>)}
    {canManage && Boolean(data?.lists.length) && <small>{t('Removing a list assignment leaves request links intact.', 'Bestehende Aufgabenverknüpfungen bleiben beim Entfernen einer Listenzuordnung erhalten.')}</small>}
  </>
}
export function ClickUpProject({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false), { t } = useClickUp()
  return <details className="clickup-panel" onToggle={e => setOpen(e.currentTarget.open)}><summary>ClickUp · {t('Team lists & connection', 'Team-Listen & Verbindung')}</summary>{open && <ConnectionGate>{projectId ? <ProjectLists key={projectId} projectId={projectId} /> : <p>{t('Select an inventory project above to link its ClickUp lists.', 'Wähle oben ein Inventarprojekt, um dessen ClickUp-Listen zu verknüpfen.')}</p>}</ConnectionGate>}</details>
}
function TaskPicker({ listId, value, onChange }: { listId: string; value: string; onChange: (id: string) => void }) {
  const { t } = useClickUp(), [page, setPage] = useState(0), [query, setQuery] = useState('')
  const { data, error } = useResource<{ tasks: Array<ClickUpOption & { status?: string }>; more: boolean }>(`/lists/${listId}/tasks?page=${page}`)
  const tasks = data?.tasks.filter(task => task.id === value || task.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? []
  return <><label>{t('Find on this page', 'Auf dieser Seite suchen')}<input type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} /></label>
    <Field label={t('Existing task', 'Bestehende Aufgabe')}><select value={value} onChange={e => onChange(e.target.value)} required disabled={!data}><option value="">{t('Choose task…', 'Aufgabe auswählen…')}</option>{tasks.map(task => <option value={task.id} key={task.id}>{task.name} · {task.status} · {task.id}</option>)}</select></Field>
    <div className="form-actions"><button type="button" className="secondary-action" disabled={!page} onClick={() => { setPage(p => p - 1); onChange('') }}>{t('Previous', 'Zurück')}</button><span>{t('Page', 'Seite')} {page + 1}</span><button type="button" className="secondary-action" disabled={!data?.more} onClick={() => { setPage(p => p + 1); onChange('') }}>{t('More tasks', 'Weitere Aufgaben')}</button></div><ErrorNote error={error} />
  </>
}
function RequestLinkForm({ requests, links }: { requests: InventoryWorkRequest[]; links: ClickUpTaskLink[] }) {
  const { state, t, changed } = useClickUp(), first = requests[0]
  const { data, error } = useResource<ProjectListResult>(`/projects/${first.projectId}/lists`)
  const [chosen, setChosen] = useState(''), [taskChoice, setTaskChoice] = useState({ listId: '', id: '' }), [mode, setMode] = useState('create'), action = useAction()
  const lists = data?.lists.filter(list => !links.some(link => link.listId === list.listId && !link.pending)) ?? []
  const selected = lists.find(list => list.listId === chosen) ?? (lists.length === 1 ? lists[0] : undefined), listId = selected?.listId ?? ''
  const task = taskChoice.listId === listId ? taskChoice.id : ''
  const setTask = (id: string) => setTaskChoice({ listId, id })
  const uncertain = links.some(link => link.listId === listId && link.pending), existing = mode === 'link' || uncertain
  const project = state.projects.find(p => p.id === first.projectId)
  if (error) return <><ErrorNote error={error} /><button type="button" className="secondary-action" onClick={changed}>{t('Retry', 'Erneut versuchen')}</button></>
  if (!data) return <p role="status">{t('Loading team lists…', 'Team-Listen werden geladen…')}</p>
  if (!data.lists.length) return <ListSetupNote setup={data.setup} projectId={first.projectId!} />
  if (!lists.length) return <p>{t('This request is linked to all team lists accessible to you. You can follow their tasks above.', 'Diese Anfrage ist mit allen für dich zugänglichen Team-Listen verknüpft. Die Aufgaben findest du oben.')}</p>
  return <form onSubmit={e => { e.preventDefault(); void action.run(`/requests/${first.id}/link`, { listId, ...(existing ? { taskId: task } : {}) }, () => setTask('')) }}>
    <fieldset disabled={action.pending} className="clickup-fields"><legend>{t('Send request to ClickUp', 'Anfrage mit ClickUp verbinden')}</legend>
      <Field label={t('Team list', 'Team-Liste')}><select value={listId} required onChange={e => { setChosen(e.target.value); setTask('') }}><option value="">{t('Choose…', 'Auswählen…')}</option>{lists.map(list => <option value={list.listId} key={list.listId}>{list.path} · {list.listId}</option>)}</select></Field>
      <Field label={t('Action', 'Aktion')}><select value={existing ? 'link' : 'create'} disabled={uncertain} onChange={e => { setMode(e.target.value); setTask('') }}><option value="create">{t('Create a task for this request', 'Aufgabe für diese Anfrage anlegen')}</option><option value="link">{t('Link an existing task', 'Bestehende Aufgabe verknüpfen')}</option></select></Field>
      {existing && listId && <TaskPicker key={listId} listId={listId} value={task} onChange={setTask} />}
    </fieldset>
    {!existing && <><p>{t('All positions stay together. The inventory report in the task description updates automatically, usually within a minute.', 'Alle Positionen bleiben zusammen. Der Inventarbericht in der Aufgabenbeschreibung wird automatisch aktualisiert, normalerweise innerhalb einer Minute.')}</p><details><summary>{t('Preview content sent to ClickUp', 'Inhalt für ClickUp ansehen')}</summary><pre className="clickup-preview">{clickUpReport(state.workflows!, requests, project?.name ?? '')}</pre></details></>}
    {existing && <p>{t('This links the existing task and shows its ClickUp status here. Its contents are managed in ClickUp.', 'Die vorhandene Aufgabe wird verknüpft und ihr ClickUp-Status hier angezeigt. Ihre Inhalte werden in ClickUp gepflegt.')}</p>}
    <ErrorNote error={action.error} /><div className="form-actions"><button className="primary-action" disabled={action.pending || !listId || (existing && !task)}>{existing ? t('Link task', 'Aufgabe verknüpfen') : t('Create ClickUp task', 'ClickUp-Aufgabe anlegen')}</button></div>
  </form>
}
function RequestLinks({ requests }: { requests: InventoryWorkRequest[] }) {
  const { state, t, changed } = useClickUp(), first = requests[0], action = useAction()
  const { data, error } = useResource<{ links: ClickUpTaskLink[] }>(`/requests/${first.id}`)
  const canLink = state.permissions.includes('order_stock') || (state.permissions.includes('request_stock') && first.requesterId === state.currentUser.id)
  return <><div className="form-actions"><button type="button" className="secondary-action" onClick={changed}>{t('Refresh ClickUp status', 'ClickUp-Status aktualisieren')}</button></div><ErrorNote error={error || action.error} />
    {data?.links.map(link => <div className="workflow-row" key={link.listId}><div>{link.url ? <a href={link.url} target="_blank" rel="noreferrer">{link.name}</a> : <strong>{t('Creation not confirmed', 'Erstellung nicht bestätigt')}</strong>}<small>ClickUp: {link.status ?? '—'} · {t('List', 'Liste')} {link.listId}</small>{link.managed && <small>{t('Inventory report last sent', 'Inventarbericht zuletzt gesendet')}: {link.lastSyncedAt ? new Date(link.lastSyncedAt).toLocaleString() : '—'}</small>}<ErrorNote error={link.error} /></div>{canLink && link.canRemove && <button className="secondary-action" type="button" disabled={action.pending} onClick={() => void action.run(`/requests/${first.id}/unlink`, { listId: link.listId })}>{t('Unlink task', 'Aufgabenverknüpfung lösen')}</button>}</div>)}
    {data && canLink && (first.projectId ? <RequestLinkForm requests={requests} links={data.links} /> : <p>{t('Choose a project for the request to select its ClickUp team lists.', 'Ordne die Anfrage einem Projekt zu, um dessen ClickUp-Team-Listen auszuwählen.')}</p>)}
    {data?.links.filter(link => link.pending).map(link => <details key={link.listId}><summary>{t('Task is missing in ClickUp?', 'Aufgabe fehlt in ClickUp?')}</summary><form onSubmit={e => { e.preventDefault(); void action.run(`/requests/${first.id}/retry-create`, { listId: link.listId, confirmedMissing: true }) }}><label className="workflow-check"><input type="checkbox" required />{t('I checked the list and request reference in ClickUp. No task was created.', 'Ich habe die Liste und Anfragenummer in ClickUp geprüft. Es wurde keine Aufgabe angelegt.')}</label><div className="form-actions"><button className="secondary-action" disabled={action.pending}>{t('Allow another creation attempt', 'Erneute Erstellung ermöglichen')}</button></div></form></details>)}
    {data?.links.length === 0 && !canLink && <p>{t('No accessible linked tasks.', 'Keine zugänglichen Aufgaben verknüpft.')}</p>}
  </>
}
export function ClickUpRequest({ requests }: { requests: InventoryWorkRequest[] }) {
  const [open, setOpen] = useState(false), { t } = useClickUp()
  return <details className="clickup-panel clickup-request" onToggle={e => setOpen(e.currentTarget.open)}><summary>ClickUp · {t('Tasks & status', 'Aufgaben & Status')}</summary>{open && <ConnectionGate><RequestLinks requests={requests} /></ConnectionGate>}</details>
}
