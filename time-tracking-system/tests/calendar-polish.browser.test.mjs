// Run from the Time project directory. All accounts, events and responses are synthetic.
import {createServer} from 'vite'
import {chromium,firefox,expect} from '@playwright/test'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import {checkCalendarScrolling} from './calendarScrollChecks.mjs'

const output=path.resolve('../.runtime/company-deploy-20260907/calendar-scroll-r49')
mkdirSync(output,{recursive:true})
const seed=`const user={id:'synthetic-calendar-user',name:'Synthetic Focus Employee',email:'calendar@example.invalid',role:'employee',active:true,mustChangePassword:false,expectedWeeklyMinutes:2400,yearlyVacationDays:30,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,trackingStartDate:'2026-09-09',employmentTerms:[],calendarAccessUserIds:[]}
const totals={workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0}
const state={currentUser:user,users:[user],visibleCalendarUsers:[user],shareableCalendarUsers:[],calendarGroups:[],calDavAccounts:[],externalCalendarEvents:[],customCalendarEvents:[],timeEntries:[],absences:[],holidays:[],holidayOverrides:[],holidaySettings:{country:'DE',language:'en'},holidayTemplateOptions:{countries:[],states:[],regions:[]},requests:[],notifications:[],importBatches:[],userInvitations:[],backup:{dataFile:'',backupDir:'',nextAutomaticCheck:''},summaries:[{userId:user.id,week:totals,month:totals,year:totals,vacation:{yearlyDays:30,usedDays:0,remainingDays:30}}],clockStatus:'off_work',clockStatuses:{[user.id]:'off_work'},clockLocations:{},dayIssues:[],organizationTimezone:'Europe/Berlin',serverTime:new Date().toISOString()}`
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import '/src/index.css';
${seed}
localStorage.clear();localStorage.setItem('time-tracker-token','synthetic-calendar-token');localStorage.setItem('digital-core-office.language','de');
localStorage.setItem('digital-core-office.theme',new URLSearchParams(location.search).get('theme')||'light');
user.name='Alex Beispiel';const other={...user,id:'other',name:'Andere Person'};state.users=[user,other];state.visibleCalendarUsers=[user,other];
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function makeEvents(count,isAllDay=true){return Array.from({length:count},(_,i)=>({id:'event-'+i,userId:i===999?other.id:user.id,title:count>=1000&&i===0?'LangerTitelOhneLeerzeichen'.repeat(6).slice(0,140):'Teamtermin '+String(i).padStart(4,'0'),description:'Details zum Termin',date,isAllDay,startTime:'09:00',endTime:'10:00',shareWithCalendarUsers:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))}
state.customCalendarEvents=makeEvents(3);
state.clockStatus='working';state.clockStatuses[user.id]='working';state.timeEntries=[{id:'synthetic-work',userId:user.id,date,startedAt:new Date(Date.now()-3600000).toISOString(),breaks:[],source:'clock',workLocation:'office'}];
window.fixture={state,date,writes:[],fail:false,holdLocation:false,releaseLocation:null,refresh:()=>window.dispatchEvent(new Event('online')),setEvents:(count,allDay=true)=>{state.customCalendarEvents=makeEvents(count,allDay);window.fixture.refresh()}};
window.fetch=async(input,options={})=>{const url=String(input),method=options.method||'GET';
 if(url.includes('/api/exports/calendar-ics'))return new Response('BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nEND:VCALENDAR\\r\\n',{headers:{'Content-Type':'text/calendar','Content-Disposition':'attachment; filename="synthetic-calendar.ics"'}});
 if(url.includes('/api/exports/time-csv'))return new Response('Date;Worked hours\\n'+date+';8\\n',{headers:{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="calendar-check.csv"'}});
 if(url.includes('/api/clock/location')&&window.fixture.holdLocation)await new Promise(resolve=>window.fixture.releaseLocation=resolve);
 if(method!=='GET'){
  const body=options.body?JSON.parse(options.body):{};window.fixture.writes.push({url,method,body});
  if(window.fixture.fail)return new Response(JSON.stringify({message:'Synthetic save failure'}),{status:500,headers:{'Content-Type':'application/json'}});
  if(url.includes('/api/calendar-events/')){const id=url.split('/').at(-1);if(method==='DELETE')state.customCalendarEvents=state.customCalendarEvents.filter(item=>item.id!==id);else state.customCalendarEvents=state.customCalendarEvents.map(item=>item.id===id?{...item,...body}:item)}
 }
 state.serverTime=new Date().toISOString();return new Response(JSON.stringify(state),{headers:{'Content-Type':'application/json'}})
};
class IdleSocket extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;send(){}close(){this.readyState=3}};window.WebSocket=IdleSocket;
createRoot(document.getElementById('root')).render(React.createElement(App,{initialState:state}));`
const server=await createServer({cacheDir:path.join(output,'vite-cache'),plugins:[{
 name:'calendar-polish-fixture',resolveId(id){if(id==='virtual:calendar-polish')return '\0'+id},load(id){if(id==='\0virtual:calendar-polish')return fixture},
 configureServer(vite){vite.middlewares.use('/calendar-polish',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/calendar-polish','<html><body><div id="root"></div><script type="module" src="/@id/virtual:calendar-polish"></script></body></html>'))})}
}],define:{'import.meta.env.VITE_CORE_URL':JSON.stringify(''),'import.meta.env.VITE_API_URL':JSON.stringify('/synthetic'),'import.meta.env.VITE_SIMPLE_MODE':JSON.stringify('false')},server:{host:'127.0.0.1',port:5197,strictPort:true},logLevel:'error'})
const finish=async(page)=>{await page.evaluate(()=>document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).forEach(a=>a.finish()));await page.waitForTimeout(30)}
const geometry=elements=>elements.map(el=>{const r=el.getBoundingClientRect();return{width:r.width,height:r.height}})
const results=[]
await server.listen()
try{for(const [name,type]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch()
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:960}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000)
  await page.goto(`http://127.0.0.1:5197/calendar-polish?theme=${width===390?'dark':'light'}`)
  await expect(page.locator('.clock-panel')).toBeVisible()
  const exportPanel=page.locator('.time-export-panel'),summary=exportPanel.locator(':scope > summary')
  const closedHeight=(await exportPanel.boundingBox()).height
  await summary.click()
  const animation=await exportPanel.evaluate(el=>{const a=el.getAnimations().find(a=>a.effect.getKeyframes().some(frame=>'height' in frame));if(!a)return null;a.pause();a.currentTime=110;return{height:el.getBoundingClientRect().height,duration:a.effect.getTiming().duration}})
  expect(animation?.duration).toBe(220);expect(animation.height).toBeGreaterThan(closedHeight)
  await finish(page)
  expect((await exportPanel.boundingBox()).height).toBeGreaterThan(animation.height)
  // Reversing while in flight must end in the last requested state.
  await summary.evaluate(el=>{el.click();el.click();el.click()});await finish(page);await expect(exportPanel).not.toHaveAttribute('open','')
  await summary.focus();await page.keyboard.press('Enter');await finish(page)
  await page.evaluate(()=>window.fixture.holdLocation=true)
  await page.locator('.clock-location-control button').first().click();await page.getByRole('option').nth(1).click()
  await expect.poll(()=>page.evaluate(()=>typeof window.fixture.releaseLocation)).toBe('function')
  const exportButton=exportPanel.getByRole('button',{name:'CSV exportieren',exact:true})
  await expect(exportButton).toBeEnabled()
  const download=page.waitForEvent('download');await exportButton.click();const file=await download
  expect(await file.failure()).toBeNull();expect(readFileSync(await file.path(),'utf8')).toContain(';8\n')
  await page.evaluate(()=>{window.fixture.holdLocation=false;window.fixture.releaseLocation?.()})
  const review=page.locator('.day-review-panel'),region=review.locator(':scope > .animated-region')
  await review.getByRole('button',{name:'Einklappen',exact:true}).click()
  expect(await region.evaluate(el=>el.getAnimations().length)).toBe(1);await finish(page);await expect(region).toBeHidden()
  await review.getByRole('button',{name:'Aufklappen',exact:true}).click();await finish(page);await expect(region).toBeVisible()

  await page.getByRole('button',{name:'Kalender',exact:true}).click()
  const day=page.locator('.calendar-day').filter({has:page.locator('.calendar-event-button')}).first()
  await expect(day.locator('.calendar-event-button')).toHaveCount(3)
  const baseline=await page.locator('.calendar-day').evaluateAll(geometry)
  await page.evaluate(()=>window.fixture.setEvents(1000))
  await expect(page.locator('.calendar-more-button').first()).toContainText('+997')
  expect(await page.locator('.calendar-day').evaluateAll(geometry)).toEqual(baseline)
  await expect(page.locator('.custom-event-list > .custom-event-row')).toHaveCount(10)
  const legend=await page.locator('.calendar-legend').boundingBox(),grid=await page.locator('.calendar-viewport').boundingBox()
  expect(legend.y).toBeGreaterThanOrEqual(grid.y+grid.height-1)
  const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('.calendar-layout *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,16).map(el=>({className:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))}))
  if(overflow.scroll>overflow.width)console.log(JSON.stringify(overflow))
  expect(overflow.scroll<=overflow.width).toBe(true)
  await page.locator('.calendar-panel').screenshot({path:path.join(output,`calendar-${name}-${width}.png`)})
  await page.locator('.calendar-more-button').first().click()
  const agenda=page.locator('dialog.calendar-agenda-modal')
  await expect(agenda.locator('.calendar-agenda-row')).toHaveCount(25)
  await agenda.getByRole('searchbox').fill('0042');await expect(agenda.locator('.calendar-agenda-row')).toHaveCount(1)
  await agenda.getByRole('button',{name:'Bearbeiten',exact:true}).click()
  const editor=page.locator('dialog.custom-event-modal'),title=editor.getByRole('textbox').first()
  await expect(title).toHaveValue('Teamtermin 0042')
  await title.fill('Entwurf bleibt erhalten');await page.evaluate(()=>window.fixture.refresh());await page.waitForTimeout(80)
  await expect(title).toHaveValue('Entwurf bleibt erhalten')
  await editor.getByRole('checkbox').first().uncheck();await finish(page)
  const times=editor.locator('input[type=time]');await times.first().fill('11:00')
  await expect(editor.getByRole('button',{name:'Speichern',exact:true})).toBeDisabled()
  await times.nth(1).fill('12:00')
  await page.screenshot({path:path.join(output,`editor-${name}-${width}.png`)})
  await editor.getByRole('button',{name:'Speichern',exact:true}).click();await expect(editor).toHaveCount(0)
  const writes=await page.evaluate(()=>window.fixture.writes)
  expect(writes.find(item=>item.url.endsWith('/event-42'))?.body.title).toBe('Entwurf bleibt erhalten')
  // Delete is explicitly destructive in the editor and in the existing row confirmation.
  await day.locator('.calendar-event-button').first().click()
  const deleteButton=editor.getByRole('button',{name:'Termin löschen',exact:true})
  const colors=await deleteButton.evaluate(el=>({actual:getComputedStyle(el).color,expected:getComputedStyle(document.documentElement).getPropertyValue('--danger-text').trim()}))
  expect(await deleteButton.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(await editor.getByRole('button',{name:'Speichern',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor))
  expect(colors.actual).not.toBe('rgb(255, 255, 255)')
  const deleteCount=await page.evaluate(()=>window.fixture.writes.filter(item=>item.method==='DELETE').length)
  await deleteButton.click();await finish(page)
  expect(await page.evaluate(()=>window.fixture.writes.filter(item=>item.method==='DELETE').length)).toBe(deleteCount)
  await editor.getByRole('button',{name:'Endgültig löschen',exact:true}).click();await expect(editor).toHaveCount(0)
  expect(await page.evaluate(()=>window.fixture.writes.filter(item=>item.method==='DELETE').length)).toBe(deleteCount+1)
  await page.locator('.custom-event-actions button[title="Termin löschen"]').first().click()
  const confirm=page.locator('.modal-backdrop [role=dialog]')
  await expect(confirm.getByRole('button',{name:'Termin löschen',exact:true})).toHaveClass(/danger-button/)
  await confirm.getByRole('button',{name:'Abbrechen',exact:true}).click()

  await page.evaluate(()=>window.fixture.setEvents(1000))
  await page.locator('.calendar-view-switch').getByRole('button',{name:'Woche',exact:true}).click()
  const allDayGeometry=await page.locator('.timed-all-day-cell').evaluateAll(geometry)
  expect(allDayGeometry.every(cell=>cell.height===88)).toBe(true)
  await page.evaluate(()=>window.fixture.setEvents(1000,false))
  await expect(page.locator('.calendar-time-block')).toHaveCount(3)
  expect(await page.locator('.timed-all-day-cell').evaluateAll(geometry)).toEqual(allDayGeometry)
  await page.locator('.timed-day-header .calendar-more-button').click();await agenda.getByRole('searchbox').fill('0999')
  await expect(agenda.locator('.calendar-agenda-row')).toHaveCount(1);await expect(agenda.getByRole('button',{name:'Bearbeiten',exact:true})).toHaveCount(0)
  await agenda.getByRole('button',{name:'Schließen',exact:true}).focus();await page.keyboard.press('Escape');await expect(agenda).toHaveCount(0)
  await page.evaluate(()=>{window.fixture.state.customCalendarEvents.push({...window.fixture.state.customCalendarEvents[1],id:'isolated',title:'Separater später Termin',startTime:'16:00',endTime:'17:00'});window.fixture.refresh()})
  await expect(page.locator('.calendar-time-block')).toHaveCount(4)
  expect((await page.locator('.calendar-time-block').filter({hasText:'Separater später Termin'}).boundingBox()).width).toBeGreaterThan((await page.locator('.calendar-time-block').first().boundingBox()).width*2)
  await page.evaluate(()=>window.fixture.setEvents(0))
  await expect(page.locator('.calendar-time-block')).toHaveCount(0)
  await checkCalendarScrolling(page,page,path.join(output,`calendar-scroll-${name}-${width}.png`))
  await page.getByRole('button',{name:'Übersicht',exact:true}).click()
  await page.emulateMedia({reducedMotion:'reduce'})
  await exportPanel.locator(':scope > summary').click()
  expect(await exportPanel.evaluate(el=>el.getAnimations().length)).toBe(0)
  expect(errors).toEqual([])
  results.push({browser:name,width,fullDayAndWeekScroll:true,stickyHeadingAndAxis:true,refreshPreservesScroll:true,quietCalendarExport:true,animationReversalAndKeyboard:true,reducedMotion:true,independentCsvDownload:true,thousandEventsStable:true,boundedAgendaAndOwnList:true,legendAtBottom:true,editorDraftSurvivesRefresh:true,validatedSave:true,redConfirmedDelete:true,foreignEventReadOnly:true})
  await page.close()
 }}finally{await browser.close()}
}}finally{await server.close()}
writeFileSync(path.join(output,'calendar-verification.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results))
