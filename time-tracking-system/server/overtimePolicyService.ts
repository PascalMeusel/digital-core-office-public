import { addDays, toDateKey } from '../shared/dates.ts'
import { accountingDay, periodTotalsWithAccounting, type ZeitguruAccountingContexts } from '../shared/timeAccounting.ts'
import type { Holiday, TimeEntry } from '../shared/domain.ts'
import type { Database } from './store.ts'
import { summaryForUser } from './calculations.ts'
import { deliverOvertimeEmail, mailServerConfigured } from './mailer.ts'
import { OvertimePolicyStore, type OvertimeObservation } from './overtimePolicyStore.ts'
import { coreEnabled, coreTimeAlertRecipients } from '../../packages/core-client/index.ts'
import type { StoredUser } from './store.ts'

export async function eligibleOvertimeRecipients(users: StoredUser[]) {
  const admins=users.filter(user=>user.active&&user.role==='admin'&&!user.mustChangePassword)
  if(!coreEnabled())return admins
  const authoritative=await coreTimeAlertRecipients(admins.flatMap(user=>user.coreUserId?[user.coreUserId]:[]))
  return admins.flatMap(user=>{const core=authoritative.find(core=>core.id===user.coreUserId);return core?[{...user,email:core.email}]:[]})
}

export interface OvertimeInputs { database: Database; entries: TimeEntry[]; holidays: Holiday[]; accounting: ZeitguruAccountingContexts }
export function overtimeObservations(store: OvertimePolicyStore, input: OvertimeInputs, now = new Date()) {
  const policy = store.policy(), today = toDateKey(now), yesterday = addDays(today,-1), observations: OvertimeObservation[] = []
  if (!policy.configured) return observations
  for (const user of input.database.users.filter(user=>user.active&&!user.mustChangePassword)) {
    const context = input.accounting[user.id]
    if (policy.scope !== 'day') {
      const summary = summaryForUser(user,input.entries,input.database.absences,input.holidays,now,input.database.requests,context)
      observations.push({userId:user.id,name:user.name,scope:'balance',date:today,minutes:summary.year.plusMinusMinutes,provisional:Boolean(summary.balanceReviewRequired)})
    }
    if (policy.scope !== 'balance') for (const date of [yesterday,today]) {
      // Start daily monitoring at activation, with no historical email flood. Today must be clocked out.
      if (date < toDateKey(new Date(policy.updatedAt!))) continue
      const native = input.database.timeEntries.filter(entry=>entry.userId===user.id&&entry.date===date)
      if (date===today && (!native.some(entry=>entry.stoppedAt)||native.some(entry=>!entry.stoppedAt))) continue
      const totals = periodTotalsWithAccounting(user,input.entries,input.database.absences,input.holidays,date,date,context,{now,requests:input.database.requests})
      const sourceDay=accountingDay(context,date)
      const fullAbsence=sourceDay?.absence&&!sourceDay.absence.startsHalfDay&&!sourceDay.absence.endsHalfDay
      const expected=sourceDay ? fullAbsence ? 0 : Math.max(0,sourceDay.expectedMinutes-sourceDay.absenceMinutes-sourceDay.holidayMinutes) : totals.expectedMinutes
      observations.push({userId:user.id,name:user.name,scope:'day',date,minutes:Math.round(totals.workedMinutes-expected),provisional:Boolean(context?.warnings.some(warning=>warning.date===date))})
    }
  }
  return observations
}
export class OvertimePolicyService {
  private running = false
  readonly store: OvertimePolicyStore
  private inputs: () => OvertimeInputs
  private send: typeof deliverOvertimeEmail
  private recipients: typeof eligibleOvertimeRecipients
  constructor(store: OvertimePolicyStore, inputs: () => OvertimeInputs, send = deliverOvertimeEmail, recipients=eligibleOvertimeRecipients) { this.store=store;this.inputs=inputs;this.send=send;this.recipients=recipients;store.recover() }
  async check(now = new Date()) {
    if(this.running) return
    this.running=true
    try {
      const policy=this.store.policy();if(!policy.configured) return
      const input=this.inputs();this.store.observe(policy,overtimeObservations(this.store,input,now),now)
      if(!mailServerConfigured(input.database)) return
      for(let count=0;count<100;count++) {
        // Re-read recipients/settings before every send; disabling the policy cancels unsent alerts.
        const current=this.inputs(),selected=new Set(this.store.policy().recipientUserIds),admins=await this.recipients(current.database.users.filter(user=>selected.has(user.id)))
        const claimed=this.store.claim(new Set(admins.map(user=>user.id)));if(!claimed) break
        const recipient=admins.find(user=>user.id===claimed.payload.recipientId)!
        const {observation,side,limit}=claimed.payload
        const hours=(minutes:number)=>(minutes/60).toFixed(2)
        const subject=`Digital Core Office: ${side==='over'?'overtime':'undertime'} limit exceeded / Zeitgrenze überschritten`
        const text=[`${observation.name}: ${observation.date}`,`${observation.scope==='day'?'Daily work deviation / Tägliche Arbeitszeitabweichung':'Time-account balance shown in DCO / In DCO angezeigter Stundensaldo'}: ${hours(observation.minutes)} h`,`${side==='over'?'Upper limit / Obergrenze':'Lower limit / Untergrenze'}: ${side==='under'?'-':''}${hours(limit)} h`,
          ...(observation.provisional?['This balance has unresolved source or opening-balance checks. Review it before taking action. / Der Saldo enthält ungeklärte Quell- oder Anfangssaldoprüfungen. Bitte vor Maßnahmen prüfen.']:[]),
          'Recorded work has not been changed. / Die erfasste Arbeitszeit wurde nicht geändert.',
          'One alert is sent when a limit is crossed. A new balance alert requires return within bounds or a changed policy. / Ein Hinweis pro Grenzübertritt; erneuter Saldohinweis erst nach Rückkehr in den Bereich oder geänderter Regel.',
        ].join('\n')
        try { await this.send(current.database,recipient.email,subject,text,claimed.id);this.store.complete(claimed.id,'sent') }
        catch(error) {
          const code=typeof error==='object'&&error&&'code'in error?String(error.code):''
          this.store.complete(claimed.id,['ENOCONFIG','ECONNECTION','EDNS','EAUTH','EENVELOPE','ECONNREFUSED'].includes(code)?'failed':'unknown')
        }
      }
    } finally { this.running=false }
  }
}
