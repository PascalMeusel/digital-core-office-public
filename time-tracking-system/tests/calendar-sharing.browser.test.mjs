import {createServer} from 'vite'
import {chromium,expect} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const output=path.resolve('../.runtime/company-deploy-20260907')
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CalendarSharingPanel} from '/src/CalendarSharingPanel.tsx';import '/src/index.css';import '/src/App.css';
const initial=Array.from({length:32},(_,i)=>({id:'person-'+i,name:'Colleague '+String(i).padStart(2,'0'),email:'person'+i+'@example.invalid',active:true}));initial.push({id:'inactive',name:'Inactive Colleague',email:'inactive@example.invalid',active:false});
window.fixture={calls:[],fail:false};function Fixture(){const[users,setUsers]=useState(initial),[saved,setSaved]=useState(['person-0','person-1']),[disabled,setDisabled]=useState(false),[language,setLanguage]=useState('en');window.fixture.refresh=()=>{setUsers(current=>current.map(user=>({...user})));setSaved(current=>[...current])};window.fixture.disable=setDisabled;window.fixture.language=setLanguage;window.fixture.restrict=()=>setUsers(current=>current.filter(user=>user.id!=='person-2'));return React.createElement('div',{style:{maxWidth:'440px',padding:'16px',margin:'auto'}},React.createElement(CalendarSharingPanel,{users,savedIds:saved,language,disabled,onSave:async(ids)=>{window.fixture.calls.push(ids);if(window.fixture.fail)return false;setSaved(ids);return true}}))};createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
const server=await createServer({plugins:[{name:'sharing-fixture',resolveId(id){if(id==='virtual:sharing')return '\0'+id},load(id){if(id==='\0virtual:sharing')return fixture},configureServer(s){s.middlewares.use('/sharing-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/sharing-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:sharing"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5195,strictPort:true},logLevel:'error'})
await server.listen();const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000)
try{
 await mkdir(output,{recursive:true});await page.goto('http://127.0.0.1:5195/sharing-fixture')
 const search=page.getByRole('searchbox'),save=page.getByRole('button',{name:'Save access',exact:true})
 await expect(page.locator('.calendar-sharing-granted li')).toHaveCount(2);await expect(save).toBeDisabled()
 await search.fill('PERSON2@EXAMPLE.INVALID');await expect(page.locator('.calendar-sharing-results li')).toHaveCount(1)
 await page.getByRole('button',{name:'Grant access to Colleague 02',exact:true}).click()
 await page.evaluate(()=>window.fixture.refresh());await expect(page.locator('.calendar-sharing-granted li')).toHaveCount(3);await expect(save).toBeEnabled()
 await search.fill('no match');await save.click();expect(await page.evaluate(()=>window.fixture.calls.at(-1))).toEqual(['person-0','person-1','person-2']);await expect(page.locator('.calendar-sharing-status')).toContainText('saved')
 await page.getByRole('button',{name:'Revoke access for Colleague 00',exact:true}).click();await save.click();expect(await page.evaluate(()=>window.fixture.calls.at(-1))).toEqual(['person-1','person-2'])
 await search.fill('Colleague');await expect(page.locator('.calendar-sharing-results li')).toHaveCount(10);await page.getByRole('button',{name:'Show more people',exact:true}).click();await expect(page.locator('.calendar-sharing-results li')).toHaveCount(20)
 await search.fill('inactive');await expect(page.locator('.calendar-sharing-results li')).toHaveCount(0)
 await search.fill('Colleague 03');await page.getByRole('button',{name:'Grant access to Colleague 03',exact:true}).click();await page.evaluate(()=>window.fixture.fail=true);await save.click();await expect(page.getByRole('alert')).toContainText('Could not save');await expect(page.locator('.calendar-sharing-granted li')).toHaveCount(3)
 await page.evaluate(()=>window.fixture.fail=false);await save.click();await expect(page.locator('.calendar-sharing-status')).toContainText('saved')
 await page.getByRole('button',{name:'Revoke access for Colleague 01',exact:true}).click();await page.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(page.locator('.calendar-sharing-granted li')).toHaveCount(3);await expect(save).toBeDisabled()
 await page.evaluate(()=>window.fixture.disable(true));await expect(page.getByRole('button',{name:'Revoke access for Colleague 01',exact:true})).toBeDisabled();await page.evaluate(()=>window.fixture.disable(false))
 await page.getByRole('button',{name:'Revoke access for Colleague 03',exact:true}).click();await page.evaluate(()=>window.fixture.restrict());await save.click();expect(await page.evaluate(()=>window.fixture.calls.at(-1))).toEqual(['person-1'])
 await search.fill('Colleague');await page.screenshot({path:path.join(output,'calendar-sharing-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.fixture.language('de'));await expect(page.getByRole('searchbox')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:path.join(output,'calendar-sharing-mobile.png'),fullPage:true});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(output,'calendar-sharing-mobile-dark.png'),fullPage:true});expect(errors).toEqual([])
 const result={ok:true,checks:['existing-shares','case-insensitive-email-search','draft-survives-poll','filtered-save-preserves-hidden-grants','revoke','bounded-results','inactive-excluded','save-failure-and-retry','discard','read-only','removed-eligibility-excluded-on-save','German-mobile-light-dark'],pageErrors:errors.length};await writeFile(path.join(output,'calendar-sharing-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser.close();await server.close()}
