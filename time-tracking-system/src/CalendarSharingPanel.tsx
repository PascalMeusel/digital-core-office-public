import { useState } from 'react'
import { Users } from 'lucide-react'
import type { User } from '../shared/domain.ts'
import './CalendarSharingPanel.css'

export function CalendarSharingPanel({ users, savedIds, language, disabled, onSave }: {
  users: User[]
  savedIds: string[]
  language: 'en' | 'de'
  disabled?: boolean
  onSave: (ids: string[]) => Promise<boolean>
}) {
  const text = (en: string, de: string) => language === 'de' ? de : en
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(10)
  // Keep local choices through background state refreshes, including fresh array identities.
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'saved' | 'error' | ''>('')
  const eligible = users.filter(user => user.active)
  const selected = eligible.filter(user => choices[user.id] ?? savedIds.includes(user.id))
  const selectedIds = new Set(selected.map(user => user.id))
  const changed = eligible.some(user => selectedIds.has(user.id) !== savedIds.includes(user.id))
  const locked = disabled || saving
  const query = search.trim().toLocaleLowerCase()
  const results = eligible.filter(user => !selectedIds.has(user.id) && query && `${user.name} ${user.email}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))

  function choose(id: string, grant: boolean) {
    setChoices(current => ({ ...current, [id]: grant }))
    setStatus('')
  }
  async function save() {
    setSaving(true)
    setStatus('')
    try {
      if (await onSave([...selectedIds])) {
        setChoices({})
        setStatus('saved')
      } else setStatus('error')
    } catch { setStatus('error') }
    finally { setSaving(false) }
  }
  function person(user: User, grant: boolean) {
    return <li key={user.id} className="calendar-sharing-person">
      <span><strong>{user.name}</strong><small>{user.email}</small>
        {!grant && !savedIds.includes(user.id) && <small>{text('Access will be granted on save', 'Freigabe erfolgt beim Speichern')}</small>}
      </span>
      <button type="button" className="secondary-button" disabled={locked}
        aria-label={`${grant ? text('Grant access to', 'Freigeben für') : text('Revoke access for', 'Freigabe entfernen für')} ${user.name}`}
        onClick={() => choose(user.id, grant)}>{grant ? text('Grant access', 'Freigeben') : text('Remove', 'Entfernen')}</button>
    </li>
  }
  return <section className="panel sharing-panel calendar-sharing-panel">
    <div className="panel-title"><Users size={18} /><h2>{text('Share my calendar', 'Meinen Kalender teilen')}</h2></div>
    <p className="muted">{text('Choose who can view your calendar. Your administrator’s group settings determine who is available. This does not give you access to their calendar.', 'Wähle, wer deinen Kalender sehen darf. Die Gruppeneinstellungen deiner Administration bestimmen, wer verfügbar ist. Du erhältst dadurch keinen Zugriff auf deren Kalender.')}</p>
    <label className="calendar-sharing-search">{text('Find people', 'Personen suchen')}
      <input type="search" value={search} placeholder={text('Search by name or email', 'Nach Name oder E-Mail suchen')}
        onChange={event => { setSearch(event.target.value); setLimit(10) }} />
    </label>
    {!eligible.length && <p className="muted">{text('No eligible colleagues. Ask your administrator to check your calendar groups.', 'Keine verfügbaren Kollegen. Bitte deine Administration, deine Kalendergruppen zu prüfen.')}</p>}
    {query && <div className="calendar-sharing-results">
      <p className="muted" role="status">{results.length ? `${results.length} ${text('people available', 'Personen verfügbar')}` : text('No additional people found. Check the shared list below or try another name.', 'Keine weiteren Personen gefunden. Prüfe die Freigabeliste unten oder suche nach einem anderen Namen.')}</p>
      <ul>{results.slice(0, limit).map(user => person(user, true))}</ul>
      {results.length > limit && <button type="button" className="secondary-button" onClick={() => setLimit(limit + 10)}>{text('Show more people', 'Weitere Personen anzeigen')}</button>}
    </div>}
    <h3>{text('Shared with', 'Freigegeben für')} <span>{selected.length}</span></h3>
    <ul className="calendar-sharing-granted">{[...selected].sort((a, b) => a.name.localeCompare(b.name)).map(user => person(user, false))}</ul>
    {!selected.length && <p className="muted">{text('No personal shares selected.', 'Keine persönlichen Freigaben ausgewählt.')}</p>}
    <p className="calendar-sharing-note muted">{text('Administrator access remains unchanged. Changes take effect after saving.', 'Der Zugriff der Administration bleibt bestehen. Änderungen gelten nach dem Speichern.')}</p>
    <div className="calendar-sharing-save">
      <button type="button" className="primary-button" disabled={locked || !changed} onClick={save}>{saving ? text('Saving…', 'Speichern…') : text('Save access', 'Freigaben speichern')}</button>
      {changed && <button type="button" className="secondary-button" disabled={locked} onClick={() => { setChoices({}); setStatus('') }}>{text('Discard changes', 'Änderungen verwerfen')}</button>}
    </div>
    <p className="calendar-sharing-status" role={status === 'error' ? 'alert' : 'status'}>{status === 'error' ? text('Could not save access. Your choices are retained; please try again.', 'Freigaben konnten nicht gespeichert werden. Deine Auswahl bleibt erhalten; bitte erneut versuchen.') : changed ? text('Unsaved changes', 'Ungespeicherte Änderungen') : status === 'saved' ? text('Calendar access saved.', 'Kalenderfreigaben gespeichert.') : ''}</p>
  </section>
}
