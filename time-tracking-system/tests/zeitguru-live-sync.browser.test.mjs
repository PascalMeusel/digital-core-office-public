import {createServer,transformWithEsbuild} from 'vite'
import {chromium,firefox,expect} from '@playwright/test'
import {writeFile,mkdir} from 'node:fs/promises'
const outputDirectory='../.runtime/zeitguru-delivery-verification'
await mkdir(outputDirectory,{recursive:true})
const fixture=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ZeitguruPanel}from'/src/ZeitguruPanel.tsx';import'/src/index.css';import'/src/App.css';
window.fixture={syncs:0,fail:false,loginFail:false};const initial={available:true,enabled:false,generation:0,clockRevision:0,requiresAttention:false,counts:{queued:0,sending:0,confirmed:0,retryable_failure:0,reconciliation_required:0,authentication_required:0,cancelled:0}};
function Fixture(){const[status,setStatus]=useState(initial),[clock,setClock]=useState('off_work'),[language,setLanguage]=useState('en');window.fixture.configure=(changes,nextClock='off_work')=>{setStatus({...initial,...changes,counts:{...initial.counts,...changes.counts}});setClock(nextClock)};window.fixture.setLanguage=setLanguage;const api={login:async()=>{if(window.fixture.loginFail)throw Error('Synthetic credentials rejected');return {challengeId:'synthetic',expiresAt:Date.now()+180000,identity:{name:'Synthetic Employee',email:'synthetic@example.test'},branches:[{id:'office',name:'Office'}],remoteStatus:'on_break',canActivate:true}},connect:async()=>{const next={...status,enabled:true,generation:status.generation+1};setStatus(next);setClock('on_break');return next},synchronize:async()=>{window.fixture.syncs++;if(window.fixture.fail)throw Error('Synthetic connection unavailable');return status},historyStatus:async()=>({available:false}),disconnect:async()=>initial};return <main className='app-shell'><section className='panel clock-panel'><ZeitguruPanel status={status} api={api} language={language} clockStatus={clock} readOnly={false}/></section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
const server=await createServer({plugins:[{name:'live-sync-fixture',resolveId(id){if(id==='virtual:zg-sync')return '\0'+id},async load(id){if(id==='\0virtual:zg-sync')return (await transformWithEsbuild(fixture,'fixture.tsx',{loader:'tsx',jsx:'automatic'})).code},configureServer(s){s.middlewares.use('/zg-sync-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/zg-sync-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:zg-sync"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5200,strictPort:true},logLevel:'error'})
await server.listen();const results=[]
try{for(const [name,type] of [['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch(),page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000)
 try{
 await page.clock.install();await page.goto('http://127.0.0.1:5200/zg-sync-fixture');await page.locator('.zeitguru-panel > summary').click()
 await page.locator('input[type=email]').fill('synthetic@example.test');await page.locator('input[type=password]').fill('synthetic-password')
 await page.getByRole('button',{name:'Verify credentials',exact:true}).click();await expect(page.getByText('Break running',{exact:true})).toBeVisible()
 await page.locator('select').selectOption('office');await page.locator('input[type=checkbox]').check();await expect(page.getByRole('button',{name:'Connect Zeitguru',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Connect Zeitguru',exact:true}).click()
 const sync=page.getByRole('button',{name:'Sync with Zeitguru now',exact:true});await expect(sync).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.fixture.syncs)).toBeGreaterThan(0)
 const before=await page.evaluate(()=>window.fixture.syncs);await sync.click();await expect.poll(()=>page.evaluate(()=>window.fixture.syncs)).toBeGreaterThan(before)
 await page.evaluate(()=>window.fixture.fail=true);await sync.click();await expect(page.getByText('Synthetic connection unavailable',{exact:true})).toBeVisible();await page.evaluate(()=>window.fixture.fail=false);await sync.click();await expect(page.getByText('Synthetic connection unavailable',{exact:true})).toHaveCount(0)
 const polled=await page.evaluate(()=>window.fixture.syncs);await page.clock.fastForward(31000);await expect.poll(()=>page.evaluate(()=>window.fixture.syncs)).toBeGreaterThan(polled)
 const summary=page.locator('.zeitguru-panel > summary')
 // A prior successful action must not mask a pending break-end delivery.
 await page.evaluate(()=>window.fixture.configure({enabled:true,generation:1,counts:{confirmed:2,queued:1},latestOperation:{id:'break-end',clientOperationId:'break-end-request',action:'stop_break',status:'queued',updatedAt:Date.now()}}))
 await expect(summary).toContainText('Saved in DCO · Delivery pending');await expect(summary).not.toContainText('Confirmed by Zeitguru')
 await expect(sync).toBeDisabled()
 // Disconnect keeps unresolved history visible, but cannot offer checks without credentials.
 await page.evaluate(()=>window.fixture.configure({generation:2,requiresAttention:true,counts:{confirmed:2,reconciliation_required:1},latestOperation:{id:'break-end',clientOperationId:'break-end-request',action:'stop_break',status:'reconciliation_required',updatedAt:Date.now()},synchronization:{checkedAt:Date.now(),error:'Stale provider check'}}))
 await expect(summary).toContainText('Not connected · Clock actions saved only in DCO')
 await expect(summary).toContainText('Earlier clock actions need checking')
 await expect(page.getByText('New work and break actions are saved only in DCO and are not sent to Zeitguru.',{exact:true})).toBeVisible()
 await expect(page.getByText('Delivery is not confirmed. Check your times in Zeitguru; sending again could create duplicate entries.',{exact:true})).toBeVisible()
 await expect(page.getByText('Stale provider check',{exact:true})).toHaveCount(0)
 await expect(page.getByRole('button',{name:'Check delivery status',exact:true})).toHaveCount(0)
 await expect(page.getByRole('button',{name:'Confirm manual review',exact:true})).toHaveCount(0)
 await expect(page.getByRole('link',{name:'Open Zeitguru (new tab)',exact:true})).toBeVisible()
 await page.locator('input[type=email]').fill('synthetic@example.test');await page.locator('input[type=password]').fill('synthetic-password')
 await expect(page.getByRole('button',{name:'Verify credentials',exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'Verify credentials',exact:true}).click();await page.locator('input[type=checkbox]').check()
 await expect(page.getByRole('button',{name:'Connect Zeitguru',exact:true})).toBeEnabled()
 // Both languages and themes keep the longer DCO-only warning readable on mobile.
 await page.evaluate(()=>window.fixture.setLanguage('de'))
 await expect(summary).toContainText('Nicht verbunden · Stempelungen nur in DCO')
 for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:outputDirectory+'/'+name+'-disconnected-390-'+theme+'.png',fullPage:true})}
 await page.evaluate(()=>window.fixture.setLanguage('en'));await summary.click();await summary.click()
 // Network-check failures stay visible in the collapsed summary; form errors remain separate.
 await page.evaluate(()=>window.fixture.configure({enabled:true,generation:3,counts:{confirmed:3},latestOperation:{id:'break-end',clientOperationId:'break-end-request',action:'stop_break',status:'confirmed',updatedAt:Date.now()}}))
 await expect(summary).toContainText('Confirmed by Zeitguru');await page.evaluate(()=>window.fixture.fail=true);await sync.click()
 await expect(summary).toContainText('Zeitguru synchronization unavailable');await expect(page.locator('.form-error')).toHaveCount(0)
 await summary.click();await expect(summary).toContainText('Zeitguru synchronization unavailable');await summary.click()
 await page.evaluate(()=>window.fixture.configure({generation:4}));await expect(summary).toContainText('Not connected · Clock actions saved only in DCO')
 await expect(page.getByText('Synthetic connection unavailable',{exact:true})).toHaveCount(0);await expect(summary).not.toContainText('Zeitguru synchronization unavailable')
 await page.evaluate(()=>{window.fixture.fail=false;window.fixture.loginFail=true;window.fixture.configure({enabled:true,generation:5,requiresAttention:true,counts:{authentication_required:1}})})
 await page.locator('input[type=email]').fill('synthetic@example.test');await page.locator('input[type=password]').fill('synthetic-password');await page.getByRole('button',{name:'Verify credentials',exact:true}).click()
 await expect(page.getByText('Synthetic credentials rejected',{exact:true})).toBeVisible();await sync.click()
 await expect(page.getByText('Synthetic connection unavailable',{exact:true})).toHaveCount(0)
 await expect(page.getByText('Synthetic credentials rejected',{exact:true})).toBeVisible()
 await page.clock.fastForward(31000);await expect(page.getByText('Synthetic credentials rejected',{exact:true})).toBeVisible()
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);results.push({browser:name,ok:true,checks:['active-break-connect','immediate-sync','manual-sync','inline-error-and-retry','periodic-sync','pending-break-end-not-confirmed','disconnected-DCO-only-unresolved-history','disconnected-reconnect-available','stale-sync-error-hidden','collapsed-sync-failure','form-error-preserved','mobile-themes-and-translations']})
 }finally{await browser.close()}
}}finally{await server.close()}
await writeFile(outputDirectory+'/zeitguru-live-sync-browser.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results))
