import { PasswordInput } from '@digital-core-office/suite-ui'
import { useEffect, useRef, useState, type FormEvent } from 'react'

type ModuleId = 'time' | 'inventory' | 'agile'
interface Membership { moduleId: ModuleId; role: string; active: boolean }
interface DirectoryUser { id: string; name: string; email: string; role: 'admin' | 'employee'; active: boolean; memberships: Membership[] }
const roles: Record<ModuleId, string[]> = { time: ['admin', 'employee'], inventory: ['admin', 'hardware_developer', 'software_developer', 'buyer', 'receiver', 'buyer_receiver', 'stock_manager', 'viewer'], agile: ['admin', 'employee', 'viewer'] }

export default function UserDirectory({ language, currentUserId, enabledModules }: { language: 'de' | 'en'; currentUserId: string; enabledModules: string[] }) {
  const de = language === 'de'
  const moduleNames = de ? { time: 'Zeiterfassung', inventory: 'Inventar', agile: 'Projekte' } : { time: 'Time', inventory: 'Inventory', agile: 'Projects' }
  const editor = useRef<HTMLFormElement>(null)
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [selected, setSelected] = useState<DirectoryUser | null>(null)
  const [editing, setEditing] = useState(false)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const response = await fetch('/api/core/users', { credentials: 'same-origin' })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || 'Users could not be loaded.')
    setUsers(payload.users)
  }
  useEffect(() => { void refresh().catch((reason: Error) => setError(reason.message)) }, [])
  useEffect(() => {
    if (editing) {
      editor.current?.scrollIntoView({ block: 'start' })
      editor.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus({ preventScroll: true })
    }
  }, [editing, selected])

  function edit(user: DirectoryUser | null) {
    setSelected(user)
    setMemberships((Object.keys(roles) as ModuleId[]).map((moduleId) => user?.memberships.find((item) => item.moduleId === moduleId)
      ?? { moduleId, role: moduleId === 'inventory' ? 'viewer' : 'employee', active: enabledModules.includes(moduleId) }))
    setError('')
    setEditing(true)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    try {
      const response = await fetch(`/api/core/users${selected ? `/${selected.id}` : ''}`, {
        method: selected ? 'PATCH' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name'), email: form.get('email'), role: form.get('role'), active: form.get('active') === 'on', memberships, ...(password ? { password } : {}) }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || 'User could not be saved.')
      if (selected?.id === currentUserId) { window.location.assign('/'); return }
      await refresh()
      setEditing(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Request failed.') }
    finally { setBusy(false) }
  }

  const roleLabels: Record<string, string> = { admin: 'Administrator', employee: 'Mitarbeiter', viewer: 'Lesen', hardware_developer: 'Hardwareentwicklung', software_developer: 'Softwareentwicklung', buyer: 'Freigabe und Einkauf', receiver: 'Wareneingang', buyer_receiver: 'Einkauf und Wareneingang', stock_manager: 'Lagerverwaltung' }
  const roleLabel = (role: string) => de ? (roleLabels[role] || role) : role.replaceAll('_', ' ')
  const visibleUsers = users.filter(user => `${user.name} ${user.email}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <section className="core-panel core-users-panel" id="users">
    <div className="core-panel-title"><h3>{de ? 'Benutzer und Zugriffsrechte' : 'Users and access'}</h3><button className="core-primary" onClick={() => edit(null)}>{de ? 'Benutzer hinzufügen' : 'Add user'}</button></div>
    <p>{de ? 'Konten gelten für die gesamte Suite. Änderungen widerrufen bestehende Sitzungen. Neue Benutzer ändern ihr temporäres Passwort bei der ersten Anmeldung.' : 'Accounts apply across the suite. Changes revoke existing sessions. New users change their temporary password at first sign-in.'}</p>
    {error && <p role="alert" className="core-banner core-banner-error">{error}</p>}
    <label className="core-user-search">{de ? 'Nutzer suchen' : 'Find users'}<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={de ? 'Name oder E-Mail' : 'Name or email'} /></label>
    <p className="core-user-count" role="status">{visibleUsers.length} / {users.length} {de ? 'Nutzer' : 'users'}</p>
    {query && visibleUsers.length === 0 && <p>{de ? 'Keine passenden Nutzer gefunden.' : 'No matching users found.'}</p>}
    <div className="core-users-list">{visibleUsers.map((user) => <div className="core-user-row" key={user.id}>
      <div><strong>{user.name}</strong><small>{user.email}</small></div>
      <span>{roleLabel(user.role)} · {user.active ? (de ? 'Aktiv' : 'Active') : (de ? 'Inaktiv' : 'Inactive')}</span>
      <button className="core-link-button" onClick={() => edit(user)} aria-label={`${de ? 'Bearbeiten' : 'Edit'} ${user.name}`}>{de ? 'Bearbeiten' : 'Edit'}</button>
    </div>)}</div>
    {editing && <form ref={editor} className="core-form core-user-form" onSubmit={save} key={selected?.id || 'new'}>
      <h4>{selected ? (de ? 'Benutzer bearbeiten' : 'Edit user') : (de ? 'Neuer Benutzer' : 'New user')}</h4>
      <label>{de ? 'Name' : 'Name'}<input name="name" required maxLength={160} defaultValue={selected?.name} /></label>
      <label>{de ? 'E-Mail' : 'Email'}<input name="email" type="email" required maxLength={180} defaultValue={selected?.email} /></label>
      <label>{de ? 'Rolle in Core' : 'Core role'}<select name="role" defaultValue={selected?.role || 'employee'}><option value="employee">{roleLabel('employee')}</option><option value="admin">{roleLabel('admin')}</option></select></label>
      <label className="core-check"><input name="active" type="checkbox" defaultChecked={selected?.active ?? true} />{de ? 'Konto aktiv' : 'Account active'}</label>
      <label>{de ? 'Temporäres Passwort' : 'Temporary password'}<PasswordInput aria-label={de ? 'Temporäres Passwort' : 'Temporary password'} language={language} name="password" autoComplete="new-password" required={!selected} minLength={14} maxLength={500} /></label>
      {selected && <small>{de ? 'Leer lassen, um das Passwort beizubehalten.' : 'Leave blank to keep the current password.'}</small>}
      <fieldset><legend>{de ? 'Systemzugriff' : 'System access'}</legend>{memberships.map((membership, index) => <div className="core-membership" key={membership.moduleId}>
        <label className="core-check"><input type="checkbox" checked={membership.active} onChange={(event) => setMemberships((current) => current.map((item, i) => i === index ? { ...item, active: event.target.checked } : item))} />{moduleNames[membership.moduleId]}</label>
        <select aria-label={`${moduleNames[membership.moduleId]} ${de ? 'Rolle' : 'role'}`} value={membership.role} onChange={(event) => setMemberships((current) => current.map((item, i) => i === index ? { ...item, role: event.target.value } : item))}>{roles[membership.moduleId].map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select>
      </div>)}</fieldset>
      <div className="core-form-actions"><button className="core-primary" disabled={busy}>{de ? 'Speichern' : 'Save user'}</button><button type="button" className="core-link-button" disabled={busy} onClick={() => setEditing(false)}>{de ? 'Abbrechen' : 'Cancel'}</button></div>
    </form>}
  </section>
}
