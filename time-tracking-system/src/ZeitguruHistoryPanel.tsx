import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ZeitguruHistoryApi, ZeitguruHistoryBatch, ZeitguruHistoryPage, ZeitguruHistoryStatus } from '../shared/zeitguruHistory.ts'
import type { ZeitguruAccountingContext } from '../shared/timeAccounting.ts'
import { organizationTimezone } from '../shared/dates.ts'
import './ZeitguruHistoryPanel.css'

const copy = {
  de: {
    title: 'Zeitguru-Verlauf', intro: 'Abgeschlossene Einträge bis gestern. Keine Datei nötig.',
    import: 'Meinen Zeitguru-Verlauf importieren', importing: 'Verlauf wird importiert …', verify: 'Zeitguru-Zugang prüfen',
    access: 'Prüfe zuerst deinen eigenen Zeitguru-Zugang. Du kannst den Verlauf auch während einer laufenden Schicht importieren, ohne die Stempelübertragung zu aktivieren.',
    archive: 'Dein Verlauf umfasst Arbeitszeiten, Pausen und Zeitguru-Gutschriften. Verfügbare Tagesabrechnungen ergänzen Arbeitsübersichten, Überstunden und Tage mit Klärungsbedarf. Laufende Stempelungen und deine Verbindung bleiben erhalten.',
    records: 'Einträge', worked: 'Erfasste Arbeitszeit', credited: 'In Zeitguru gutgeschrieben', hours: 'Std.', allArchive: 'Gesamtes Archiv',
    unknown: 'Nicht angegeben', unknownCredits: 'Einträge ohne ausgewiesene Zeitguru-Gutschrift; diese sind nicht in der Gutschriftensumme enthalten.',
    range: 'Zeitraum', latest: 'Importergebnis', added: 'Neu', duplicates: 'Bereits vorhanden', conflicts: 'Abweichend', skipped: 'Übersprungen',
    results: 'Unveränderte Einträge werden nicht doppelt angelegt. Bereits archivierte, abweichende Einträge bleiben erhalten und werden nicht überschrieben.',
    warnings: 'Hinweise zum Import', undo: 'Diesen Import zurücksetzen', undoTitle: 'Diesen Import zurücksetzen?',
    undoDetail: 'Dieser Import und seine Abrechnungsbeiträge werden zurückgenommen, sofern sie unverändert sind. Eine zuvor importierte Abrechnung wird wiederhergestellt. Ältere Daten, laufende DCO-Stempelungen und deine Zeitguru-Verbindung bleiben erhalten. In Zeitguru wird nichts geändert.',
    undone: 'Dieser Import wurde zurückgesetzt.', undoUnavailable: 'Dieser Import kann nicht mehr unverändert zurückgesetzt werden.',
    undoing: 'Import wird zurückgesetzt …', cancel: 'Abbrechen', empty: 'Noch keine Einträge für diesen Zeitraum archiviert.',
    show: 'Verlauf anzeigen und importieren', loading: 'Verlauf wird geladen …', loadMore: 'Weitere Einträge laden', loaded: 'Einträge angezeigt',
    start: 'Beginn', end: 'Ende', break: 'Pause', approval: 'Zeitguru-Freigabe', approved: 'Freigegeben', unapproved: 'Nicht freigegeben',
    from: 'Von', to: 'Bis', filter: 'Zeitraum anzeigen', invalidRange: 'Das Enddatum darf nicht vor dem Startdatum liegen.',
    retryLoad: 'Verlauf erneut laden', readOnly: 'Das Archiv kann in diesem schreibgeschützten Konto angesehen, aber nicht geändert werden.',
    failed: 'Die Anfrage für den Zeitguru-Verlauf ist fehlgeschlagen. Die DCO-Stempeluhr bleibt verfügbar.',
  },
  en: {
    title: 'Zeitguru history', intro: 'Closed entries through yesterday. No file needed.',
    import: 'Import my Zeitguru history', importing: 'Importing history …', verify: 'Verify Zeitguru access',
    access: 'First verify your own Zeitguru credentials. You can import history during an active shift without enabling clock forwarding.',
    archive: 'Your history includes worked time, breaks and Zeitguru credits. Available daily accounting contributes to work overviews, overtime and days needing attention. Your active clock entries and connection are preserved.',
    records: 'Entries', worked: 'Recorded work time', credited: 'Credited in Zeitguru', hours: 'h', allArchive: 'Entire archive',
    unknown: 'Not provided', unknownCredits: 'entries have no reported Zeitguru credit and are excluded from the credited total.',
    range: 'Date range', latest: 'Import result', added: 'Added', duplicates: 'Already present', conflicts: 'Changed', skipped: 'Skipped',
    results: 'Unchanged entries are not duplicated. Existing archived entries that differ are preserved and are not overwritten.',
    warnings: 'Import notes', undo: 'Undo this import', undoTitle: 'Undo this import?',
    undoDetail: 'This import and its accounting contribution will be reversed if unchanged. Any previously imported accounting will be restored. Older data, active DCO clock entries and your Zeitguru connection are preserved. Nothing will be changed in Zeitguru.',
    undone: 'This import has been undone.', undoUnavailable: 'This import can no longer be undone without affecting changed data.',
    undoing: 'Undoing import …', cancel: 'Cancel', empty: 'No entries archived for this date range yet.',
    show: 'View and import history', loading: 'Loading history …', loadMore: 'Load more entries', loaded: 'entries displayed',
    start: 'Start', end: 'End', break: 'Break', approval: 'Zeitguru approval', approved: 'Approved', unapproved: 'Not approved',
    from: 'From', to: 'To', filter: 'Show date range', invalidRange: 'The end date cannot be before the start date.',
    retryLoad: 'Reload history', readOnly: 'This read-only account can view the archive but cannot change it.',
    failed: 'The Zeitguru history request failed. Your DCO clock remains available.',
  },
}

