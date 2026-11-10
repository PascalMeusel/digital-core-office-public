import { PasswordInput } from '@digital-core-office/suite-ui'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ZeitguruApi, ZeitguruLoginChallenge, ZeitguruStatus } from '../shared/zeitguru.ts'
import { organizationTimezone } from '../shared/dates.ts'
import { ZeitguruHistoryPanel } from './ZeitguruHistoryPanel.tsx'
import './ZeitguruPanel.css'

const copy = {
  de: {
    evaluation: 'Unternehmenserprobung', manage: 'Verbindung verwalten', disconnected: 'Nicht verbunden',
    disconnectedSummary: 'Nicht verbunden · Stempelungen nur in DCO',
    disconnectedDetail: 'Neue Arbeits- und Pausenaktionen werden nur in DCO gespeichert und nicht an Zeitguru übertragen.',
    unresolved: 'Frühere Stempelaktionen prüfen', syncFailed: 'Zeitguru-Abgleich nicht möglich',
    connected: 'Verbunden', connect: 'Zeitguru verbinden', verify: 'Zugang prüfen', verifying: 'Zugang wird geprüft …',
    email: 'Zeitguru-E-Mail', password: 'Zeitguru-Passwort', verified: 'Geprüftes Zeitguru-Konto', branch: 'Standort',
    chooseBranch: 'Standort auswählen', consent: 'Meine neuen Stempelaktionen für Arbeitsbeginn, Pausenbeginn, Pausenende und Arbeitsende an Zeitguru übertragen.',
    scope: 'Nur neue Arbeits- und Pausenaktionen. Frühere Zeiten, Korrekturen, Urlaub und andere Abwesenheiten werden nicht übertragen.',
    credentials: 'Dein Passwort wird nur zur Anmeldung verwendet. Erst beim Aktivieren der Stempelübertragung speichert dieser Unternehmensserver die Sitzung verschlüsselt. Ein nur für den Verlauf geprüfter Zugang wird nach Verwendung oder Ablauf verworfen.',
    historyReady: 'Dein Zugang ist geprüft. Du kannst deinen Verlauf unten importieren, ohne die Stempelübertragung zu aktivieren.',
    activation: 'Du kannst dich während einer Zeitguru-Schicht verbinden. Erfasster Beginn und Pausen werden in DCO übernommen. Eine separate oder korrigierte DCO-Schicht muss zuvor geprüft werden.',
    remoteState: 'Zeitguru bei der Zugangsprüfung', localState: 'DCO aktuell',
    clockStates: { off_work: 'Ausgestempelt', working: 'Arbeitszeit läuft', on_break: 'Pause läuft' },
    remoteWorking: 'In Zeitguru läuft noch eine Schicht. Prüfe sie in Zeitguru und beende sie dort korrekt, bevor du eine neue Verbindung aktivierst. Prüfe danach den Zugang erneut.',
    remoteBreak: 'In Zeitguru läuft noch eine Pause innerhalb einer offenen Schicht. Prüfe die Pause und Schicht in Zeitguru und beende die Schicht dort korrekt. Prüfe danach den Zugang erneut.',
    localRunning: 'In DCO läuft noch eine Schicht. Beende sie über die DCO-Stempeluhr, bevor du eine neue Verbindung aktivierst, und prüfe danach den Zeitguru-Zugang erneut.',
    noBranch: 'Zeitguru liefert keinen für dein Konto zum Stempeln freigegebenen Standort. Bitte deine Zeitguru-Administration, deine Standortzuordnung und die Browser-Stempelfreigabe zu prüfen. Prüfe danach den Zugang erneut.',
    recheckActivation: 'Die Zugangsprüfung erlaubt die Aktivierung noch nicht. Der Status kann sich inzwischen geändert haben. Prüfe deinen Zugang erneut, um den aktuellen Stand zu prüfen.',
    connectionChanged: 'Die Verbindung wurde seit der Zugangsprüfung geändert. Bitte prüfe deinen Zugang erneut.',
    chooseBeforeConnect: 'Wähle einen Standort, um die Verbindung zu aktivieren.',
    consentBeforeConnect: 'Bestätige die Übertragung deiner neuen Stempelaktionen, um die Verbindung zu aktivieren.',
    expired: 'Die Prüfung ist abgelaufen. Bitte prüfe deinen Zugang erneut.', recheck: 'Zugang erneut prüfen',
    pending: 'In DCO gespeichert · Übertragung ausstehend', sending: 'In DCO gespeichert · Übertragung läuft',
    delivered: 'Von Zeitguru bestätigt', ready: 'Bereit für neue Stempelaktionen', cancelled: 'Übertragung beendet',
    attention: 'In DCO gespeichert · Zeitguru prüfen', attentionDetail: 'Die Übertragung ist nicht bestätigt. Prüfe deine Zeiten in Zeitguru; eine erneute Übertragung könnte doppelte Buchungen erzeugen.',
    auth: 'Zeitguru-Anmeldung erforderlich', authDetail: 'Prüfe deine Zeiten in Zeitguru und melde dich für die bestehende Verbindung erneut an.',
    check: 'Übertragungsstatus prüfen', checking: 'Status wird geprüft …', noReplay: 'Die Statusprüfung sendet die Stempelaktion nicht erneut.',
    queued: 'ausstehend', needsCheck: 'zu prüfen', disconnect: 'Verbindung trennen', disconnectTitle: 'Zeitguru-Verbindung trennen?',
    disconnectDetail: 'Die gespeicherten Zugangsdaten werden gelöscht und weitere Übertragungen gestoppt. Bereits übertragene Zeiten bleiben in Zeitguru. Prüfe dort offene Schichten und unbestätigte Aktionen.',
    cancel: 'Abbrechen', saving: 'Wird gespeichert …', failed: 'Die Zeitguru-Anfrage ist fehlgeschlagen. Deine DCO-Stempeluhr bleibt verfügbar.',
    readOnly: 'In diesem schreibgeschützten Konto kann die Verbindung nicht geändert werden.',
    openZeitguru: 'Zeitguru öffnen (neuer Tab)', review: 'Manuelle Prüfung bestätigen', reviewTitle: 'Ausstehende Zeiten manuell geprüft?',
    reviewDetail: 'Prüfe alle ausstehenden Stempelaktionen in Zeitguru und beende dort eine laufende Schicht. Die Bestätigung entfernt diese Aktionen aus der Übertragungswarteschlange. DCO ändert dabei keine Zeitguru-Buchungen und sendet die Aktionen nicht erneut.',
    reviewed: 'Ich habe die ausstehenden Zeiten in Zeitguru geprüft und bin dort ausgestempelt.',
    reviewClockOut: 'Stemple dich auch in DCO aus, bevor du die manuelle Prüfung bestätigst.',
    lastAction: 'Letzte Aktion', actions: { start_work: 'Arbeitsbeginn', start_break: 'Pausenbeginn', stop_break: 'Pausenende', stop_work: 'Arbeitsende' },
  },
  en: {
    evaluation: 'Company evaluation', manage: 'Manage connection', disconnected: 'Not connected',
    disconnectedSummary: 'Not connected · Clock actions saved only in DCO',
    disconnectedDetail: 'New work and break actions are saved only in DCO and are not sent to Zeitguru.',
    unresolved: 'Earlier clock actions need checking', syncFailed: 'Zeitguru synchronization unavailable',
    connected: 'Connected', connect: 'Connect Zeitguru', verify: 'Verify credentials', verifying: 'Verifying credentials …',
    email: 'Zeitguru email', password: 'Zeitguru password', verified: 'Verified Zeitguru account', branch: 'Branch',
    chooseBranch: 'Choose a branch', consent: 'Send my new clock-in, break-start, break-end and clock-out actions to Zeitguru.',
    scope: 'New work and break actions only. Earlier times, corrections, leave and other absences are not sent.',
    credentials: 'Your password is used only to sign in. This company server stores the session encrypted only when you activate clock forwarding. Access verified only for history is discarded after use or expiry.',
    historyReady: 'Your access is verified. You can import your history below without activating clock forwarding.',
    activation: 'You can connect during a Zeitguru shift. Its recorded start and breaks will be adopted in DCO. A separate or corrected DCO shift requires review first.',
    remoteState: 'Zeitguru when access was verified', localState: 'DCO now',
    clockStates: { off_work: 'Clocked out', working: 'Work running', on_break: 'Break running' },
    remoteWorking: 'A shift is still running in Zeitguru. Check it in Zeitguru and end it correctly there before activating a new connection. Then verify your access again.',
    remoteBreak: 'A break is still running within an open Zeitguru shift. Check the break and shift in Zeitguru and end the shift correctly there. Then verify your access again.',
    localRunning: 'A shift is still running in DCO. End it using the DCO clock before activating a new connection, then verify your Zeitguru access again.',
    noBranch: 'Zeitguru returned no branch where your account is allowed to clock in. Ask your Zeitguru administrator to check your branch assignment and browser-clocking permission, then verify your access again.',
    recheckActivation: 'The access check does not allow activation yet. The status may have changed since then. Verify your access again to check the current state.',
    connectionChanged: 'The connection changed after access was verified. Please verify your access again.',
    chooseBeforeConnect: 'Choose a branch to activate the connection.',
    consentBeforeConnect: 'Confirm forwarding of your new clock actions to activate the connection.',
    expired: 'Verification expired. Please verify your credentials again.', recheck: 'Verify credentials again',
    pending: 'Saved in DCO · Delivery pending', sending: 'Saved in DCO · Delivery in progress',
    delivered: 'Confirmed by Zeitguru', ready: 'Ready for new clock actions', cancelled: 'Delivery stopped',
    attention: 'Saved in DCO · Check Zeitguru', attentionDetail: 'Delivery is not confirmed. Check your times in Zeitguru; sending again could create duplicate entries.',
    auth: 'Zeitguru sign-in required', authDetail: 'Check your times in Zeitguru and sign in again for the existing connection.',
    check: 'Check delivery status', checking: 'Checking status …', noReplay: 'Checking the status does not resend the clock action.',
    queued: 'pending', needsCheck: 'need checking', disconnect: 'Disconnect', disconnectTitle: 'Disconnect Zeitguru?',
    disconnectDetail: 'Stored credentials will be deleted and further deliveries stopped. Times already sent remain in Zeitguru. Check open shifts and unconfirmed actions there.',
    cancel: 'Cancel', saving: 'Saving …', failed: 'The Zeitguru request failed. Your DCO clock remains available.',
    readOnly: 'This read-only account cannot change the connection.',
    openZeitguru: 'Open Zeitguru (new tab)', review: 'Confirm manual review', reviewTitle: 'Have you checked the pending times manually?',
    reviewDetail: 'Check every pending clock action in Zeitguru and finish any active shift there. Confirming removes these actions from the delivery queue. DCO does not change Zeitguru records or resend the actions.',
    reviewed: 'I have checked the pending times in Zeitguru and am clocked out there.',
    reviewClockOut: 'Also clock out in DCO before confirming the manual review.',
    lastAction: 'Last action', actions: { start_work: 'Clock-in', start_break: 'Break start', stop_break: 'Break end', stop_work: 'Clock-out' },
  },
}

