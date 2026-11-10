import { useId, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'
import { CalendarDialog } from './CalendarDialog.tsx'
import { CalendarKindIcon } from './CalendarKindIcon.tsx'

export interface CalendarListItem {
  id: string
  title: string
  kind: string
  meta?: string
  userId?: string
  customEventId?: string
}

export function CalendarDayItems({ items, date, currentUserId, language, onOpenCustomEvent, limit = 3 }: {
  items: CalendarListItem[]
  date: string
  currentUserId: string
  language: 'en' | 'de'
  onOpenCustomEvent: (id: string) => void
  limit?: number
}) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <div className="calendar-day-items">
      {items.slice(0, limit).map(item => {
        const className = `calendar-compact-item ${item.kind === 'holiday' ? 'holiday-pill' : `absence-pill ${item.kind}`}`
        const text = [item.title, item.meta].filter(Boolean).join(' · ')
        return item.customEventId && item.userId === currentUserId
          ? <button key={item.id} type="button" className={`${className} calendar-event-button`} title={text} onClick={() => onOpenCustomEvent(item.customEventId!)}><CalendarKindIcon kind={item.kind} />{text}</button>
          : <button key={item.id} type="button" className={`${className} calendar-event-button`} title={text} onClick={() => setExpanded(true)}><CalendarKindIcon kind={item.kind} />{text}</button>
      })}
    </div>
    {items.length > limit && <button className="calendar-more-button" type="button" onClick={() => setExpanded(true)}
      aria-label={language === 'de' ? `${items.length} Einträge am ${date} anzeigen` : `Show ${items.length} entries on ${date}`}>
      +{items.length - limit} {language === 'de' ? 'weitere' : 'more'}
    </button>}
    {expanded && <CalendarDayAgenda items={items} date={date} currentUserId={currentUserId} language={language}
      onClose={() => setExpanded(false)} onOpenCustomEvent={id => { setExpanded(false); onOpenCustomEvent(id) }} />}
  </>
}

export function CalendarDayAgenda({ items, date, currentUserId, language, onClose, onOpenCustomEvent }: {
  items: CalendarListItem[]
  date: string
  currentUserId: string
  language: 'en' | 'de'
  onClose: () => void
  onOpenCustomEvent: (id: string) => void
}) {
  const titleId = useId(), de = language === 'de'
  const [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const filtered = useMemo(() => items.filter(item => `${item.title} ${item.meta ?? ''}`.toLocaleLowerCase(language).includes(query.trim().toLocaleLowerCase(language))), [items, query, language])
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), currentPage = Math.min(page, pages - 1)
  const labelDate = new Intl.DateTimeFormat(de ? 'de-DE' : 'en-GB', { dateStyle: 'full' }).format(new Date(`${date}T12:00:00`))
  return <CalendarDialog titleId={titleId} className="calendar-agenda-modal" onClose={onClose}>
    <header className="calendar-dialog-header"><div><h2 id={titleId}>{labelDate}</h2><p>{items.length} {de ? 'Kalendereinträge' : 'calendar entries'}</p></div>
      <button className="icon-button" type="button" aria-label={de ? 'Schließen' : 'Close'} onClick={onClose}><X size={18} /></button></header>
    <label className="calendar-agenda-search">{de ? 'Termine durchsuchen' : 'Search events'}<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
    <div className="calendar-agenda-list">
      {filtered.slice(currentPage * 25, (currentPage + 1) * 25).map(item => <article key={item.id} className="calendar-agenda-row">
        <i className={`legend-swatch ${item.kind}`} aria-hidden="true"><CalendarKindIcon kind={item.kind} /></i><div><strong>{item.title}</strong>{item.meta && <small>{item.meta}</small>}</div>
        {item.customEventId && item.userId === currentUserId && <button className="secondary-button" type="button" onClick={() => onOpenCustomEvent(item.customEventId!)}><Pencil size={15} />{de ? 'Bearbeiten' : 'Edit'}</button>}
      </article>)}
      {!filtered.length && <p>{de ? 'Keine passenden Termine.' : 'No matching events.'}</p>}
    </div>
    <footer className="calendar-agenda-pagination"><button type="button" className="secondary-button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} />{de ? 'Zurück' : 'Previous'}</button>
      <span>{currentPage + 1} / {pages}</span><button type="button" className="secondary-button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{de ? 'Weiter' : 'Next'}<ChevronRight size={16} /></button></footer>
  </CalendarDialog>
}