type DateFilter = { fromDate?: string; toDate?: string }

const warningCopy: Record<string, [string, string]> = {
  source_opening_missing: ['Ein Anfangssaldo ist nicht bestätigt. Frühere Überträge sind nicht im Gesamtstundenkonto nachgewiesen.', 'No opening balance is confirmed. Earlier carry is not established in an overall hours balance.'],
  source_opening_balance_not_configured: ['In Zeitguru ist kein Anfangssaldo hinterlegt.', 'Zeitguru has no configured opening balance.'],
  source_clock_conflict: ['Die Quellabrechnung und die importierten Stempelungen stimmen nicht überein. Bitte den Tag in Zeitguru prüfen.', 'Source accounting and imported clock entries do not match. Check this day in Zeitguru.'],
  native_source_overlap: ['Für diesen Tag liegen sowohl DCO-Stempelungen als auch Zeitguru-Quelldaten vor. Sie werden nicht doppelt gutgeschrieben.', 'This day has both DCO clock entries and Zeitguru source data. They are not credited twice.'],
  native_correction_overrides_source: ['Eine genehmigte DCO-Korrektur hat für die Abrechnung dieses Tages Vorrang. Die Zeitguru-Quelle bleibt erhalten.', 'An approved DCO correction takes precedence for this day’s accounting. The Zeitguru source is preserved.'],
  source_clock_unapproved: ['Zeitguru hat Stempelungen dieses Tages noch nicht freigegeben. Erfasste Arbeitszeit und Gutschrift können daher abweichen.', 'Zeitguru has not approved clock entries for this day. Recorded work and credited time may therefore differ.'],
  source_clock_approval_unknown: ['Der Zeitguru-Freigabestatus dieses Tages ist nicht bekannt.', 'The Zeitguru approval status for this day is unknown.'],
  source_clock_credit_unknown: ['Für Stempelungen dieses Tages fehlt eine eindeutige Zeitguru-Gutschrift.', 'Clock entries for this day have no unambiguous Zeitguru credit.'],
  source_automatic_clock_out: ['Zeitguru hat eine Schicht dieses Tages automatisch beendet. Bitte die Endzeit prüfen.', 'Zeitguru ended a shift on this day automatically. Check its end time.'],
  native_mirror_changed: ['Eine zu Zeitguru übertragene DCO-Stempelung wurde nachträglich geändert. Bitte beide Tagesaufzeichnungen prüfen.', 'A DCO clock entry sent to Zeitguru was subsequently changed. Check both daily records.'],
  open_entry: ['Noch offene Einträge wurden ausgelassen.', 'Entries that are still open were omitted.'],
  current_day: ['Einträge des heutigen Tages wurden ausgelassen.', 'Today’s entries were omitted.'],
  outside_range: ['Einträge außerhalb des Importzeitraums wurden ausgelassen.', 'Entries outside the import range were omitted.'],
  invalid_row: ['Einige Einträge konnten nicht zuverlässig gelesen werden.', 'Some entries could not be read reliably.'],
  missing_times: ['Bei einigen Einträgen fehlen Start- oder Endzeiten.', 'Some entries are missing start or end times.'],
  unsupported_time: ['Einige Zeitangaben konnten nicht eindeutig zugeordnet werden.', 'Some timestamps could not be interpreted unambiguously.'],
  invalid_break: ['Einige Pausenzeiten sind nicht eindeutig.', 'Some break times are ambiguous.'],
  missing_credit: ['Für einige Einträge fehlt die ausgewiesene Gutschrift.', 'Some entries have no reported credit.'],
  accepted_credit_missing: ['Für freigegebene Einträge fehlt teilweise die ausgewiesene Gutschrift.', 'Some approved entries have no reported credit.'],
  invalid_credit_data: ['Einige Gutschriften konnten nicht zuverlässig gelesen werden.', 'Some credits could not be read reliably.'],
  additional_credit_components: ['Einige Einträge enthalten zusätzliche Zeitguru-Gutschriftbestandteile. Ihre Gutschrift bleibt unbestimmt und ist nicht in der Gutschriftensumme enthalten.', 'Some entries contain additional Zeitguru credit components. Their credited amount remains unknown and is excluded from the credited total.'],
  credit_approval_mismatch: ['Gutschrift und Freigabestatus stimmen bei einigen Einträgen nicht überein.', 'Credit and approval status differ for some entries.'],
  credit_duration_mismatch: ['Die Zeitguru-Gutschrift weicht teilweise von der erfassten Arbeitszeit ab.', 'Some Zeitguru credits differ from the recorded work duration.'],
  wall_clock_duration_differs_from_elapsed: ['Bei einigen Einträgen weichen Uhrzeiten und verstrichene Dauer wegen einer Zeitumstellung voneinander ab.', 'For some entries, wall-clock times differ from elapsed duration because of a clock change.'],
  unaccepted: ['Einige Einträge sind in Zeitguru noch nicht freigegeben.', 'Some entries have not been approved in Zeitguru.'],
  duplicate_source: ['Wiederholte Einträge wurden nicht doppelt übernommen.', 'Repeated source entries were not imported twice.'],
  changed_or_overlapping_records: ['Geänderte oder überlappende Einträge wurden zum Schutz des vorhandenen Archivs nicht übernommen.', 'Changed or overlapping entries were not imported to preserve the existing archive.'],
  provider_error: ['Einige Angaben konnten nicht von Zeitguru gelesen werden.', 'Some information could not be read from Zeitguru.'],
  provider_omitted: ['Bei einigen Einträgen fehlen Angaben oder ist eine Prüfung in Zeitguru erforderlich.', 'Some entries have missing information or require checking in Zeitguru.'],
  invalid_history_date: ['Einige historische Datumsangaben konnten nicht gelesen werden.', 'Some historical dates could not be read.'],
  invalid_history_row: ['Einige historische Einträge konnten nicht zuverlässig gelesen werden.', 'Some historical entries could not be read reliably.'],
  ambiguous_daylight_saving_time: ['Einige Uhrzeiten sind wegen einer Zeitumstellung nicht eindeutig.', 'Some times are ambiguous because of a daylight-saving clock change.'],
  outside_history_range: ['Einträge außerhalb des historischen Zeitraums wurden ausgelassen.', 'Entries outside the historical date range were omitted.'],
  unfinished_clock_row: ['Noch nicht abgeschlossene Stempelungen wurden ausgelassen.', 'Clock entries that are not finished were omitted.'],
  credit_prefix_collision: ['Einige Gutschriften konnten nicht eindeutig einem Eintrag zugeordnet werden.', 'Some credits could not be matched unambiguously to an entry.'],
  unfinished_row_credit: ['Zeitguru weist für einen noch offenen Eintrag eine Gutschrift aus.', 'Zeitguru reports a credit for an entry that is still open.'],
  break_exceeds_shift_duration: ['Bei einigen Einträgen überschreitet die Pause die Schichtdauer.', 'For some entries, the break exceeds the shift duration.'],
  automatic_clock_out: ['Einige Schichten wurden in Zeitguru automatisch beendet.', 'Some shifts were ended automatically in Zeitguru.'],
  not_approved: ['Einige Einträge sind in Zeitguru nicht freigegeben.', 'Some entries are not approved in Zeitguru.'],
  approval_unknown: ['Bei einigen Einträgen ist der Freigabestatus nicht angegeben.', 'Some entries have no reported approval status.'],
  unattributed_credit_data: ['Weitere Zeitguru-Gutschriften konnten diesen Arbeitseinträgen nicht zugeordnet werden.', 'Additional Zeitguru credits could not be attributed to these work entries.'],
}

