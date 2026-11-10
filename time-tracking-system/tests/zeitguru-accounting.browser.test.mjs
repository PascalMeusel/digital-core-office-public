// Local synthetic browser regression. Run from time-tracking-system:
// node tests/zeitguru-accounting.browser.test.mjs
import { createServer } from 'vite'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('../.runtime/company-deploy-20260907')
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client'; import App from '/src/App.tsx'; import '/src/index.css';
import {businessDateKey} from '/shared/dates.ts';
const today=businessDateKey(),now=new Date(),uid='fixture-user';
const user={id:uid,name:'Synthetic Employee',email:'synthetic@example.test',role:'admin',expectedWeeklyMinutes:2400,yearlyVacationDays:30,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,trackingStartDate:today,employmentTerms:[],calendarAccessUserIds:[],active:true,mustChangePassword:false};
const native={id:'native-live',userId:uid,date:today,startedAt:new Date(+now-3600000).toISOString(),breaks:[],source:'clock',createdAt:now.toISOString(),updatedAt:now.toISOString()};
const bridge={available:true,enabled:true,generation:7,clockRevision:12,requiresAttention:false,identity:{name:user.name,email:user.email,branchName:'Synthetic Office'},counts:{queued:0,sending:0,confirmed:0,retryable_failure:0,reconciliation_required:0,authentication_required:0,cancelled:0}};
const day={date:'2024-07-01',expectedMinutes:360,workedMinutes:300,actualWorkedMinutes:360,actualBreakMinutes:30,absenceMinutes:120,holidayMinutes:0,correctionMinutes:0,creditedMinutes:420,balanceMinutes:60,exactDeltaMinutes:60,absence:{typeCode:'custom',typeName:'Home Office',startsHalfDay:false,endsHalfDay:false}};
const ordinaryDay={approvedAutomaticClockOut:true,date:'2024-07-02',expectedMinutes:480,workedMinutes:510,actualWorkedMinutes:510,actualBreakMinutes:30,absenceMinutes:0,holidayMinutes:0,correctionMinutes:0,creditedMinutes:510,balanceMinutes:90,exactDeltaMinutes:30};
const context={batchId:'history-batch',fromDate:'2024-07-01',toDate:'2024-07-02',observedAt:now.toISOString(),openingKnown:false,balanceBasis:'period_delta',openingBalanceMinutes:0,closingBalanceMinutes:90,days:[day,ordinaryDay],forecast:[{date:today,expectedMinutes:480}],warnings:[{date:day.date,code:'source_opening_missing'}]};
context.initialImportReconstruction={version:1,throughDate:ordinaryDay.date,days:[{date:ordinaryDay.date,originalStart:'08:00',originalEnd:'17:00',originalMinutes:510,proposedStart:'08:00',proposedEnd:'18:15',proposedBreakMinutes:45,proposedMinutes:570,reasons:['receives_time'],status:'proposal'}],transfers:[{fromDate:day.date,toDate:ordinaryDay.date,minutes:60}],unallocated:[]};
const historyEntry={id:'zeitguru-row',userId:uid,date:day.date,startedAt:'2024-07-01T06:00:00.000Z',stoppedAt:'2024-07-01T16:00:00.000Z',breaks:[],manualBreakMinutes:30,source:'zeitguru',zeitguru:{workedMinutes:360,creditedMinutes:420,approved:true,readOnly:true,batchId:'history-batch'},importBatchId:'history-batch',createdAt:now.toISOString(),updatedAt:now.toISOString()};
const row={id:'row',date:day.date,startedAt:historyEntry.startedAt,stoppedAt:historyEntry.stoppedAt,startTime:'08:00',endTime:'18:00',breakMinutes:30,workedMinutes:360,creditedMinutes:420,approved:true};
const summary={userId:uid,week:{workedMinutes:0,expectedMinutes:2400,plusMinusMinutes:-2400},month:{workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0},year:{workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0},vacation:{yearlyDays:30,usedDays:0,remainingDays:30}};
const base={organizationTimezone:'Europe/Berlin',currentUser:user,users:[user],visibleCalendarUsers:[user],shareableCalendarUsers:[],calendarGroups:[],calDavAccounts:[],externalCalendarEvents:[],customCalendarEvents:[],timeEntries:[native],adminTimeEntries:[native],absences:[],holidays:[],holidayOverrides:[],holidaySettings:{country:'DE',language:'de'},holidayTemplateOptions:{countries:[],states:[],regions:[]},requests:[],notifications:[],importBatches:[],userInvitations:[],backup:{dataFile:'fixture',backupDir:'fixture',nextAutomaticCheck:'fixture'},summaries:[summary],clockStatus:'working',clockStatuses:{[uid]:'working'},clockLocations:{},todayEntry:native,dayIssues:[],zeitguru:bridge};
const batch={id:'history-batch',createdAt:+now,fromDate:day.date,toDate:day.date,added:1,duplicates:0,conflicts:0,skipped:0,warnings:[],canUndo:true,undone:false,fingerprint:'synthetic-fingerprint'};
const issues=Array.from({length:25},(_,i)=>({id:'immutable-history-'+i,userId:uid,date:day.date,source:'zeitguru',rule:'zeitguru_history_review',severity:'warning',category:'data',titleEn:'Review imported accounting',titleDe:'Importierte Abrechnung prüfen',messageEn:'Synthetic source warning.',messageDe:'Synthetischer Quellhinweis.',suggestions:[{action:'zeitguru_history',labelEn:'Review imported day',labelDe:'Importierten Tag prüfen'}]}));
issues.push(...['schedule_variance','daily_eight_hour_warning'].map((rule,i)=>({id:'ordinary-info-'+i,userId:uid,date:ordinaryDay.date,source:'zeitguru',rule,severity:i?'warning':'info',category:i?'compliance':'policy',titleEn:'Ordinary recorded overtime',titleDe:'Erfasste Überstunden',messageEn:'Information about recorded work.',messageDe:'Information zur erfassten Arbeitszeit.',suggestions:[{action:'zeitguru_history',labelEn:'View imported day',labelDe:'Importierten Tag ansehen'}]})));
window.fixture={state:base,calls:[],imported:false,nativeBefore:JSON.stringify(native),bridgeBefore:JSON.stringify(bridge)};
const historyStatus=()=>({available:true,connected:true,canImport:true,generation:7,totalRecords:window.fixture.imported?1:0,totalWorkedMinutes:window.fixture.imported?360:0,totalCreditedMinutes:window.fixture.imported?420:0,uncreditedRecords:0,...(window.fixture.imported?{accounting:context,lastImport:batch}:{})});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options={})=>{const url=new URL(typeof input==='string'?input:input.url,location.href),p=url.pathname;window.fixture.calls.push({path:p,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});
if(p.endsWith('/api/sso/session'))return response({token:'core-cookie-session'});
if(p.endsWith('/api/state'))return response(window.fixture.state);
if(p.endsWith('/api/zeitguru/history/import')){window.fixture.imported=true;window.fixture.state={...base,timeEntries:[native,historyEntry],adminTimeEntries:[native,historyEntry],zeitguruAccounting:{[uid]:context},dayIssues:issues,summaries:[{...summary,balanceReviewRequired:true}]};return response({status:historyStatus(),batch})}
if(p.endsWith('/api/zeitguru/history/undo')){window.fixture.imported=false;window.fixture.state=base;return response({status:historyStatus(),batch:{...batch,undone:true,canUndo:false}})}
if(p.endsWith('/api/zeitguru/history'))return response({status:historyStatus(),rows:window.fixture.imported?[row]:[]});
if(p.endsWith('/api/zeitguru'))return response(bridge);
if(p.endsWith('/api/core/modules'))return response({modules:[]});
throw Error('Unexpected synthetic API route '+p)};
window.WebSocket=class extends EventTarget {static OPEN=1;readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){this.readyState=3}};
localStorage.setItem('time-tracker-token','core-cookie-session');localStorage.setItem('time-tracker-language','de');localStorage.setItem('dco-suite-language','de');
createRoot(document.getElementById('root')).render(React.createElement(App,{initialState:base}));`

const server = await createServer({ plugins: [{ name: 'accounting-browser-fixture', resolveId(id) { if (id === 'virtual:accounting-fixture') return '\0accounting-fixture' }, load(id) { if (id === '\0accounting-fixture') return fixture }, configureServer(s) { s.middlewares.use('/__accounting_fixture', async (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(await s.transformIndexHtml('/__accounting_fixture', '<html><body><div id="root"></div><script type="module" src="/@id/virtual:accounting-fixture"></script></body></html>')) }) } }], server: { host: '127.0.0.1', port: 5189, strictPort: true } })
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:5189/__accounting_fixture')
  await page.locator('.zeitguru-panel > summary').click()
  await page.locator('.zeitguru-history-details > summary').click()
  await page.getByRole('button', { name: 'Meinen Zeitguru-Verlauf importieren', exact: true }).click()
  const attentionRows = page.locator('.day-review-detail .day-issue-row')
  await expect(page.locator('.day-review-summary')).toHaveCount(1)
  await expect(attentionRows).toHaveCount(25)
  await expect(page.locator('.day-issue-count')).toHaveText('1 Tag')
  await expect(page.locator('.day-review-tabs button').nth(2)).toContainText('1')
  expect(await page.evaluate(() => window.fixture.calls.some((call, i, list) => call.path === '/api/state' && list.slice(0, i).some(previous => previous.path.endsWith('/history/import'))))).toBe(true)
  await page.locator('.day-review-options > summary').click()
  await page.locator('.day-issues-panel').getByLabel('Von', { exact: true }).fill('2024-07-02')
  await expect(attentionRows).toHaveCount(0)
  await expect(page.locator('.day-issue-count')).toHaveText('1 Tag') // Header keeps the overall count even with date filters.
  await expect(page.locator('.day-review-tabs button').nth(0)).toContainText('0')
  await expect(page.locator('.day-issues-panel')).toContainText('müssen keine Tage geprüft werden')
  await page.locator('.day-review-tabs button').nth(2).click()
  await expect(page.locator('.day-review-detail .day-issue-row')).toHaveCount(2)
  await expect(page.locator('.day-review-finding > summary small').first()).toHaveText('Information')
  await expect(page.locator('.day-review-detail')).not.toContainText('Importierten Tag prüfen')
  await page.getByRole('button', {name:'Importierten Tag ansehen',exact:true}).first().click()
  await expect(page.locator('#zeitguru-day-review')).toContainText('2.7.2024')
  await page.locator('#zeitguru-day-review .zeitguru-import-reconstruction > summary').click()
  await expect(page.locator('#zeitguru-day-review .zeitguru-import-reconstruction')).toContainText('60 min')
  await expect(page.locator('#zeitguru-day-review .zeitguru-import-reconstruction')).toContainText('Vorschlag; noch nicht angewendet.')
  await expect(page.locator('#zeitguru-day-review')).toContainText('Automatisches Ausstempeln in Zeitguru freigegeben.')
  await expect(page.locator('#zeitguru-day-review')).not.toContainText('Dieser Tag benötigt eine Prüfung')
  await page.setViewportSize({width:390,height:844})
  await page.locator('.day-review-detail').scrollIntoViewIfNeeded()
  await page.screenshot({path:path.join(output,'zeitguru-information-mobile.png')})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.getByRole('button',{name:'English',exact:true}).click()
  await expect(page.locator('.day-review-context')).toContainText('These do not count as current unresolved days.')
  await expect(page.locator('.day-review-summary')).toHaveCount(1)
  await expect(page.locator('#zeitguru-day-review')).toContainText('Automatic clock-out approved in Zeitguru. No correction is required for this.')
  await page.getByRole('button',{name:'Deutsch',exact:true}).click()
  await page.setViewportSize({width:1280,height:900})
  await page.locator('.day-issues-panel').getByLabel('Von', { exact: true }).fill('2025-01-01')
  await expect(page.locator('.day-issue-row')).toHaveCount(0)
  await page.locator('.day-issues-panel').getByLabel('Von', { exact: true }).fill('')
  await page.locator('.day-review-tabs button').nth(0).click();await page.getByRole('button', { name: 'Importierten Tag ansehen', exact: true }).first().click()
  await expect(page.locator('#zeitguru-day-review')).toBeVisible()
  await expect(page.locator('#zeitguru-day-review .zeitguru-history-row')).toBeVisible()
  await expect(page.locator('#zeitguru-day-review')).toContainText('Home Office')
  await expect(page.locator('#zeitguru-day-review')).toContainText('6 Std.')
  await expect(page.locator('#zeitguru-day-review')).toContainText('7 Std.')
  await expect(page.locator('#zeitguru-day-review')).toContainText('1 Std.')
  await page.locator('.summary-panel > summary').click()
  await expect(page.locator('.summary-panel')).toContainText('Überstunden im laufenden Jahr')
  await expect(page.locator('.summary-panel')).toContainText('nicht bestätigt')
  const lookup = page.locator('.worked-time-panel')
  await lookup.locator('summary').click()
  await lookup.locator('.app-select-button').click()
  await lookup.getByRole('option', { name: 'Tag', exact: true }).click()
  await lookup.locator('input').fill('01.07.2024')
  await lookup.locator('input').press('Enter')
  await expect(lookup.locator('.metric').nth(0).locator('strong')).toHaveText('6:00:00')
  await expect(lookup.locator('.metric').nth(1).locator('strong')).toHaveText('0:30:00')
  await expect(lookup.locator('.metric').nth(2).locator('strong')).toHaveText('6:00:00')
  await expect(lookup.locator('.metric').nth(3).locator('strong')).toHaveText('+1:00:00')
  await expect(page.locator('.clock-log-row')).toHaveCount(1)
  await page.locator('.clock-log-panel input').fill('01.07.2024')
  await page.locator('.clock-log-panel input').press('Enter')
  await expect(page.locator('.clock-log-row')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify(window.fixture.state.timeEntries.find(entry => entry.id === 'native-live')) === window.fixture.nativeBefore && JSON.stringify(window.fixture.state.zeitguru) === window.fixture.bridgeBefore)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#zeitguru-day-review .zeitguru-history-row').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: path.join(output, 'zeitguru-accounting-review-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.zeitguru-history-details .zeitguru-accounting').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 200))
  await page.screenshot({ path: path.join(output, 'zeitguru-accounting-history-mobile.png') })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('.zeitguru-history-details')).toContainText('Overtime for period')
  await expect(page.locator('.zeitguru-history-details')).toContainText('no configured opening balance')
  await page.getByRole('button', { name: 'Deutsch', exact: true }).click()
  await page.getByRole('button', { name: 'Diesen Import zurücksetzen', exact: true }).click()
  await expect(page.locator('.zeitguru-history-confirm')).toContainText('laufende DCO-Stempelungen')
  await page.locator('.zeitguru-history-confirm').getByRole('button', { name: 'Diesen Import zurücksetzen', exact: true }).click()
  await expect(page.locator('.day-issue-row')).toHaveCount(0)
  await expect(page.locator('#zeitguru-day-review')).toHaveCount(0)
  await expect(page.locator('.summary-panel')).not.toContainText('Überstunden im laufenden Jahr')
  const snapshot = await page.evaluate(() => ({ entries: window.fixture.state.timeEntries.length, preserved: JSON.stringify(window.fixture.state.timeEntries[0]) === window.fixture.nativeBefore && JSON.stringify(window.fixture.state.zeitguru) === window.fixture.bridgeBefore, undo: window.fixture.calls.find(call => call.path.endsWith('/history/undo'))?.body, writes: window.fixture.calls.filter(call => call.method !== 'GET').map(call => call.path) }))
  expect(snapshot.entries).toBe(1); expect(snapshot.preserved).toBe(true)
  expect(snapshot.undo).toEqual({ batchId: 'history-batch', expectedFingerprint: 'synthetic-fingerprint' })
  expect(snapshot.writes).toEqual(['/api/zeitguru/history/import', '/api/zeitguru/history/undo'])
  expect(errors).toEqual([])
  const result = { checks: 15, passed: ['reconstruction-history-proposal-shows-linked-dates-without-changing-totals','approved-automatic-clock-out-informational-DE-EN','ordinary-overtime-information-not-required-review','badge-counts-days-not-findings','information-only-date-keeps-readonly-day-browsing','information-mobile-layout-and-DE-EN-copy','import-refreshes-main-state', 'all-history-issues-paginate-and-filter', 'immutable-day-review-credits-targets-absence', 'missing-opening-is-period-not-overall-balance', 'work-lookup-preserves-source-duration-and-credit-delta', 'native-clock-log-remains-independent', '390px-review-and-history-layout', 'DE-EN-accounting-copy', 'undo-refresh-removes-contributions-preserves-native-and-connection'], pageErrors: errors.length }
  await writeFile(path.join(output, 'zeitguru-accounting-browser-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await browser?.close(); await server.close() }



