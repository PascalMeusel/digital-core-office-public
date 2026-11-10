import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { User } from '../shared/domain.ts'
import { defaultOvertimePolicy, type OvertimePolicy, type OvertimePolicyState } from '../shared/overtimePolicy.ts'
import './OvertimePolicyPanel.css'

const fields=['balanceOvertimeMinutes','balanceUndertimeMinutes','dailyOvertimeMinutes','dailyUndertimeMinutes'] as const
type Limit=typeof fields[number]
const hours=(p:OvertimePolicy)=>Object.fromEntries(fields.map(field=>[field,p[field]===null?'':String(p[field]!/60)])) as Record<Limit,string>

export function OvertimePolicyPanel({state,users,language,loading,readOnly,onSave,onRetry}:{
  state?: OvertimePolicyState; users: User[]; language:'de'|'en';loading:boolean;readOnly?:boolean;
  onSave:(body:Record<string,unknown>)=>Promise<boolean>;onRetry:()=>Promise<boolean>
}) {
  const label=(de:string,en:string)=>language==='de'?de:en
  const [policy,setPolicy]=useState<OvertimePolicy>(state?.policy??defaultOvertimePolicy)
  const [error,setError]=useState(''),[saved,setSaved]=useState(false)
  const [values,setValues]=useState(()=>hours(policy))
  const loadedRevision=useRef(policy.revision)
  useEffect(()=>{
    const next=state?.policy??defaultOvertimePolicy
    // Background state refreshes must preserve unsaved administrator input.
    if(loadedRevision.current===next.revision)return
    loadedRevision.current=next.revision;setPolicy(next);setValues(hours(next))
  },[state?.policy])
  const admins=users.filter(user=>user.active&&user.role==='admin'&&!user.mustChangePassword)
  const change=(patch:Partial<OvertimePolicy>)=>{setPolicy(value=>({...value,...patch}));setSaved(false)}
  async function submit(event:FormEvent) {
    event.preventDefault();setError('');setSaved(false)
    const limits:Record<string,number|null>={}
    for(const field of fields){const text=values[field].trim(),value=Number(text);if(text&&(!Number.isFinite(value)||value<0||value>87600)){setError(label('Bitte gültige, nicht negative Stundengrenzen eingeben.','Enter valid non-negative hour limits.'));return}limits[field]=text?Math.round(value*60):null}
    if(await onSave({...policy,...limits,recipientUserIds:policy.recipientUserIds.filter(id=>admins.some(admin=>admin.id===id))}))setSaved(true)
  }
  const limit=(field:Limit,title:string)=><label key={field}>{title}<input type="number" min="0" max="87600" step="any" value={values[field]} disabled={!policy.overtimeAllowed&&field.includes('Overtime')} placeholder={label('Keine Grenze','No limit')} onChange={event=>{setValues(old=>({...old,[field]:event.target.value}));setSaved(false)}} /></label>
  return <section className="panel overtime-policy-panel">
    <h2>{label('Überstunden und Benachrichtigungen','Overtime and alerts')}</h2>
    <p>{label('Arbeitszeit wird vollständig erfasst. Die Regeln kennzeichnen Überschreitungen; sie beenden keine Stempelung und löschen keine Stunden.','All working time is recorded. These rules flag breaches; they do not stop clocking or discard hours.')}</p>
    <form onSubmit={event=>void submit(event)}>
      <fieldset disabled={loading||readOnly}>
        <label className="overtime-toggle"><input type="checkbox" checked={policy.overtimeAllowed} onChange={event=>change({overtimeAllowed:event.target.checked})}/>{label('Überstunden grundsätzlich erlaubt','Overtime allowed')}</label>
        {!policy.overtimeAllowed&&<p>{label('Jede positive Abweichung überschreitet die Obergrenze von 0 Stunden.','Any positive excess crosses the upper limit of 0 hours.')}</p>}
        <label>{label('Grenzen anwenden auf','Apply limits to')}<select value={policy.scope} onChange={event=>change({scope:event.target.value as OvertimePolicy['scope']})}>
          <option value="balance">{label('Stundensaldo','Time-account balance')}</option><option value="day">{label('Einzelnen Arbeitstag','Individual workday')}</option><option value="both">{label('Beides mit getrennten Grenzen','Both with separate limits')}</option>
        </select></label>
        {policy.scope!=='day'&&<div className="overtime-limits">{limit('balanceOvertimeMinutes',label('Maximaler positiver Saldo (Stunden)','Maximum positive balance (hours)'))}{limit('balanceUndertimeMinutes',label('Erlaubtes Minus im Saldo (Stunden)','Allowed negative balance (hours)'))}</div>}
        {policy.scope!=='balance'&&<div className="overtime-limits">{limit('dailyOvertimeMinutes',label('Maximale tägliche Überstunden','Maximum daily overtime (hours)'))}{limit('dailyUndertimeMinutes',label('Erlaubte tägliche Minusstunden','Allowed daily undertime (hours)'))}</div>}
        {policy.scope!=='balance'&&<p className="muted">{label('Tagesgrenzen vergleichen erfasste Arbeit mit dem Arbeitssoll nach genehmigten Abwesenheiten und Feiertagen. Auszahlungen und reine Saldokorrekturen sind keine tägliche Arbeitszeitabweichung.','Daily limits compare recorded work with expected work after approved absences and holidays. Payouts and balance-only corrections are not daily work deviations.')}</p>}
        <p className="muted">{label('Leeres Feld: keine Grenze. Genau auf der Grenze: keine Überschreitung. Grundlage ist der in DCO angezeigte Saldo; ungeklärte Anfangssalden werden in der E-Mail gekennzeichnet.','Empty field: no limit. Exactly at a limit: no breach. Balance alerts use the balance shown in DCO; unresolved opening balances are identified in the email.')}</p>
        <label className="overtime-toggle"><input type="checkbox" checked={policy.emailEnabled} disabled={!state?.mailConfigured&&!policy.emailEnabled} onChange={event=>change({emailEnabled:event.target.checked})}/>{label('Administratoren bei Grenzüberschreitung per E-Mail informieren','Email administrators when a limit is crossed')}</label>
        {!state?.mailConfigured&&<p role="status">{label('Zuerst den SMTP-Mailserver in den Einstellungen konfigurieren. E-Mail-Benachrichtigungen sind noch nicht verfügbar.','Configure the SMTP mail server in Settings first. Email alerts are not available yet.')}</p>}
        <div className="overtime-recipients" role="group" aria-label={label('E-Mail-Empfänger','Email recipients')}>
          <strong>{label('Benachrichtigte Administratoren','Administrators to notify')}</strong>
          {admins.map(admin=><label className="overtime-toggle" key={admin.id}><input type="checkbox" checked={policy.recipientUserIds.includes(admin.id)} onChange={event=>change({recipientUserIds:event.target.checked?[...policy.recipientUserIds,admin.id]:policy.recipientUserIds.filter(id=>id!==admin.id)})}/><span>{admin.name} · {admin.email}</span></label>)}
        </div>
        <p className="muted">{label('Prüfung jede Minute. Ein Hinweis pro Grenzübertritt, erneut nach Rückkehr in den erlaubten Bereich. Neue Regeln prüfen den aktuellen Saldo; Tagesmeldungen beginnen ab dem Speichern und nach Abschluss des Tages. Vergangene Importtage lösen keine E-Mail-Serie aus.','Checked every minute. One alert per crossing, rearmed after returning within bounds. New settings check the current balance; daily alerts start from saving and after clocking out. Historical imported days do not trigger a flood of emails.')}</p>
        <button type="submit" className="primary-button">{label('Überstundenregeln speichern','Save overtime policy')}</button>
      </fieldset>
      {error&&<p role="alert" className="form-error">{error}</p>}
      {saved&&<p role="status">{label('Überstundenregeln gespeichert.','Overtime policy saved.')}</p>}
    </form>
    {state&&<p className="muted">{label('E-Mails: ausstehend','Emails: pending')} {state.alerts.pending} · {label('gesendet','sent')} {state.alerts.sent} · {label('fehlgeschlagen','failed')} {state.alerts.failed} · {label('Zustellung unklar','delivery uncertain')} {state.alerts.unknown}</p>}
    {Boolean(state?.alerts.failed)&&<button disabled={loading||readOnly||!state?.mailConfigured} className="secondary-button" onClick={()=>void onRetry()}>{label('Fehlgeschlagene E-Mails erneut senden','Retry failed emails')}</button>}
    {Boolean(state?.alerts.unknown)&&<p>{label('Bei unklarer Zustellung zuerst das Postfach prüfen. Diese E-Mails werden nicht automatisch erneut versendet.','Check the recipient mailbox for uncertain deliveries. These emails are not automatically resent.')}</p>}
  </section>
}