export function ZeitguruHistoryPanel({ api, language, challengeId, expectedGeneration, readOnly, onVerify, onCredentialConsumed }: {
  api: ZeitguruHistoryApi
  language: 'de' | 'en'
  challengeId?: string
  expectedGeneration: number
  readOnly?: boolean
  onVerify: () => void
  onCredentialConsumed: () => void
}) {
  const t = copy[language]
  const id = useId()
  const apiRef = useRef(api)
  apiRef.current = api
  const pendingRequestId = useRef<string | undefined>(undefined)
  const requestSequence = useRef(0)
  const mutationInFlight = useRef(false)
  const mounted = useRef(true)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ZeitguruHistoryPage>()
  const [status, setStatus] = useState<ZeitguruHistoryStatus>()
  const [resultBatch, setResultBatch] = useState<ZeitguruHistoryBatch>()
  const [confirmBatch, setConfirmBatch] = useState<ZeitguruHistoryBatch>()
  const [busy, setBusy] = useState<'load' | 'import' | 'undo'>()
  const [error, setError] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [filters, setFilters] = useState<DateFilter>({})

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadPage = useCallback(async (filter: DateFilter, cursor?: string, afterMutation = false) => {
    if (mutationInFlight.current && !afterMutation) return
    const sequence = ++requestSequence.current
    setBusy('load')
    setError('')
    try {
      const result = await apiRef.current.loadHistory({ ...filter, ...(cursor ? { cursor } : {}), limit: 20 })
      if (!mounted.current || requestSequence.current !== sequence) return
      setStatus(result.status)
      setPage((previous) => cursor && previous
        ? { ...result, rows: [...previous.rows, ...result.rows.filter((row) => !previous.rows.some((existing) => existing.id === row.id))] }
        : result)
    } catch (failure) {
      if (mounted.current && requestSequence.current === sequence) setError(failure instanceof Error ? failure.message : copy[language].failed)
    } finally {
      if (mounted.current && requestSequence.current === sequence) setBusy(undefined)
    }
  }, [language])

  useEffect(() => {
    if (open) void loadPage(filters)
  }, [open, filters, loadPage])

  useEffect(() => {
    if (!open || !status?.importing || mutationInFlight.current) return
    const timer = window.setTimeout(() => void loadPage(filters), 5000)
    return () => window.clearTimeout(timer)
  }, [open, status, filters, loadPage])

  async function importHistory() {
    if (busy || mutationInFlight.current || readOnly) return
    mutationInFlight.current = true
    const clientRequestId = pendingRequestId.current ?? crypto.randomUUID()
    pendingRequestId.current = clientRequestId
    setBusy('import')
    setError('')
    try {
      const result = await api.importHistory({ clientRequestId, expectedGeneration, ...(challengeId ? { challengeId } : {}) })
      if (!mounted.current) return
      pendingRequestId.current = undefined
      setStatus(result.status)
      setResultBatch(result.batch)
      setConfirmBatch(undefined)
      await loadPage(filters, undefined, true)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      onCredentialConsumed()
      mutationInFlight.current = false
      if (mounted.current) setBusy(undefined)
    }
  }

  async function undoHistory() {
    if (!confirmBatch || busy || mutationInFlight.current || readOnly) return
    mutationInFlight.current = true
    setBusy('undo')
    setError('')
    try {
      const result = await api.undoHistory({ batchId: confirmBatch.id, expectedFingerprint: confirmBatch.fingerprint })
      if (!mounted.current) return
      setStatus(result.status)
      setResultBatch(result.batch)
      setConfirmBatch(undefined)
      await loadPage(filters, undefined, true)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      mutationInFlight.current = false
      if (mounted.current) setBusy(undefined)
    }
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault()
    if (fromDate && toDate && fromDate > toDate) { setError(t.invalidRange); return }
    setFilters({ ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}) })
  }

  function dateLabel(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    return match ? language === 'de' ? `${match[3]}.${match[2]}.${match[1]}` : `${match[3]}/${match[2]}/${match[1]}` : value
  }

  function hours(minutes: number) {
    return `${new Intl.NumberFormat(language === 'de' ? 'de-DE' : 'en-GB', { maximumFractionDigits: 2 }).format(minutes / 60)} ${t.hours}`
  }

  const batch = resultBatch ?? status?.lastImport
  const hasAccess = Boolean(challengeId || status?.canImport || pendingRequestId.current)

  return (
    <details className="zeitguru-history-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t.show}</summary>
      {open && <section className="zeitguru-history-panel" aria-labelledby={`${id}-title`} aria-busy={Boolean(busy)}>
        <header className="zeitguru-history-heading"><h3 id={`${id}-title`}>{t.title}</h3><p className="muted">{t.intro}</p></header>
        <p className="zeitguru-history-note">{t.archive}</p>
        {!status?.canImport && !challengeId && <><p className="muted">{t.access}</p><button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly} onClick={onVerify}>{t.verify}</button></>}
        <button type="button" className="primary-button" disabled={Boolean(busy) || readOnly || !status || !hasAccess || status.importing} onClick={() => void importHistory()}>{busy === 'import' || status?.importing ? t.importing : t.import}</button>
        {readOnly && <p className="muted">{t.readOnly}</p>}
        {status && <>
          <p className="muted">{t.allArchive}</p>
          <dl className="zeitguru-history-totals"><div><dt>{t.records}</dt><dd>{status.totalRecords}</dd></div><div><dt>{t.worked}</dt><dd>{hours(status.totalWorkedMinutes)}</dd></div><div><dt>{t.credited}</dt><dd>{hours(status.totalCreditedMinutes)}</dd></div></dl>
          {status.uncreditedRecords > 0 && <p className="muted">{status.uncreditedRecords} {t.unknownCredits}</p>}
          {status.firstDate && status.lastDate && <p>{t.range}: {dateLabel(status.firstDate)} – {dateLabel(status.lastDate)}</p>}
        </>}
        {status?.accounting && <ZeitguruAccountingOverview context={status.accounting} language={language} fromDate={filters.fromDate} toDate={filters.toDate} />}
        {batch && <section className="zeitguru-history-batch" aria-labelledby={`${id}-batch`}>
          <h3 id={`${id}-batch`}>{t.latest} · {new Date(batch.createdAt).toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', { timeZone: organizationTimezone() })}</h3>
          <dl className="zeitguru-history-result"><div><dt>{t.added}</dt><dd>{batch.added}</dd></div><div><dt>{t.duplicates}</dt><dd>{batch.duplicates}</dd></div><div><dt>{t.conflicts}</dt><dd>{batch.conflicts}</dd></div><div><dt>{t.skipped}</dt><dd>{batch.skipped}</dd></div></dl>
          <p className="muted">{t.results}</p>
          {batch.warnings.length > 0 && <details><summary>{t.warnings}</summary><ul>{batch.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{(warningCopy[warning] ?? warningCopy.provider_omitted)[language === 'de' ? 0 : 1]}</li>)}</ul></details>}
          {batch.undone ? <p role="status">{t.undone}</p> : batch.canUndo ? <button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly} onClick={() => setConfirmBatch({ ...batch })}>{t.undo}</button> : batch.added > 0 ? <p className="muted">{t.undoUnavailable}</p> : null}
          {confirmBatch && <section className="zeitguru-history-confirm" aria-labelledby={`${id}-undo`}><strong id={`${id}-undo`}>{t.undoTitle}</strong><p>{t.undoDetail}</p><div className="zeitguru-history-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setConfirmBatch(undefined)}>{t.cancel}</button><button type="button" className="primary-button" disabled={Boolean(busy) || readOnly} onClick={() => void undoHistory()}>{busy === 'undo' ? t.undoing : t.undo}</button></div></section>}
        </section>}
        <form className="zeitguru-history-filter" onSubmit={applyFilters}>
          <label htmlFor={`${id}-from`}>{t.from}<input id={`${id}-from`} type="date" value={fromDate} disabled={Boolean(busy)} onChange={(event) => setFromDate(event.target.value)} /></label>
          <label htmlFor={`${id}-to`}>{t.to}<input id={`${id}-to`} type="date" value={toDate} disabled={Boolean(busy)} onChange={(event) => setToDate(event.target.value)} /></label>
          <button type="submit" className="secondary-button" disabled={Boolean(busy)}>{t.filter}</button>
        </form>
        {busy === 'load' && <p role="status">{t.loading}</p>}
        {page && <>
          {page.rows.length === 0 && busy !== 'load' && <p className="muted">{t.empty}</p>}
          <ol className="zeitguru-history-rows">{page.rows.map((row) => <li key={row.id} className="zeitguru-history-row">
            <header><strong>{dateLabel(row.date)}</strong>{row.branchName && <small>{row.branchName}</small>}</header>
            {status?.accounting?.days.find(day=>day.date===row.date)?.importClassification&&<p>{status.accounting.days.find(day=>day.date===row.date)?.absence?.typeName} · {language==='de'?'Importregel; Originalwerte unten':'Import classification; original values below'}</p>}
            <dl><div><dt>{t.start}</dt><dd><time dateTime={row.startedAt}>{row.startTime}</time></dd></div><div><dt>{t.end}</dt><dd><time dateTime={row.stoppedAt}>{row.endTime}</time></dd></div><div><dt>{t.break}</dt><dd>{row.breakMinutes} min</dd></div><div><dt>{t.worked}</dt><dd>{hours(row.workedMinutes)}</dd></div><div><dt>{t.credited}</dt><dd>{row.creditedMinutes === null ? t.unknown : hours(row.creditedMinutes)}</dd></div><div><dt>{t.approval}</dt><dd>{row.approved === null ? t.unknown : row.approved ? t.approved : t.unapproved}</dd></div></dl>
          </li>)}</ol>
          <div className="zeitguru-history-pagination"><small>{page.rows.length} {t.loaded}</small>{page.nextCursor && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadPage(filters, page.nextCursor)}>{t.loadMore}</button>}</div>
        </>}
        {error && <><p className="form-error" role="alert">{error}</p><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadPage(filters)}>{t.retryLoad}</button></>}
      </section>}
    </details>
  )
}

