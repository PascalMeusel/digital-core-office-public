import { createHash } from 'node:crypto'
import type { AbsenceDay, DayIssue, DayIssueSuggestion, Holiday, TimeEntry, User } from '../shared/domain.ts'
import { addDays, businessTimeMinutes, dateKeysBetween, isWeekend, parseDateKey, toDateKey } from '../shared/dates.ts'
import { termForDate } from '../shared/terms.ts'
import { entryWorkedMinutes } from './calculations.ts'
import { accountingDay, accountingExpectedMinutesForUser, type ZeitguruAccountingContexts } from '../shared/timeAccounting.ts'
import { dayIssueNeedsReview } from '../shared/dayIssueReview.ts'

const lookbackDays = Math.max(14, Math.min(366, Number(process.env.DAY_ISSUE_LOOKBACK_DAYS ?? 90)))
const scheduleToleranceMinutes = Math.max(0, Number(process.env.DAY_ISSUE_SCHEDULE_TOLERANCE_MINUTES ?? 15))
const warnSundayWork = process.env.DAY_ISSUE_WARN_SUNDAY_WORK !== 'false'

function issueId(userId: string, date: string, rule: DayIssue['rule']) {
  return createHash('sha256').update(`${userId}:${date}:${rule}`).digest('hex').slice(0, 24)
}

