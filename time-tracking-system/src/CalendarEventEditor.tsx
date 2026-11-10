import { useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import type { CustomCalendarEvent } from '../shared/domain.ts'
import { sensibleDateBounds } from '../shared/dates.ts'
import { CalendarDialog } from './CalendarDialog.tsx'
import { AnimatedRegion } from './DisclosureMotion.tsx'

type Copy = Record<'editEvent' | 'cancel' | 'eventTitle' | 'date' | 'allDayEvent' | 'start' | 'end' | 'eventDescription' | 'shareEventWithCalendarUsers' | 'deleteEvent' | 'updateEvent', string>

export function CustomCalendarEventModal({ event, language, loading, t, onClose, onUpdate, onDelete }: {
  event: CustomCalendarEvent
  language: 'en' | 'de'
  loading: boolean
  t: Copy
  onClose: () => void
  onUpdate: (id: string, body: Record<string, unknown>) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}) {
  const titleId = useId(), de = language === 'de'
  const [title, setTitle] = useState(event.title)
  const [description, setDescription] = useState(event.description ?? '')
  const [date, setDate] = useState(event.date)
  const [isAllDay, setIsAllDay] = useState(event.isAllDay)
  const [startTime, setStartTime] = useState(event.startTime ?? '09:00')
  const [endTime, setEndTime] = useState(event.endTime ?? '10:00')
  const [shareWithCalendarUsers, setShareWithCalendarUsers] = useState(event.shareWithCalendarUsers)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const bounds = useMemo(() => sensibleDateBounds(), [])
  const busy = loading || pending
  const invalidTime = !isAllDay && (!startTime || !endTime || startTime >= endTime)

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault()
    if (busy || confirmDelete || !title.trim() || !date || invalidTime) return
    setPending(true); setError('')
    try {
      if (await onUpdate(event.id, { title, description, date, isAllDay, startTime, endTime, shareWithCalendarUsers })) onClose()
      else setError(de ? 'Der Termin konnte nicht gespeichert werden. Deine Änderungen bleiben im Formular.' : 'Could not save the event. Your changes remain in the form.')
    } catch { setError(de ? 'Speichern fehlgeschlagen. Bitte erneut versuchen.' : 'Saving failed. Please try again.') }
    finally { setPending(false) }
  }
  async function remove() {
    if (busy || !confirmDelete) return
    setPending(true); setError('')
    try {
      if (await onDelete(event.id)) onClose()
      else setError(de ? 'Der Termin konnte nicht gelöscht werden.' : 'Could not delete the event.')
    } catch { setError(de ? 'Löschen fehlgeschlagen. Bitte erneut versuchen.' : 'Deleting failed. Please try again.') }
    finally { setPending(false) }
  }

  return <CalendarDialog titleId={titleId} className="custom-event-modal" onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <header className="calendar-dialog-header"><h2 id={titleId}>{t.editEvent}</h2>
        <button className="icon-button" type="button" aria-label={de ? 'Schließen' : 'Close'} disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <fieldset className="calendar-dialog-fields" disabled={busy}>
        <label>{t.eventTitle}<input autoFocus required maxLength={140} value={title} onChange={e => setTitle(e.target.value)}/></label>
        <div className="calendar-event-date-row"><label>{t.date}<input type="date" required min={bounds.min} max={bounds.max} value={date} onChange={e => setDate(e.target.value)}/></label>
          <label className="toggle-row"><input type="checkbox" checked={isAllDay} onChange={e => setIsAllDay(e.target.checked)}/><span>{t.allDayEvent}</span></label></div>
        <AnimatedRegion open={!isAllDay}><div className="custom-event-time-grid"><label>{t.start}<input type="time" required={!isAllDay} value={startTime} onChange={e => setStartTime(e.target.value)}/></label>
          <label>{t.end}<input type="time" required={!isAllDay} value={endTime} onChange={e => setEndTime(e.target.value)}/></label></div>
          {invalidTime && <p className="form-error">{de ? 'Das Ende muss nach dem Beginn liegen.' : 'The end must be after the start.'}</p>}</AnimatedRegion>
        <label>{t.eventDescription}<textarea rows={3} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)}/></label>
        <label className="toggle-row calendar-event-sharing"><input type="checkbox" checked={shareWithCalendarUsers} onChange={e => setShareWithCalendarUsers(e.target.checked)}/><span>{t.shareEventWithCalendarUsers}</span></label>
      </fieldset>
      {error && <p className="calendar-dialog-error form-error" role="alert">{error}</p>}
      <AnimatedRegion open={confirmDelete}><div className="calendar-delete-confirmation" role="status"><strong>{de ? 'Diesen Termin löschen?' : 'Delete this event?'}</strong><p>{event.title}</p></div></AnimatedRegion>
      <footer className="calendar-dialog-footer">
        <button className="secondary-button danger-button calendar-delete-action" type="button" disabled={busy} onClick={() => confirmDelete ? void remove() : setConfirmDelete(true)}><Trash2 size={16}/>{confirmDelete ? (de ? 'Endgültig löschen' : 'Confirm deletion') : t.deleteEvent}</button>
        <div className="calendar-save-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => confirmDelete ? setConfirmDelete(false) : onClose()}>{t.cancel}</button>
          {!confirmDelete && <button className="primary-button" type="submit" disabled={busy || !title.trim() || !date || invalidTime} aria-busy={pending}><Check size={16}/>{de ? 'Speichern' : 'Save changes'}</button>}</div>
      </footer>
    </form>
  </CalendarDialog>
}
