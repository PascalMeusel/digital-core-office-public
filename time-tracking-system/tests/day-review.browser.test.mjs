import {createServer} from 'vite'
import {chromium,expect} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const output=path.resolve('../.runtime/company-deploy-20260907')
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DayReviewPanel} from '/src/DayReviewPanel.tsx';import '/src/index.css';import '/src/App.css';
const users=[{id:'own',name:'Alex Example'},{id:'two',name:'Sam Example'}];
const make=(id,date,extra={})=>({id,date,userId:'own',source:'zeitguru',rule:'insufficient_break',severity:'warning',category:'compliance',titleEn:'Recorded break may be insufficient',titleDe:'Erfasste Pause möglicherweise zu kurz',messageEn:'Compare the recorded break with the time actually taken.',messageDe:'Erfasste Pause mit der tatsächlich genommenen Pause vergleichen.',actualMinutes:15,expectedMinutes:30,suggestions:[{action:'time_correction',labelEn:'Auto-fill resolution',labelDe:'Lösung automatisch ausfüllen',draft:{type:'time_correction',correctionDate:date,reviewProposal:true}},{action:'zeitguru_history',labelEn:'Review imported day',labelDe:'Importierten Tag prüfen'}],...extra});
const issues=Array.from({length:30},(_,i)=>make('day-'+i,'2026-08-'+String(i+1).padStart(2,'0')));
issues.push(make('source','2026-08-30',{rule:'zeitguru_history_review',titleEn:'Imported source note',titleDe:'Importierter Quellhinweis',messageEn:'The source requires comparison.',messageDe:'Die Quelle muss abgeglichen werden.',suggestions:[{action:'zeitguru_history',labelEn:'Review imported day',labelDe:'Importierten Tag prüfen'}]}));
issues.push(make('other','2026-08-30',{userId:'two'}));
for(const date of ['2026-07-20','2026-07-21','2026-07-22','2026-07-23','2026-07-24'])issues.push(make(date,date,{rule:'missing_day',severity:'error',titleEn:'Expected workday has no entry',titleDe:'Erwarteter Arbeitstag ohne Eintrag'}));
issues.push(make('proposal','2026-02-02',{rule:'zeitguru_import_reconstruction',initialImportReview:true,titleEn:'Initial import correction proposal',titleDe:'Korrekturvorschlag zum Erstimport'}));
issues.push(make('old-check','2026-02-02',{rule:'daily_ten_hour_limit',initialImportReview:true,titleEn:'Historical ten-hour check',titleDe:'Historische Zehn-Stunden-Prüfung'}));
issues.push(make('info','2026-07-12',{rule:'daily_eight_hour_warning',titleEn:'Eight-hour advisory',titleDe:'Acht-Stunden-Hinweis',suggestions:[]}));
window.fixture={actions:[]};function Fixture(){const[language,setLanguage]=useState('en'),[readOnly,setReadOnly]=useState(false);window.fixture.readOnly=setReadOnly;return React.createElement('div',{className:'app-shell',style:{padding:'20px',maxWidth:'1350px',margin:'auto'}},React.createElement('button',{onClick:()=>setLanguage(language==='en'?'de':'en')},'Language'),React.createElement(DayReviewPanel,{issues,users,language,readOnly,userId:'own',onResolve:(issue,suggestion)=>window.fixture.actions.push({id:issue.id,userId:issue.userId,date:issue.date,action:suggestion.action,draft:suggestion.draft})}))};createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
const server=await createServer({plugins:[{name:'day-review-fixture',resolveId(id){if(id==='virtual:day-review')return '\0'+id},load(id){if(id==='\0virtual:day-review')return fixture},configureServer(s){s.middlewares.use('/day-review-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/day-review-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:day-review"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5194,strictPort:true},logLevel:'error'})
await server.listen();const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1350,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000)
try{
 await mkdir(output,{recursive:true});await page.goto('http://127.0.0.1:5194/day-review-fixture')
 await expect(page.locator('.day-issue-count')).toHaveText('36 days');
 await page.getByRole('button',{name:'Collapse',exact:true}).click();await expect(page.locator('.day-review-tabs')).toBeHidden();await expect(page.locator('.day-issue-count')).toBeVisible();await expect(page.getByRole('button',{name:'Expand',exact:true})).toHaveAttribute('aria-expanded','false');
 await page.reload();await expect(page.locator('.day-review-tabs')).toBeHidden();expect(await page.evaluate(()=>localStorage.getItem('dco:day-review:collapsed:own'))).toBe('true');
 await page.getByRole('button',{name:'Expand',exact:true}).click();await expect(page.locator('.day-review-tabs')).toBeVisible();
 await page.getByLabel('Search days',{exact:true}).fill('no-match');await page.getByRole('button',{name:'Collapse',exact:true}).click();await expect(page.locator('.day-issue-count')).toHaveText('36 days');await page.getByRole('button',{name:'Expand',exact:true}).click();await expect(page.getByLabel('Search days',{exact:true})).toHaveValue('no-match');await page.getByLabel('Search days',{exact:true}).fill('');
await expect(page.locator('.day-review-summary')).toHaveCount(10)
 await expect(page.locator('.day-review-summary').first()).toContainText('2 findings');await expect(page.locator('.day-review-detail .day-review-finding')).toHaveCount(2)
 await expect(page.locator('.day-review-detail footer button')).toHaveCount(1)
 await page.getByRole('button',{name:'Auto-fill resolution',exact:true}).click();expect(await page.evaluate(()=>window.fixture.actions[0])).toMatchObject({id:'day-29',userId:'own',date:'2026-08-30',action:'time_correction'})
 await page.screenshot({path:path.join(output,'day-review-desktop.png'),fullPage:true,animations:'disabled'})
 await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page.locator('.day-review-pagination')).toContainText('2 / 4')
 await page.getByLabel('Employee',{exact:true}).selectOption('two');await expect(page.locator('.day-review-summary')).toHaveCount(1);await expect(page.locator('.day-review-detail header')).toContainText('Sam Example')
 await page.getByLabel('Employee',{exact:true}).selectOption('');await page.getByLabel('Issue type',{exact:true}).selectOption('zeitguru_history_review');await expect(page.locator('.day-review-summary')).toHaveCount(1)
 await page.getByLabel('Issue type',{exact:true}).selectOption('');await page.getByLabel('Search days',{exact:true}).fill('2026-07-');await expect(page.locator('.day-review-summary')).toHaveCount(1)
 await expect(page.getByRole('button',{name:'Request vacation for this period',exact:true})).toHaveCount(1)
 await page.getByRole('button',{name:'Request vacation for this period',exact:true}).click();expect(await page.evaluate(()=>window.fixture.actions.at(-1).draft)).toMatchObject({type:'vacation',startDate:'2026-07-20',endDate:'2026-07-24'})
 await page.getByLabel('Search days',{exact:true}).fill('');await page.locator('.day-review-tabs button').nth(1).click();await expect(page.locator('.day-review-summary')).toHaveCount(1);await expect(page.locator('.day-review-context')).toContainText('not applied changes')
 await page.locator('.day-review-tabs button').nth(2).click();await expect(page.locator('.day-review-summary')).toHaveCount(2)
 await page.locator('.day-review-tabs button').nth(0).click();await page.evaluate(()=>window.fixture.readOnly(true));await expect(page.getByRole('button',{name:'Auto-fill resolution',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'View imported day',exact:true})).toBeEnabled()
 await page.evaluate(()=>window.fixture.readOnly(false));await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Language',exact:true}).click();await page.locator('.day-review-summary').first().click()
 await expect(page.locator('.day-review-detail')).toContainText('Erfasste Pause');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:path.join(output,'day-review-mobile.png'),fullPage:true,animations:'disabled'});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(output,'day-review-mobile-dark.png'),fullPage:true,animations:'disabled'})
 expect(errors).toEqual([])
 const result={ok:true,checks:['persistent-accessible-collapse','filters-preserved-and-total-visible','36-day-badge','ten-group-pagination','same-day-findings-grouped','one-import-link-per-day','selected-person-and-draft-preserved','employee-type-search-filters','missing-week-vacation-retained','proposals-separated-from-history','read-only-actions','390px-German-light-dark-layout'],pageErrors:errors.length};await writeFile(path.join(output,'day-review-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close();await server.close()}