function correctionSuggestion(date: string, entries: TimeEntry[], reason: string, expectedWorkMinutes?: number, options: { capMinutes?: number; breakMinutes?: number } = {}): DayIssueSuggestion {
  const closed = entries.filter((entry) => entry.stoppedAt).sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  const first = [...entries].filter(entry=>Number.isFinite(Date.parse(entry.startedAt))).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))[0]
  const last = closed.at(-1)
  const start = first ? new Date(first.startedAt) : undefined
  const end = last?.stoppedAt ? new Date(last.stoppedAt) : undefined
  const time = (value: Date | undefined, fallback: string) => value && !Number.isNaN(value.getTime())
    ? `${String(Math.floor(businessTimeMinutes(value)/60)).padStart(2, '0')}:${String(businessTimeMinutes(value)%60).padStart(2, '0')}`
    : fallback
  const breakMinutes = entries.reduce((total, entry) => total + (entry.manualBreakMinutes ?? 0) + entry.breaks.reduce((sum, segment) => {
    if (!segment.stoppedAt) return sum
    return sum + Math.max(0, Math.round((new Date(segment.stoppedAt).getTime() - new Date(segment.startedAt).getTime()) / 60_000))
  }, 0), 0)
  const autoClosed=entries.some(entry=>entry.note?.includes('counts as 0 hours until corrected'))
  const span=start&&end?(end.getTime()-start.getTime())/60_000:0
  const validSpan=Number.isFinite(span)&&span>0&&span<24*60&&!autoClosed
  const gaps=validSpan?Math.max(0,Math.round(span-closed.reduce((sum,entry)=>sum+rawEntryMinutes(entry),0))):0
  const recordedBreak=Number.isFinite(breakMinutes)&&breakMinutes>=0&&(!span||breakMinutes<span)&&!autoClosed?Math.round(breakMinutes):0
  const suggestedBreakMinutes = gaps+(options.breakMinutes ?? (recordedBreak || (expectedWorkMinutes && expectedWorkMinutes > 9*60 ? 45 : expectedWorkMinutes && expectedWorkMinutes > 6*60 ? 30 : 0)))
  const suggestedStartTime = time(start, '09:00')
  const suggestedEndTime = options.capMinutes !== undefined
    ? time(new Date((start?.getTime()??new Date(`${date}T09:00:00`).getTime())+(options.capMinutes+suggestedBreakMinutes)*60_000),'19:45')
    : validSpan
    ? time(end, '17:00')
    : (() => {
        const endMinutes = Math.round((start?businessTimeMinutes(start):9*60) + (expectedWorkMinutes??8*60) + suggestedBreakMinutes)
        return `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
      })()
  return {
    action: 'time_correction',
    labelEn: options.capMinutes !== undefined ? 'Prepare correction to 10 hours' : 'Auto-fill resolution',
    labelDe: options.capMinutes !== undefined ? 'Korrektur auf 10 Stunden vorbereiten' : 'Lösung automatisch ausfüllen',
    draft: {
      type: 'time_correction',
      correctionDate: date,
      proposedStartTime: suggestedStartTime,
      proposedEndTime: suggestedEndTime,
      proposedBreakMinutes: String(suggestedBreakMinutes),
      reason,
      reviewProposal: true,
    },
  }
}

function absenceSuggestion(date: string): DayIssueSuggestion {
  return {
    action: 'absence_request',
    labelEn: 'Prepare absence request',
    labelDe: 'Abwesenheitsantrag vorbereiten',
    draft: { type: 'vacation', startDate: date, endDate: date, reason: 'Resolve flagged missing workday / Markierten fehlenden Arbeitstag klären' },
  }
}

const reviewSuggestion: DayIssueSuggestion = {
  action: 'admin_review',
  labelEn: 'Discuss with responsible administrator',
  labelDe: 'Mit verantwortlicher Administration klären',
}

function makeIssue(
  userId: string,
  date: string,
  rule: DayIssue['rule'],
  severity: DayIssue['severity'],
  category: DayIssue['category'],
  titleEn: string,
  titleDe: string,
  messageEn: string,
  messageDe: string,
  suggestions: DayIssueSuggestion[],
  numbers: Pick<DayIssue, 'actualMinutes' | 'expectedMinutes'> = {},
): DayIssue {
  return { id: issueId(userId, date, rule), userId, date, rule, severity, category, titleEn, titleDe, messageEn, messageDe, suggestions, ...numbers }
}

function breakMinutes(entry: TimeEntry) {
  return (entry.manualBreakMinutes ?? 0) + entry.breaks.reduce((total, segment) => {
    if (!segment.stoppedAt) return total
    return total + Math.max(0, Math.round((new Date(segment.stoppedAt).getTime() - new Date(segment.startedAt).getTime()) / 60_000))
  }, 0)
}

function rawEntryMinutes(entry: TimeEntry) {
  if (!entry.stoppedAt) return 0
  return Math.round((new Date(entry.stoppedAt).getTime() - new Date(entry.startedAt).getTime()) / 60_000)
}

function expectedMinutes(user: User, date: string, absences: Set<string>, holidays: Map<string, Holiday>) {
  if (isWeekend(date) || absences.has(date) || (user.trackingStartDate && date < user.trackingStartDate)) return 0
  const holiday = holidays.get(date)
  const fraction = holiday ? Math.max(0, 1 - holiday.freePercent / 100) : 1
  return Math.round(termForDate(user, date).expectedWeeklyMinutes / 5 * fraction)
}

function structuralIssues(user: User, date: string, entries: TimeEntry[], isCurrentDay = false, expectedWorkMinutes?: number) {
  const issues: DayIssue[] = []
  const correction = correctionSuggestion(date, entries, 'Proposal: verify the actual start, end and breaks before submitting. / Vorschlag: Tatsächlichen Beginn, Schluss und Pausen vor dem Absenden prüfen.',expectedWorkMinutes)
  if (entries.some((entry) => (!entry.stoppedAt && !isCurrentDay)
    || (Boolean(entry.stoppedAt) && entry.breaks.some((segment) => !segment.stoppedAt)))) {
    issues.push(makeIssue(user.id, date, 'unclosed_entry', 'error', 'data', 'Unclosed time entry', 'Nicht abgeschlossener Zeiteintrag',
      'A work or break timer is still open for this day.', 'Für diesen Tag ist noch eine Arbeits- oder Pausenzeit offen.', [correction]))
  }
  const invalid = entries.some((entry) => {
    const start = new Date(entry.startedAt)
    const stop = entry.stoppedAt ? new Date(entry.stoppedAt) : undefined
    if (Number.isNaN(start.getTime()) || (stop && (Number.isNaN(stop.getTime()) || stop <= start))) return true
    if (stop && (breakMinutes(entry) < 0 || (entry.source !== 'zeitguru' && breakMinutes(entry) > rawEntryMinutes(entry)))) return true
    return entry.breaks.some((segment) => {
      const breakStart = new Date(segment.startedAt)
      const breakStop = segment.stoppedAt ? new Date(segment.stoppedAt) : undefined
      return Number.isNaN(breakStart.getTime()) || Boolean(breakStop && (Number.isNaN(breakStop.getTime()) || breakStop <= breakStart || breakStart < start || (stop && breakStop > stop)))
    })
  })
  if (invalid) {
    issues.push(makeIssue(user.id, date, 'invalid_entry', 'error', 'data', 'Invalid time sequence', 'Ungültiger Zeitablauf',
      'Start, stop, or break timestamps are inconsistent.', 'Start-, End- oder Pausenzeiten sind widersprüchlich.', [correction]))
  }
  const closed = entries.filter((entry) => entry.stoppedAt).sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  if (closed.some((entry, index) => index > 0 && new Date(entry.startedAt) < new Date(closed[index - 1]!.stoppedAt!))) {
    issues.push(makeIssue(user.id, date, 'overlapping_entries', 'error', 'data', 'Overlapping time entries', 'Überlappende Zeiteinträge',
      'At least two work intervals overlap.', 'Mindestens zwei Arbeitsintervalle überschneiden sich.', [correction]))
  }
  if (entries.some((entry) => entry.note?.includes('counts as 0 hours until corrected'))) {
    issues.push(makeIssue(user.id, date, 'automatic_zero_hour_close', 'error', 'data', 'Automatic zero-hour close', 'Automatischer Nullstunden-Abschluss',
      'An overlong timer was closed automatically and currently counts as zero.', 'Ein zu langer Timer wurde automatisch beendet und zählt derzeit als null Stunden.', [correction]))
  }
  return issues
}

export function dayIssuesForUsers(
  users: User[],
  entries: TimeEntry[],
  absences: AbsenceDay[],
  holidays: Holiday[],
  reference = new Date(),
  accounting: ZeitguruAccountingContexts = {},
) {
  const today = toDateKey(reference)
  const start = addDays(today, -lookbackDays)
  const lastClosedDay = addDays(today, -1)
  const holidayMap = new Map(holidays.map((holiday) => [holiday.date, holiday]))
  const issues: DayIssue[] = []

  for (const user of users.filter((candidate) => candidate.active)) {
    const context = accounting[user.id], userStart = context && context.fromDate < start ? context.fromDate : start
    const userEntries = entries.filter((entry) => entry.userId === user.id && entry.date >= (userStart < addDays(today, -168) ? userStart : addDays(today, -168)) && entry.date <= today)
    const entriesByDate = new Map<string, TimeEntry[]>()
    for (const entry of userEntries) entriesByDate.set(entry.date, [...(entriesByDate.get(entry.date) ?? []), entry])
    const absenceDates = new Set(absences.filter((absence) => absence.userId === user.id).map((absence) => absence.date))

    for (const date of dateKeysBetween(userStart, today)) {
      const dayEntries = entriesByDate.get(date) ?? []
      const sourceDay = accountingDay(context, date), sourceExpected = accountingExpectedMinutesForUser(user, context, date)
      const expected = absenceDates.has(date)?0:sourceDay ? Math.max(0, sourceDay.expectedMinutes - sourceDay.absenceMinutes - sourceDay.holidayMinutes)
        : sourceExpected !== undefined ? (absenceDates.has(date) ? 0 : sourceExpected) : expectedMinutes(user, date, absenceDates, holidayMap)
      issues.push(...structuralIssues(user, date, dayEntries, date === today,expected||undefined))
      const worked = dayEntries.filter((entry) => entry.stoppedAt).reduce((total, entry) => total + entryWorkedMinutes(entry), 0)
      const breaks = dayEntries.reduce((total, entry) => total + breakMinutes(entry), 0)
      // Approved full-day time off can debit the balance (for example overtime
      // reduction) without requiring an attendance record for that day.
      const sourceFullDayAbsence = Boolean(sourceDay?.absence && !sourceDay.absence.startsHalfDay && !sourceDay.absence.endsHalfDay)

      if (date <= lastClosedDay && expected > 0 && dayEntries.length === 0 && !sourceFullDayAbsence && !(sourceDay && sourceDay.workedMinutes > 0)) {
        issues.push(makeIssue(user.id, date, 'missing_day', 'error', 'data', 'Expected workday has no entry', 'Erwarteter Arbeitstag ohne Eintrag',
          'No time or approved absence is recorded.', 'Es ist weder Arbeitszeit noch eine genehmigte Abwesenheit erfasst.',
          [correctionSuggestion(date, dayEntries, 'Add missing work time / Fehlende Arbeitszeit ergänzen', expected), absenceSuggestion(date)], { actualMinutes: 0, expectedMinutes: expected }))
      } else if (date <= lastClosedDay && expected > 0 && dayEntries.length > 0 && Math.abs(worked - expected) > scheduleToleranceMinutes) {
        issues.push(makeIssue(user.id, date, 'schedule_variance', 'info', 'policy', 'Work time differs from schedule', 'Arbeitszeit weicht vom Soll ab',
          'Recorded work differs from the configured daily target.', 'Die erfasste Arbeitszeit weicht vom hinterlegten Tagessoll ab.',
          [], { actualMinutes: worked, expectedMinutes: expected }))
      }

      const requiredBreak = worked > 9 * 60 ? 45 : worked > 6 * 60 ? 30 : 0
      if (requiredBreak > breaks) {
        issues.push(makeIssue(user.id, date, 'insufficient_break', 'warning', 'compliance', 'Recorded break may be insufficient', 'Erfasste Pause möglicherweise zu kurz',
          `At least ${requiredBreak} break minutes are expected for this duration. Do not add a break that was not actually taken.`,
          `Für diese Dauer werden mindestens ${requiredBreak} Pausenminuten erwartet. Keine Pause ergänzen, die nicht tatsächlich genommen wurde.`,
          [correctionSuggestion(date, dayEntries, 'Record only an actually taken but missing break / Nur tatsächlich genommene, fehlende Pause erfassen',undefined,{breakMinutes:requiredBreak}), reviewSuggestion],
          { actualMinutes: breaks, expectedMinutes: requiredBreak }))
      }
      if (worked > 10 * 60) {
        issues.push(makeIssue(user.id, date, 'daily_ten_hour_limit', 'error', 'compliance', 'More than 10 hours recorded', 'Mehr als 10 Stunden erfasst',
          'The recorded daily working time exceeds the general statutory ceiling; verify accuracy and applicable exceptions.',
          'Die erfasste tägliche Arbeitszeit überschreitet die allgemeine gesetzliche Obergrenze; Richtigkeit und Ausnahmen prüfen.',
          [correctionSuggestion(date,dayEntries,'Proposed reduction to 10 hours: use only if the recorded duration is wrong. Verify the proposed break was actually taken. / Vorgeschlagene Kürzung auf 10 Stunden: Nur bei falscher erfasster Dauer verwenden. Prüfen, ob die vorgeschlagene Pause tatsächlich genommen wurde.',undefined,{capMinutes:600,breakMinutes:Math.max(45,breaks)}),reviewSuggestion], { actualMinutes: worked, expectedMinutes: 600 }))
      } else if (worked > 8 * 60) {
        issues.push(makeIssue(user.id, date, 'daily_eight_hour_warning', 'warning', 'compliance', 'More than 8 hours recorded', 'Mehr als 8 Stunden erfasst',
          'Compensation-period requirements may apply.', 'Vorgaben zum Ausgleichszeitraum können gelten.', [], { actualMinutes: worked, expectedMinutes: 480 }))
      }
      const weekday = parseDateKey(date).getDay()
      if (worked > 0 && ((warnSundayWork && weekday === 0) || holidayMap.has(date))) {
        issues.push(makeIssue(user.id, date, 'sunday_or_holiday_work', 'warning', 'compliance', 'Sunday or holiday work recorded', 'Sonn- oder Feiertagsarbeit erfasst',
          'Verify that an applicable exception and required compensation exist.', 'Prüfen, ob eine zulässige Ausnahme und erforderlicher Ausgleich vorliegen.', [reviewSuggestion]))
      }
    }

    const closed = userEntries.filter((entry) => entry.stoppedAt).sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    for (let index = 1; index < closed.length; index += 1) {
      const previous = closed[index - 1]!
      const current = closed[index]!
      if (previous.date === current.date) continue
      const rest = Math.round((new Date(current.startedAt).getTime() - new Date(previous.stoppedAt!).getTime()) / 60_000)
      if (rest >= 0 && rest < 11 * 60) {
        issues.push(makeIssue(user.id, current.date, 'insufficient_rest', 'warning', 'compliance', 'Less than 11 hours rest', 'Weniger als 11 Stunden Ruhezeit',
          'The interval since the previous recorded work period is below the general 11-hour rest requirement.',
          'Der Abstand zur vorherigen erfassten Arbeitszeit liegt unter der allgemeinen Ruhezeit von 11 Stunden.', [reviewSuggestion],
          { actualMinutes: rest, expectedMinutes: 660 }))
      }
    }

    const compensationStart = addDays(today, -24 * 7)
    const compensationEntries = userEntries.filter((entry) => entry.date >= compensationStart && entry.stoppedAt)
    const compensationWorked = compensationEntries.reduce((total, entry) => total + entryWorkedMinutes(entry), 0)
    const applicableDays = dateKeysBetween(compensationStart, lastClosedDay).filter((date) => {
      const day = parseDateKey(date).getDay()
      return day !== 0 && !holidayMap.has(date)
    }).length
    if (applicableDays > 0 && compensationWorked / applicableDays > 8 * 60) {
      issues.push(makeIssue(user.id, lastClosedDay, 'compensation_period', 'warning', 'compliance', '24-week average exceeds 8 hours', '24-Wochen-Durchschnitt über 8 Stunden',
        'The advisory Monday–Saturday average is above eight hours. Verify the legally applicable compensation calculation.',
        'Der orientierende Montag-bis-Samstag-Durchschnitt liegt über acht Stunden. Den rechtlich anwendbaren Ausgleich prüfen.', [reviewSuggestion],
        { actualMinutes: Math.round(compensationWorked / applicableDays), expectedMinutes: 480 }))
    }
    if (context) {
      for (const date of new Set(context.warnings.filter(warning=>warning.code!=='native_correction_overrides_source').map(warning => warning.date))) issues.push(makeIssue(user.id, date, 'zeitguru_history_review', 'warning', 'data',
        'Imported history needs review', 'Importierter Verlauf muss geprüft werden',
        'An opening balance, source discrepancy or local change needs review. Open the imported day for details.',
        'Ein Anfangssaldo, eine Abweichung in der Quelle oder eine lokale Änderung muss geprüft werden. Details stehen beim importierten Tag.',
        [{ action: 'zeitguru_history', labelEn: 'Review imported day', labelDe: 'Importierten Tag prüfen' }]))
      for(const date of new Set(context.warnings.filter(warning=>warning.code==='native_correction_overrides_source').map(warning=>warning.date)))issues.push(makeIssue(user.id,date,'zeitguru_local_correction','info','data',
        'Approved DCO correction applied','Genehmigte DCO-Korrektur angewendet',
        'DCO uses the approved correction. The original Zeitguru record is preserved and has not been changed in Zeitguru.','DCO verwendet die genehmigte Korrektur. Das Zeitguru-Original bleibt erhalten und wurde in Zeitguru nicht verändert.',[]))
      for (const issue of issues.filter(issue => issue.userId === user.id && issue.date >= context.fromDate && issue.date <= context.toDate)) {
        issue.source = 'zeitguru'
        issue.suggestions = dayIssueNeedsReview(issue)
          ? [...issue.suggestions.filter(suggestion=>suggestion.draft),{ action: 'zeitguru_history', labelEn: 'Review imported day', labelDe: 'Importierten Tag prüfen' }, reviewSuggestion]
          : [{ action: 'zeitguru_history', labelEn: 'View imported day', labelDe: 'Importierten Tag ansehen' }]
      }
      const reconstruction=context.initialImportReconstruction
      if(reconstruction){
        for(const issue of issues.filter(issue=>issue.userId===user.id&&issue.date<=reconstruction.throughDate&&issue.category==='compliance')){
          const dayEntries=entriesByDate.get(issue.date)??[]
          if(dayEntries.length&&dayEntries.every(entry=>entry.source==='zeitguru'))issue.initialImportReview=true
        }
        for(const day of reconstruction.days){
          const transfers=reconstruction.transfers.filter(transfer=>transfer.fromDate===day.date||transfer.toDate===day.date)
          const links=transfers.map(transfer=>`${transfer.fromDate} → ${transfer.toDate}: ${transfer.minutes} min`).join('; ')
          const unallocated=reconstruction.unallocated.find(item=>item.date===day.date)?.minutes??0
          const before=`${day.originalStart??'—'}–${day.originalEnd??'—'} (${day.originalMinutes} min)`
          const after=`${day.proposedStart}–${day.proposedEnd} (${day.proposedMinutes} min, ${day.proposedBreakMinutes} min break / Pause)`
          const reasonsEn=day.reasons.map(reason=>reason==='ten_hours'?'Limit the estimate to 10 hours':reason==='eleven_hours'?'Start later for 11 hours between sessions':'Receive redistributed hours').join('; ')
          const reasonsDe=day.reasons.map(reason=>reason==='ten_hours'?'Schätzung auf 10 Stunden begrenzen':reason==='eleven_hours'?'Späterer Beginn für 11 Stunden zwischen Einsätzen':'Umverteilte Stunden aufnehmen').join('; ')
          const suffixEn=day.status==='applied'?'This proposal matches an approved DCO correction.':day.status==='changed'?'This day has since changed in DCO; compare it manually before another correction.':'Estimate only. Confirm the actual dates and times before submitting. Review all linked dates together.'
          const suffixDe=day.status==='applied'?'Dieser Vorschlag entspricht einer genehmigten DCO-Korrektur.':day.status==='changed'?'Dieser Tag wurde inzwischen in DCO geändert; vor einer weiteren Korrektur manuell vergleichen.':'Nur eine Schätzung. Tatsächliche Tage und Zeiten vor dem Absenden bestätigen. Alle verknüpften Tage gemeinsam prüfen.'
          const messageEn=`${reasonsEn}. ${before} → ${after}. ${links}${unallocated?` Unallocated: ${unallocated} min; no destination was found.`:''} ${suffixEn}`
          const messageDe=`${reasonsDe}. ${before} → ${after}. ${links}${unallocated?` Nicht verteilt: ${unallocated} min; kein Zieltag gefunden.`:''} ${suffixDe}`
          const suggestions:DayIssueSuggestion[]=[{action:'zeitguru_history',labelEn:'View original day',labelDe:'Originaltag ansehen'}]
          if(day.status==='proposal')suggestions.unshift({action:'time_correction',labelEn:'Review correction proposal',labelDe:'Korrekturvorschlag prüfen',draft:{type:'time_correction',correctionDate:day.date,proposedStartTime:day.proposedStart,proposedEndTime:day.proposedEnd,proposedBreakMinutes:String(day.proposedBreakMinutes),reason:`Initial import reconstruction / Erstimport-Rekonstruktion. ${messageEn}`,reviewProposal:true}})
          issues.push({...makeIssue(user.id,day.date,'zeitguru_import_reconstruction','info','data','Initial import correction proposal','Korrekturvorschlag zum Erstimport',messageEn,messageDe,suggestions),source:'zeitguru',initialImportReview:true})
        }
      }
    }
  }

  const severityOrder = { error: 0, warning: 1, info: 2 }
  return issues.sort((left, right) => right.date.localeCompare(left.date) || severityOrder[left.severity] - severityOrder[right.severity])
}
