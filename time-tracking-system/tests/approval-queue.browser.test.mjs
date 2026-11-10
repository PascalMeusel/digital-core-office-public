import {createServer} from 'vite'
import {chromium,expect} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const output=path.resolve('../.runtime/company-deploy-20260907')
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ApprovalQueue} from '/src/ApprovalQueue.tsx';import '/src/index.css';import '/src/App.css';
const users=[{id:'alex',name:'Alex Example',email:'alex@example.invalid'},{id:'sam',name:'Sam Example',email:'sam@example.invalid'}].map(user=>({...user,role:'employee',expectedWeeklyMinutes:2400,yearlyVacationDays:30,active:true}));
const requests=Array.from({length:64},(_,i)=>({id:'request-'+i,userId:i%2?'sam':'alex',type:i%5===1?'vacation':'time_correction',status:i>=62?'approved':'pending',correctionDate:i===2?'2026-09-04':'2026-09-03',startDate:i%5===1?'2026-09-14':undefined,endDate:i%5===1?'2026-09-18':undefined,proposedStartTime:'08:14',proposedEndTime:'17:30',proposedBreakMinutes:109,reason:i===0?'Finish time was entered incorrectly. Please compare with the original record.':'Synthetic request '+i,createdAt:new Date(Date.UTC(2026,8,1,8,i)).toISOString()}));
const entry={id:'source',userId:'alex',date:'2026-09-03',startedAt:'2026-09-03T06:14:00Z',stoppedAt:'2026-09-03T16:30:00Z',manualBreakMinutes:109,breaks:[],source:'zeitguru',zeitguru:{workedMinutes:507,creditedMinutes:507,approved:true,readOnly:true,batchId:'b'}};
const accounting={days:[{date:'2026-09-03',workedMinutes:507,creditedMinutes:507,expectedMinutes:480}],initialImportReconstruction:{days:[{date:'2026-09-03',proposedStart:'08:14',proposedEnd:'17:30',proposedBreakMinutes:109}],transfers:[{fromDate:'2026-09-03',toDate:'2026-09-04',minutes:60}],unallocated:[]}};
const initial={currentUser:{id:'admin',role:'admin'},users,requests,adminTimeEntries:[entry],timeEntries:[],zeitguruAccounting:{alex:accounting},absences:[],holidays:[],dayIssues:[],summaries:[]};
window.fixture={decisions:[],originalEntries:JSON.stringify(initial.adminTimeEntries)};
function Fixture(){const [state,setState]=useState(initial),[language,setLanguage]=useState('en'),[deep,setDeep]=useState('');window.fixture.setDeep=setDeep;window.fixture.setReadOnly=value=>setState(s=>({...s,readOnly:value}));return React.createElement('div',{className:'app-shell',style:{padding:'24px',maxWidth:'1450px',margin:'auto'}},React.createElement('button',{onClick:()=>setLanguage(language==='en'?'de':'en')},'Language'),React.createElement(ApprovalQueue,{state,language,loading:false,selectedRequestId:deep,onOwnRequests:()=>{},onDecision:async(id,decision)=>{window.fixture.decisions.push({id,decision});setState(s=>({...s,requests:s.requests.map(request=>request.id===id?{...request,status:decision,decidedAt:new Date().toISOString(),decidedBy:'admin'}:request)}));return true}}))};createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
const server=await createServer({plugins:[{name:'approval-fixture',resolveId(id){if(id==='virtual:approval')return '\0'+id},load(id){if(id==='\0virtual:approval')return fixture},configureServer(s){s.middlewares.use('/approval-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/approval-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:approval"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5193,strictPort:true},logLevel:'error'})
await server.listen();const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000)
try{
 await mkdir(output,{recursive:true});await page.goto('http://127.0.0.1:5193/approval-fixture')
 await expect(page.locator('.approval-result-count')).toContainText('62 matching requests');await expect(page.locator('.approval-summary')).toHaveCount(25)
 const detail=page.locator('.approval-detail')
 await expect(detail).toContainText('8 h 27 min');await expect(detail).toContainText('7 h 27 min');await expect(detail.locator('.approval-impact')).toContainText('−1 h 0 min')
 await expect(detail).toContainText('Finish time was entered incorrectly.');await expect(detail).toContainText('Linked dates in the import proposal')
 await expect(detail).toContainText('08:14 – 18:30');await expect(detail).toContainText('1 h 49 min')
 await page.screenshot({path:path.join(output,'approval-queue-desktop.png'),fullPage:true,animations:'disabled'})
 await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page.locator('.approval-pagination')).toContainText('2 / 3');await expect(page.locator('.approval-summary')).toHaveCount(25)
 await page.getByLabel('Employee',{exact:true}).selectOption('sam');await expect(page.locator('.approval-pagination')).toContainText('1 / 2');await expect(page.locator('.approval-summary').first()).toContainText('Sam Example')
 await page.getByLabel('Request type',{exact:true}).selectOption('vacation');await expect(page.locator('.approval-summary').first()).toContainText('Vacation');await expect(detail.getByText('Weekdays excluding full public holidays').locator('..').locator('dd')).toHaveText('5')
 await page.locator('.approval-statuses button').nth(1).click();await expect(page.locator('.approval-summary')).toHaveCount(0)
 await page.locator('.approval-date-filters summary').click();await page.getByRole('button',{name:'Reset filters',exact:true}).click()
 await page.getByLabel('Search',{exact:true}).fill('Finish time');await expect(page.locator('.approval-summary')).toHaveCount(1)
 await page.getByRole('button',{name:'Approve request',exact:true}).click();expect(await page.evaluate(()=>window.fixture.decisions)).toEqual([{id:'request-0',decision:'approved'}])
 await expect(detail.getByRole('button',{name:'Approve request',exact:true})).toHaveCount(0)
 await page.evaluate(()=>window.fixture.setDeep('request-2'));await expect(detail).toContainText('04/09/2026');await expect(detail).toContainText('outside the current filters')
 await page.evaluate(()=>window.fixture.setReadOnly(true));await expect(detail.getByRole('button',{name:'Approve request',exact:true})).toBeDisabled();await expect(detail.getByRole('button',{name:'Reject request',exact:true})).toBeDisabled()
 await page.evaluate(()=>window.fixture.setReadOnly(false));await detail.getByRole('button',{name:'Reject request',exact:true}).click();expect(await page.evaluate(()=>window.fixture.decisions)).toHaveLength(2)
 await page.getByRole('button',{name:'Reset filters',exact:true}).click();await page.setViewportSize({width:390,height:844})
 await page.getByRole('button',{name:'Language',exact:true}).click();await expect(page.locator('.approval-heading')).toContainText('Prüfen & entscheiden')
 await expect(page.locator('.approval-summary')).toHaveCount(25);await page.locator('.approval-summary').first().click();await expect(detail).toContainText('Eingereichte Begründung')
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:path.join(output,'approval-queue-mobile.png'),fullPage:true,animations:'disabled'})
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(output,'approval-queue-mobile-dark.png'),fullPage:true,animations:'disabled'})
 expect(errors).toEqual([])
 const result={ok:true,checks:['62-request-pagination','oldest-first-default','employee-type-status-filter-intersection','search-and-filter-reset','current-versus-requested-work-break-and-credit-impact','linked-import-dates','only-selected-request-approved','deep-link-outside-filters','read-only-decision-disabled','explicit-rejection','390px-German-layout','dark-theme'],pageErrors:errors.length}
 await writeFile(path.join(output,'approval-queue-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close();await server.close()}