/** Read-only source ledger, also used when opening an immutable historical day issue. */
export function ZeitguruAccountingOverview({ context, language, fromDate, toDate }: {
  context: ZeitguruAccountingContext; language: 'de' | 'en'; fromDate?: string; toDate?: string
}) {
  const [limit, setLimit] = useState(20)
  const de = language === 'de'
  const label = (german: string, english: string) => de ? german : english
  const hours = (minutes: number) => `${new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 2 }).format(minutes / 60)} ${de ? 'Std.' : 'h'}`
  const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(de ? 'de-DE' : 'en-GB', { timeZone: 'UTC' })
  const days = context.days.filter(day => (!fromDate || day.date >= fromDate) && (!toDate || day.date <= toDate)).sort((a, b) => b.date.localeCompare(a.date))
  const totals = days.reduce((sum, day) => ({ expected: sum.expected + day.expectedMinutes, credited: sum.credited + day.creditedMinutes, delta: sum.delta + day.exactDeltaMinutes }), { expected: 0, credited: 0, delta: 0 })
  const warnings = context.warnings.filter(warning => (!fromDate || warning.date >= fromDate) && (!toDate || warning.date <= toDate))
  const reviewDates = new Set(warnings.map(warning => warning.date))
  const reconstruction=context.initialImportReconstruction
  const proposals=reconstruction?.days.filter(day=>(!fromDate||day.date>=fromDate)&&(!toDate||day.date<=toDate))??[]
  return <section className="zeitguru-history-panel zeitguru-accounting" aria-label={label('Zeitguru-Tagesabrechnung', 'Zeitguru daily accounting')}>
    <h3>{label('Tagesabrechnung und Überstunden', 'Daily accounting and overtime')}</h3>
    <p>{label('Importierter Abrechnungszeitraum', 'Imported accounting period')}: {date(context.fromDate)} – {date(context.toDate)}</p>
    {reconstruction&&<p className="zeitguru-history-note">{label(`Erstimport bis ${date(reconstruction.throughDate)}: Historische Arbeitszeitprüfungen stehen separat unter „Importvorschläge / Information & Verlauf“. Keine automatische Änderung der Zeiten oder Gutschriften.`, `Initial import through ${date(reconstruction.throughDate)}: historical work-time checks appear separately under “Import proposals / Information & history”. Times and credits have not been automatically changed.`)}</p>}
    {proposals.length>0&&<details className="zeitguru-import-reconstruction"><summary>{label('Rekonstruktionsvorschläge – noch nicht automatisch angewendet','Reconstruction proposals — not automatically applied')} ({proposals.length})</summary>
      <p>{label('Geschätzte Tage, Uhrzeiten und Pausen mit der tatsächlich geleisteten Arbeit vergleichen. Alle verknüpften Korrekturen prüfen. Vorschläge und Originale bleiben unterscheidbar.','Compare estimated dates, times and breaks with the actual work. Review all linked corrections. Proposals remain separate from original records.')}</p>
      <ul>{proposals.slice(0,limit).map(day=><li key={day.date}><strong>{date(day.date)}</strong>: {day.originalStart??'—'}–{day.originalEnd??'—'} ({hours(day.originalMinutes)}) → {day.proposedStart}–{day.proposedEnd} ({hours(day.proposedMinutes)}; {label('Pause','break')}: {day.proposedBreakMinutes} min).
        {' '}{reconstruction!.transfers.filter(transfer=>transfer.fromDate===day.date||transfer.toDate===day.date).map(transfer=>`${date(transfer.fromDate)} → ${date(transfer.toDate)}: ${transfer.minutes} min`).join('; ')}
        {reconstruction!.unallocated.filter(item=>item.date===day.date).map(item=><span key={item.date}> {label('Nicht verteilt','Unallocated')}: {item.minutes} min.</span>)}
        {' '}{day.status==='applied'?label('Genehmigte Korrektur entspricht dem Vorschlag.','Approved correction matches this proposal.'):day.status==='changed'?label('In DCO inzwischen geändert – manuell vergleichen.','Changed in DCO since import — compare manually.'):label('Vorschlag; noch nicht angewendet.','Proposal; not applied.')}
      </li>)}</ul>{proposals.length>limit&&<button className="secondary-button" type="button" onClick={()=>setLimit(value=>value+20)}>{label('Weitere Vorschläge','More proposals')}</button>}
    </details>}
    <p className="zeitguru-history-note">{context.openingKnown
      ? label(`Bestätigter Anfangssaldo am ${date(context.fromDate)}: ${hours(context.openingBalanceMinutes)}.`, `Confirmed opening balance on ${date(context.fromDate)}: ${hours(context.openingBalanceMinutes)}.`)
      : label('In Zeitguru ist kein Anfangssaldo hinterlegt. Die Überstunden zeigen die Veränderung im ausgewählten Zeitraum. Ein Gesamtstundenkonto oder früherer Übertrag ist damit nicht bestätigt.', 'Zeitguru has no configured opening balance. Overtime shows the change in the selected period. This does not establish an overall hours balance or earlier carry.')}</p>
    <p className="muted">{label('Tagessoll, Abwesenheiten, Feiertagsgutschriften und Korrekturen stammen aus der Zeitguru-Abrechnung. Sie ändern keine DCO-Urlaubsansprüche oder Beschäftigungsbedingungen; ein historischer Urlaubsanspruch wird daraus nicht abgeleitet.', 'Daily targets, absences, holiday credits and corrections come from Zeitguru accounting. They do not change DCO leave allowances or employment terms; historical leave entitlement is not inferred.')}</p>
    <dl className="zeitguru-history-totals"><div><dt>{label('Tagessoll im Zeitraum', 'Expected time in period')}</dt><dd>{hours(totals.expected)}</dd></div><div><dt>{label('Gesamte Gutschriften', 'All credits')}</dt><dd>{hours(totals.credited)}</dd></div><div><dt>{label('Überstunden im Zeitraum', 'Overtime for period')}</dt><dd>{hours(totals.delta)}</dd></div></dl>
    <p role="status">{reviewDates.size} {label('Tage mit Quellhinweisen im Zeitraum. Weitere Daten- und Pausenprüfungen findest du unter „Tage mit Klärungsbedarf“.', 'days with source notes in this period. Further data and break checks appear under “Days needing attention”.')}</p>
    {warnings.length > 0 && <details><summary>{label('Quellhinweise prüfen', 'Review source notes')} ({warnings.length})</summary><ul>{warnings.slice(0, limit).map((warning, index) => <li key={`${warning.date}-${warning.code}-${index}`}><strong>{date(warning.date)}</strong>: {(warningCopy[warning.code] ?? warningCopy.provider_omitted)[de ? 0 : 1]}</li>)}</ul>{warnings.length > limit && <button className="secondary-button" type="button" onClick={() => setLimit(value => value + 20)}>{label('Weitere Hinweise anzeigen', 'Show more notes')}</button>}</details>}
    <details open={Boolean(fromDate && fromDate === toDate)}><summary>{label('Tageswerte prüfen', 'Review daily values')} ({days.length})</summary>
      {days.length === 0 && <p className="muted">{label('Für diese Auswahl liegt keine Tagesabrechnung vor.', 'No daily accounting is available for this selection.')}</p>}
      <ol className="zeitguru-history-rows">{days.slice(0, limit).map(day => <li key={day.date} className="zeitguru-history-row">
        <header><strong>{date(day.date)}</strong><small>{label('Zeitguru · schreibgeschützt', 'Zeitguru · read-only')}</small></header>
        {day.absence && <p>{label('Abwesenheit', 'Absence')}: {day.absence.typeName}</p>}
        {day.approvedAutomaticClockOut && <p className="zeitguru-history-note">{label('Automatisches Ausstempeln in Zeitguru freigegeben. Dafür ist keine Korrektur erforderlich.', 'Automatic clock-out approved in Zeitguru. No correction is required for this.')}</p>}
        {day.importClassification&&<p className="zeitguru-history-note">{label('Als Abwesenheit eingeordnet: acht importierte Stunden ohne Pause. Das Original bleibt im Archiv erhalten; die Gutschrift bleibt unverändert.','Classified as absence: eight imported hours with no break. The original remains in the archive and its credit is unchanged.')}</p>}
        {day.localAbsenceApplied&&<p className="zeitguru-history-note">{label('Genehmigter DCO-Urlaub: Die Abwesenheitsgutschrift ergänzt das importierte Konto. Der Zeitguru-Originaldatensatz bleibt unverändert.','Approved DCO vacation: absence credit supplements the imported account. The original Zeitguru record is unchanged.')}</p>}
        <dl>{[
          ...(day.actualWorkedMinutes !== undefined ? [[label('Erfasste Arbeitszeit', 'Recorded work'), day.actualWorkedMinutes]] : []),
          ...(day.actualBreakMinutes !== undefined ? [[label('Erfasste Pause', 'Recorded break'), day.actualBreakMinutes]] : []),
          [label('Gutgeschriebene Arbeitszeit', 'Credited work'), day.workedMinutes], [label('Tagessoll', 'Expected time'), day.expectedMinutes],
          [label('Gutschriften gesamt', 'Total credits'), day.creditedMinutes], [label('Abwesenheitsgutschrift', 'Absence credit'), day.absenceMinutes],
          [label('Feiertagsgutschrift', 'Holiday credit'), day.holidayMinutes], [label('Korrektur', 'Correction'), day.correctionMinutes],
          [label('Überstunden am Tag', 'Daily overtime'), day.exactDeltaMinutes],
        ].map(([name, value]) => <div key={String(name)}><dt>{name}</dt><dd>{hours(Number(value))}</dd></div>)}</dl>
        {warnings.filter(warning => warning.date === day.date).length > 0 && <p className="muted">{label('Dieser Tag benötigt eine Prüfung der Quelldaten. Die erhaltenen Werte bleiben unverändert.', 'This day needs a review of the source data. The preserved values remain unchanged.')}</p>}
      </li>)}</ol>
      {days.length > limit && <button className="secondary-button" type="button" onClick={() => setLimit(value => value + 20)}>{label('Weitere Tage anzeigen', 'Show more days')}</button>}
    </details>
    <a href="https://web.zeitguru.de" target="_blank" rel="noopener noreferrer">{label('In Zeitguru prüfen', 'Check in Zeitguru')}</a>
  </section>
}