export function ZeitguruPanel({ status, language, clockStatus, readOnly, api }: {
  status: ZeitguruStatus
  language: 'de' | 'en'
  clockStatus: 'off_work' | 'working' | 'on_break'
  readOnly?: boolean
  api: ZeitguruApi
}) {
  const t = copy[language]
  const id = useId()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState<ZeitguruLoginChallenge>()
  const [challengeGeneration, setChallengeGeneration] = useState<number>()
  const [branchId, setBranchId] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState<'login' | 'connect' | 'disconnect' | 'reconcile' | 'review' | 'sync'>()
  const [error, setError] = useState('')
  const [syncFailure, setSyncFailure] = useState<{ generation: number; message: string }>()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnectGeneration, setDisconnectGeneration] = useState<number>()
  const [confirmReview, setConfirmReview] = useState(false)
  const [historyVerifyRequested, setHistoryVerifyRequested] = useState(false)
  const [reviewSnapshot, setReviewSnapshot] = useState<{ generation: number; clockRevision: number }>()
  const [reviewed, setReviewed] = useState(false)
  const [, refreshExpiry] = useState(0)
  useEffect(() => {
    if (!challenge) return
    const timer = window.setTimeout(() => refreshExpiry((value) => value + 1), Math.max(0, challenge.expiresAt - Date.now()) + 1)
    return () => window.clearTimeout(timer)
  }, [challenge])
  const syncApi = useRef(api.synchronize)
  syncApi.current = api.synchronize
  useEffect(() => {
    if (!status.enabled || readOnly) return
    let active = true, running = false
    const check = async () => {
      if (running || document.hidden || !syncApi.current) return
      running = true
      try { await syncApi.current(); if (active) setSyncFailure(undefined) }
      catch (failure) { if (active) setSyncFailure({ generation: status.generation, message: failure instanceof Error ? failure.message : t.syncFailed }) }
      finally { running = false }
    }
    void check()
    const interval = window.setInterval(() => void check(), 30_000)
    document.addEventListener('visibilitychange', check)
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', check) }
  }, [status.enabled, status.generation, readOnly, t.syncFailed])
  const pending = status.counts.queued + status.counts.sending
  const attentionCount = status.counts.retryable_failure + status.counts.reconciliation_required + status.counts.authentication_required
  const latest = status.latestOperation
  const attentionOperation = status.attentionOperation ?? latest
  const needsAuthentication = status.counts.authentication_required > 0
  const journalNeedsAttention = status.requiresAttention || attentionCount > 0
  const synchronizationError = status.enabled
    ? (syncFailure?.generation === status.generation ? syncFailure.message : status.synchronization?.error)
    : undefined
  const needsAttention = journalNeedsAttention || Boolean(synchronizationError)
  const challengeValid = challenge && challengeGeneration === status.generation && challenge.expiresAt > Date.now()
  const canActivate = Boolean(challengeValid && challenge.canActivate && branchId && consent)
  const challengeProblem = challenge && (challengeGeneration !== status.generation ? t.connectionChanged : challenge.expiresAt <= Date.now() ? t.expired : undefined)
  const activationProblems: string[] = []
  if (challengeProblem) activationProblems.push(challengeProblem)
  else if (challenge) {
    if (challenge.branches.length === 0) activationProblems.push(t.noBranch)
    if (!challenge.canActivate) {
      if (challenge.remoteStatus === 'working') activationProblems.push(t.remoteWorking)
      if (challenge.remoteStatus === 'on_break') activationProblems.push(t.remoteBreak)
      if (clockStatus !== 'off_work') activationProblems.push(t.localRunning)
      if (activationProblems.length === 0) activationProblems.push(t.recheckActivation)
    }
  }
  const statusText = !status.enabled ? `${t.disconnectedSummary}${journalNeedsAttention ? ` · ${t.unresolved}` : ''}` : needsAuthentication ? t.auth : journalNeedsAttention ? t.attention : synchronizationError ? t.syncFailed : status.counts.sending ? t.sending : pending ? t.pending
    : latest?.status === 'confirmed' ? t.delivered : t.ready
  const canCheck = status.enabled && attentionOperation && ['retryable_failure', 'reconciliation_required', 'authentication_required', 'sending'].includes(attentionOperation.status)

  function clearChallenge() {
    setPassword('')
    setChallenge(undefined)
    setChallengeGeneration(undefined)
    setBranchId('')
    setConsent(false)
  }

  async function verify(event: FormEvent) {
    event.preventDefault()
    if (busy || readOnly) return
    const credentials = { email: email.trim(), password }
    clearChallenge()
    setError('')
    setBusy('login')
    try {
      const result = await api.login(credentials)
      setChallenge(result)
      setChallengeGeneration(status.generation)
      setBranchId(result.branches.length === 1 ? result.branches[0].id : '')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      credentials.password = ''
      setBusy(undefined)
    }
  }

  async function connect(event: FormEvent) {
    event.preventDefault()
    if (!canActivate || !challenge || busy || readOnly) return
    if (challenge.expiresAt <= Date.now()) { setError(t.expired); return }
    setError('')
    setBusy('connect')
    try {
      await api.connect({ challengeId: challenge.challengeId, branchId, consent: true, expectedGeneration: status.generation })
      clearChallenge()
      setEmail('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      setBusy(undefined)
    }
  }

  async function disconnect() {
    if (busy || readOnly || disconnectGeneration === undefined) return
    setError('')
    setBusy('disconnect')
    try {
      await api.disconnect({ expectedGeneration: disconnectGeneration })
      clearChallenge()
      setConfirmDisconnect(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      setBusy(undefined)
    }
  }

  async function reconcile() {
    if (!status.enabled || !attentionOperation || busy || readOnly) return
    setError('')
    setBusy('reconcile')
    try {
      await api.reconcile({ operationId: attentionOperation.id })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      setBusy(undefined)
    }
  }

  async function acknowledgeReview() {
    if (!status.enabled || !reviewed || busy || readOnly || clockStatus !== 'off_work' || !reviewSnapshot) return
    if (reviewSnapshot.generation !== status.generation || reviewSnapshot.clockRevision !== status.clockRevision) {
      setConfirmReview(false)
      setReviewed(false)
      return
    }
    setError('')
    setBusy('review')
    try {
      await api.acknowledgeReview({ expectedGeneration: reviewSnapshot.generation, reviewed: true })
      setConfirmReview(false)
      setReviewed(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <details className="zeitguru-panel" onToggle={(event) => {
      if (!event.currentTarget.open) { clearChallenge(); setConfirmDisconnect(false); setConfirmReview(false); setReviewed(false); setError('') }
    }}>
      <summary>
        <span className="zeitguru-heading"><strong>Zeitguru</strong><small>{t.evaluation}</small></span>
        <span className={needsAttention ? 'zeitguru-status attention' : 'zeitguru-status'} role="status">{statusText}</span>
        <span className="zeitguru-manage">{t.manage}</span>
      </summary>
      <div className="zeitguru-content" aria-busy={Boolean(busy)}>
        <p className="muted">{t.scope}</p>
        <p>{status.enabled ? t.connected : t.disconnected}</p>
        {!status.enabled && <p>{t.disconnectedDetail}</p>}
        {status.enabled && api.synchronize && <div className="zeitguru-actions"><button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly || status.counts.sending > 0 || (pending > 0 && !status.requiresAttention)} onClick={async () => { setBusy('sync'); try { await api.synchronize!(); setSyncFailure((current) => current?.generation === status.generation ? undefined : current) } catch (failure) { setSyncFailure({ generation: status.generation, message: failure instanceof Error ? failure.message : t.syncFailed }) } finally { setBusy(undefined) } }}>{language === 'de' ? 'Jetzt mit Zeitguru abgleichen' : 'Sync with Zeitguru now'}</button><small>{language === 'de' ? 'Direkt in Zeitguru erfasste Stempelungen werden während der Nutzung regelmäßig übernommen.' : 'Clock actions recorded directly in Zeitguru are checked regularly while this clock is open.'}</small></div>}
        {synchronizationError && <p className="zeitguru-attention" role="alert">{synchronizationError}</p>}
        {status.identity && <p className="zeitguru-identity"><strong>{status.identity.name}</strong><span>{status.identity.email}</span><span>{status.identity.branchName}</span></p>}
        {latest && <p className="zeitguru-last-action">{t.lastAction}: {t.actions[latest.action]} · {new Date(latest.acknowledgement?.confirmedAt ?? latest.updatedAt).toLocaleString(language === 'de' ? 'de-DE' : 'en-GB', { timeZone: organizationTimezone() })}</p>}
        {(pending > 0 || attentionCount > 0) && <p>{pending} {t.queued} · {attentionCount} {t.needsCheck}</p>}
        {journalNeedsAttention && <p className="zeitguru-attention" role="status">{status.enabled && needsAuthentication ? t.authDetail : t.attentionDetail}</p>}
        {journalNeedsAttention && <a href="https://web.zeitguru.de" target="_blank" rel="noopener noreferrer">{t.openZeitguru}</a>}
        {status.message && <p className="muted">{status.message}</p>}
        {canCheck && <div className="zeitguru-actions"><button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly} onClick={() => void reconcile()}>{busy === 'reconcile' ? t.checking : t.check}</button><small>{t.noReplay}</small></div>}
        {status.enabled && status.requiresAttention && clockStatus !== 'off_work' && <p className="muted">{t.reviewClockOut}</p>}
        {status.enabled && status.requiresAttention && clockStatus === 'off_work' && !confirmReview && <button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly} onClick={() => { setConfirmReview(true); setReviewed(false); setReviewSnapshot({ generation: status.generation, clockRevision: status.clockRevision }) }}>{t.review}</button>}
        {status.enabled && status.requiresAttention && clockStatus === 'off_work' && confirmReview && <section className="zeitguru-disconnect" aria-labelledby={`${id}-review`}>
          <strong id={`${id}-review`}>{t.reviewTitle}</strong><p>{t.reviewDetail}</p>
          <label className="zeitguru-consent" htmlFor={`${id}-reviewed`}><input id={`${id}-reviewed`} type="checkbox" checked={reviewed} disabled={Boolean(busy) || readOnly} onChange={(event) => setReviewed(event.target.checked)} /><span>{t.reviewed}</span></label>
          <div className="zeitguru-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => { setConfirmReview(false); setReviewed(false) }}>{t.cancel}</button><button type="button" className="primary-button" disabled={!reviewed || Boolean(busy) || readOnly} onClick={() => void acknowledgeReview()}>{busy === 'review' ? t.saving : t.review}</button></div>
        </section>}
        {readOnly && <p className="muted">{t.readOnly}</p>}
        {(!status.enabled || needsAuthentication || historyVerifyRequested) && <>
          {!challenge ? <form onSubmit={verify} className="zeitguru-form">
            <p className="muted">{t.credentials}</p>
            <label htmlFor={`${id}-email`}>{t.email}</label>
            <input id={`${id}-email`} type="email" autoComplete="section-zeitguru username" value={email} required disabled={Boolean(busy) || readOnly} onChange={(event) => setEmail(event.target.value)} />
            <label htmlFor={`${id}-password`}>{t.password}</label>
            <PasswordInput language={language} id={`${id}-password`} autoComplete="section-zeitguru current-password" value={password} required disabled={Boolean(busy) || readOnly} onChange={(event) => setPassword(event.target.value)} />
            <button type="submit" className="secondary-button" disabled={Boolean(busy) || readOnly || !email.trim() || !password}>{busy === 'login' ? t.verifying : t.verify}</button>
          </form> : <form onSubmit={connect} className="zeitguru-form">
            <p className="zeitguru-identity"><span>{t.verified}</span><strong>{challenge.identity.name}</strong><span>{challenge.identity.email}</span></p>
            <p className="zeitguru-identity" role="status">
              <span>{t.remoteState}: <strong>{t.clockStates[challenge.remoteStatus]}</strong></span>
              <span>{t.localState}: <strong>{t.clockStates[clockStatus]}</strong></span>
            </p>
            {historyVerifyRequested ? <>
              {challengeValid && <p className="muted">{t.historyReady}</p>}
              {challengeProblem && <p className="zeitguru-attention" role="status">{challengeProblem}</p>}
              <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={clearChallenge}>{t.recheck}</button>
            </> : <>
            <label htmlFor={`${id}-branch`}>{t.branch}</label>
            <select id={`${id}-branch`} value={branchId} required disabled={Boolean(busy) || readOnly} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">{t.chooseBranch}</option>
              {challenge.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
            <p className="muted">{t.activation}</p>
            {activationProblems.map((problem) => <p key={problem} className="zeitguru-attention" role="status">{problem}</p>)}
            {!challengeProblem && !challenge.canActivate && challenge.remoteStatus !== 'off_work' && <a href="https://web.zeitguru.de" target="_blank" rel="noopener noreferrer">{t.openZeitguru}</a>}
            <label className="zeitguru-consent" htmlFor={`${id}-consent`}><input id={`${id}-consent`} type="checkbox" checked={consent} disabled={Boolean(busy) || readOnly} onChange={(event) => setConsent(event.target.checked)} /><span>{t.consent}</span></label>
            {activationProblems.length === 0 && (!branchId || !consent) && <p className="muted">{branchId ? t.consentBeforeConnect : t.chooseBeforeConnect}</p>}
            <div className="zeitguru-actions"><button type="submit" className="primary-button" disabled={!canActivate || Boolean(busy) || readOnly}>{busy === 'connect' ? t.saving : t.connect}</button><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={clearChallenge}>{t.recheck}</button></div>
            </>}
          </form>}
        </>}
        {status.enabled && !confirmDisconnect && <button type="button" className="secondary-button" disabled={Boolean(busy) || readOnly} onClick={() => { setConfirmDisconnect(true); setDisconnectGeneration(status.generation) }}>{t.disconnect}</button>}
        {confirmDisconnect && <section className="zeitguru-disconnect" aria-labelledby={`${id}-disconnect`}>
          <strong id={`${id}-disconnect`}>{t.disconnectTitle}</strong><p>{t.disconnectDetail}</p>
          <div className="zeitguru-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(false)}>{t.cancel}</button><button type="button" className="primary-button" disabled={Boolean(busy) || readOnly} onClick={() => void disconnect()}>{busy === 'disconnect' ? t.saving : t.disconnect}</button></div>
        </section>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <ZeitguruHistoryPanel
          api={api}
          language={language}
          readOnly={readOnly}
          challengeId={challengeValid ? challenge.challengeId : undefined}
          expectedGeneration={challengeGeneration ?? status.generation}
          onVerify={() => {
            clearChallenge()
            setHistoryVerifyRequested(true)
            window.requestAnimationFrame(() => document.getElementById(`${id}-email`)?.focus())
          }}
          onCredentialConsumed={() => { clearChallenge(); setHistoryVerifyRequested(false) }}
        />
      </div>
    </details>
  )
}
