import {createServer} from 'vite'
import {chromium,expect} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const output=path.resolve('../.runtime/company-deploy-20260907')
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.tsx';import '/src/index.css';
const user={id:'admin',name:'Synthetic Admin',email:'admin@example.invalid',role:'admin',expectedWeeklyMinutes:2400,yearlyVacationDays:30,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,trackingStartDate:'2026-01-01',employmentTerms:[],calendarAccessUserIds:[],active:true,mustChangePassword:false};
const employee={...user,id:'employee',name:'Synthetic Employee',role:'employee',email:'employee@example.invalid'};
const summary={userId:user.id,week:{workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0},month:{workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0},year:{workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0},vacation:{yearlyDays:30,usedDays:0,remainingDays:30}};
const state={organizationTimezone:'Europe/Berlin',currentUser:user,users:[user,employee],visibleCalendarUsers:[user],shareableCalendarUsers:[],calendarGroups:[],calDavAccounts:[],externalCalendarEvents:[],customCalendarEvents:[],timeEntries:[],adminTimeEntries:[],absences:[],holidays:[],holidayOverrides:[],holidaySettings:{country:'DE',language:'de'},holidayTemplateOptions:{countries:[],states:[],regions:[]},requests:[],notifications:[],importBatches:[],userInvitations:[],backup:{dataFile:'fixture',backupDir:'fixture',nextAutomaticCheck:'fixture'},summaries:[summary],clockStatus:'off_work',clockStatuses:{admin:'off_work'},clockLocations:{},dayIssues:[{id:'long-day',userId:'employee',date:'2026-09-01',source:'zeitguru',rule:'daily_ten_hour_limit',severity:'error',category:'compliance',titleEn:'More than 10 hours recorded',titleDe:'Mehr als 10 Stunden erfasst',messageEn:'Review the recorded duration.',messageDe:'Erfasste Dauer prüfen.',actualMinutes:660,expectedMinutes:600,suggestions:[{action:'time_correction',labelEn:'Prepare correction to 10 hours',labelDe:'Korrektur auf 10 Stunden vorbereiten',draft:{type:'time_correction',correctionDate:'2026-09-01',proposedStartTime:'09:00',proposedEndTime:'19:45',proposedBreakMinutes:'45',reason:'Synthetic estimate; verify actual work.',reviewProposal:true}}]}]};
state.dayIssues.push(...['2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28'].map(date=>({id:'missing-'+date,userId:'employee',date,source:'zeitguru',rule:'missing_day',severity:'error',category:'data',titleEn:'Expected workday has no entry',titleDe:'Erwarteter Arbeitstag ohne Eintrag',messageEn:'No entry.',messageDe:'Kein Eintrag.',actualMinutes:0,expectedMinutes:480,suggestions:[{action:'absence_request',labelEn:'Prepare absence request',labelDe:'Abwesenheitsantrag vorbereiten',draft:{type:'vacation',startDate:date,endDate:date,reason:'Vacation'}}]})));
state.dayIssues.push({...state.dayIssues[0],id:'reconstruction',date:'2026-08-01',rule:'zeitguru_import_reconstruction',initialImportReview:true,severity:'info',titleEn:'Initial import correction proposal',titleDe:'Korrekturvorschlag zum Erstimport',messageEn:'Estimated start shifted to 10:00. Linked Saturday receives 60 minutes.',messageDe:'Geschätzter Beginn auf 10:00 verschoben. Verknüpfter Samstag erhält 60 Minuten.',suggestions:[{...state.dayIssues[0].suggestions[0],labelEn:'Review correction proposal',labelDe:'Korrekturvorschlag prüfen',draft:{...state.dayIssues[0].suggestions[0].draft,correctionDate:'2026-08-01',proposedStartTime:'10:00',proposedEndTime:'18:00'}}]});
window.fixture={state,calls:[]};const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options={})=>{const p=new URL(typeof input==='string'?input:input.url,location.href).pathname;const body=options.body?JSON.parse(options.body):undefined;window.fixture.calls.push({p,method:options.method||'GET',body});if(p.endsWith('/api/sso/session'))return response({token:'core-cookie-session'});if(p.endsWith('/api/state'))return response(window.fixture.state);if(p.endsWith('/api/core/modules'))return response({modules:[]});if(p.endsWith('/api/requests')){state.requests=[{...body,id:'request',userId:body.targetUserId,status:'pending',createdAt:new Date().toISOString()}];return response(state)}throw Error('Unexpected fixture route '+p)};
window.WebSocket=class extends EventTarget{static OPEN=1;readyState=1;constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')))}send(){}close(){this.readyState=3}};
localStorage.setItem('time-tracker-token','core-cookie-session');localStorage.setItem('time-tracker-language','en');localStorage.setItem('dco-suite-language','en');
createRoot(document.getElementById('root')).render(React.createElement(App,{initialState:state}));`
const server=await createServer({configFile:path.resolve('vite.config.ts'),plugins:[{name:'resolution-fixture',resolveId(id){if(id==='virtual:resolution')return '\0'+id},load(id){if(id==='\0virtual:resolution')return fixture},configureServer(server){server.middlewares.use('/resolution-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/resolution-fixture','<html><head></head><body><div id="root"></div><script type="module" src="/@id/virtual:resolution"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5192,strictPort:true},logLevel:'error'})
await server.listen();const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message))
try{
 await page.goto('http://127.0.0.1:5192/resolution-fixture')
 await page.getByRole('button',{name:'Prepare correction to 10 hours',exact:true}).click()
 const form=page.locator('.request-form-panel').filter({has:page.locator('.resolution-proposal-note')})
 await expect(form).toBeVisible();await expect(form).toContainText('Request for: Synthetic Employee')
 await expect(form.locator('input[type="time"]').nth(0)).toHaveValue('09:00');await expect(form.locator('input[type="time"]').nth(1)).toHaveValue('19:45')
 await expect(form.locator('input[type="number"]')).toHaveValue('45')
 await expect(form.locator('textarea')).toHaveValue('Synthetic estimate; verify actual work.')
 await form.locator('button[type="submit"]').click();await expect(form).toContainText('Review the proposal and confirm the actual times.')
 expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.p.endsWith('/api/requests')).length)).toBe(0)
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Deutsch',exact:true}).click()
 await expect(form).toContainText('Automatisch ausgefüllter Vorschlag');await expect(form).toContainText('Antrag für: Synthetic Employee')
 await form.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'day-resolution-mobile.png'),fullPage:true})
 await form.locator('.resolution-proposal-note input[type="checkbox"]').check()
 await form.locator('input[type="time"]').nth(1).fill('19:30')
 await form.locator('button[type="submit"]').click()
 await expect.poll(()=>page.evaluate(()=>window.fixture.calls.filter(call=>call.p.endsWith('/api/requests')).length)).toBe(1)
 const submitted=await page.evaluate(()=>window.fixture.calls.find(call=>call.p.endsWith('/api/requests')).body)
 expect(submitted).toMatchObject({targetUserId:'employee',type:'time_correction',proposedEndTime:'19:30',proposedBreakMinutes:45,reviewProposal:true,proposalConfirmed:true})
 expect(await page.evaluate(()=>window.fixture.state.currentUser.id)).toBe('admin');expect(await page.evaluate(()=>window.fixture.state.timeEntries)).toEqual([])
 await page.goto('http://127.0.0.1:5192/resolution-fixture')
 if(await page.getByRole('button',{name:'English',exact:true}).isVisible())await page.getByRole('button',{name:'English',exact:true}).click()
 await page.locator('.day-review-summary').filter({hasText:'24/08/2026'}).click()
 const group=page.locator('.day-issue-row').filter({has:page.getByRole('button',{name:'Request vacation for this period',exact:true})}).first()
 await expect(group).toContainText('5 consecutive days');await expect(page.locator('.day-issue-count')).toContainText('6 days')
 await expect(page.getByRole('button',{name:'Request vacation for this period',exact:true})).toHaveCount(1)
 await group.locator('.missing-days-individual > summary').click();await expect(group.locator('.missing-days-individual .day-issue-row')).toHaveCount(5)
 await group.locator('.missing-days-individual > summary').click()
 await expect(page.locator('.day-review-summary')).toHaveCount(2);await expect(page.locator('.day-issue-row:visible')).toHaveCount(1)
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await group.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'grouped-vacation-mobile.png'),fullPage:true})
 await page.getByRole('button',{name:'Request vacation for this period',exact:true}).click()
 const vacation=page.locator('.request-form-panel').first()
 await expect(vacation).toContainText('Request for: Synthetic Employee');await expect(vacation.locator('.resolution-proposal-note')).toHaveCount(0)
 await expect(vacation.getByRole('textbox',{name:'Start date',exact:true})).toHaveValue('24/08/2026');await expect(vacation.getByRole('textbox',{name:'End date',exact:true})).toHaveValue('28/08/2026')
 await vacation.locator('button[type="submit"]').click()
 await expect.poll(()=>page.evaluate(()=>window.fixture.calls.filter(call=>call.p.endsWith('/api/requests')).length)).toBe(1)
 expect(await page.evaluate(()=>window.fixture.calls.find(call=>call.p.endsWith('/api/requests')).body)).toMatchObject({type:'vacation',startDate:'2026-08-24',endDate:'2026-08-28',targetUserId:'employee'})
 await page.goto('http://127.0.0.1:5192/resolution-fixture')
 if(await page.getByRole('button',{name:'English',exact:true}).isVisible())await page.getByRole('button',{name:'English',exact:true}).click()
 await expect(page.locator('.day-issue-count')).toContainText('6 days')
 await page.locator('.day-review-tabs button').nth(1).click()
 const migration=page.locator('.day-review-detail')
 await expect(page.locator('.day-review-context')).toContainText('Estimated corrections, not applied changes.')
 await expect(migration).toContainText('Linked Saturday receives 60 minutes.')
 await page.setViewportSize({width:390,height:844});await migration.scrollIntoViewIfNeeded()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:path.join(output,'import-reconstruction-mobile.png'),fullPage:true})
 await migration.getByRole('button',{name:'Review correction proposal',exact:true}).click()
 await expect(form.locator('input[type="time"]').nth(0)).toHaveValue('10:00')
 await expect(form).toContainText('Request for: Synthetic Employee')
 await form.locator('button[type="submit"]').click()
 await expect(form).toContainText('Review the proposal and confirm the actual times.')
 expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.p.endsWith('/api/requests')).length)).toBe(0)
 await page.getByRole('button',{name:'Admin view',exact:true}).click()
 await expect(page.locator('.approval-queue')).toBeVisible()
 await expect(page.locator('.approval-heading')).toContainText('Review & approve')
 expect(errors).toEqual([])
 const result={ok:true,checks:['initial-import-proposals-separated-from-unresolved-badge','reconstruction-phone-layout-and-disclosure','reconstruction-targeted-draft-requires-confirmation','import-review-opens-prefilled-request','administrator-target-preserved','unconfirmed-proposal-not-submitted','editable-times-submitted-after-confirmation','German-phone-layout','submission-keeps-clock-records-unchanged','whole-week-one-vacation-button','individual-days-expandable','badge-retains-day-count','phone-group-layout','five-day-vacation-request-submits-once'],pageErrors:errors.length}
 await writeFile(path.join(output,'day-resolution-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close();await server.close()}



