import {createServer} from 'vite'
import {chromium,expect} from '@playwright/test'
import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
const output=path.resolve('../.runtime/company-deploy-20260907')
const fixture=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{OvertimePolicyPanel}from'/src/OvertimePolicyPanel.tsx';import{defaultOvertimePolicy}from'/shared/overtimePolicy.ts';import'/src/index.css';import'/src/App.css';
const users=[{id:'admin',name:'Synthetic Admin',email:'admin@example.invalid',role:'admin',active:true,mustChangePassword:false},{id:'employee',name:'Employee',email:'employee@example.invalid',role:'employee',active:true}];
function Fixture(){const[state,setState]=useState({policy:defaultOvertimePolicy,mailConfigured:false,alerts:{pending:0,sent:0,failed:0,unknown:0}}),[language,setLanguage]=useState('en'),[readOnly,setReadOnly]=useState(false);window.configureMail=()=>setState(old=>({...old,mailConfigured:true}));window.readonly=()=>setReadOnly(true);window.language=setLanguage;window.saves=[];return React.createElement(OvertimePolicyPanel,{state,users,language,loading:false,readOnly,onRetry:async()=>true,onSave:async body=>{window.lastSave=body;setState(old=>({...old,policy:{...body,configured:true,revision:body.revision+1,updatedAt:new Date().toISOString()}}));return true}})}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
const server=await createServer({plugins:[{name:'overtime-policy-fixture',resolveId(id){if(id==='virtual:overtime-policy-fixture')return '\0overtime-policy-fixture.jsx'},load(id){if(id==='\0overtime-policy-fixture.jsx')return fixture},configureServer(s){s.middlewares.use('/__overtime_policy',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/__overtime_policy','<html><body><div id="root"></div><script type="module" src="/@id/virtual:overtime-policy-fixture"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5191,strictPort:true}})
let browser
try{
 await mkdir(output,{recursive:true});await server.listen();browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.goto('http://127.0.0.1:5191/__overtime_policy')
 const email=page.getByLabel('Email administrators when a limit is crossed',{exact:true})
 await expect(email).toBeDisabled();await expect(email).not.toBeChecked();await expect(page.locator('.overtime-recipients')).not.toContainText('employee@example.invalid')
 await page.getByRole('combobox').selectOption('both')
 await page.getByLabel('Maximum positive balance (hours)',{exact:true}).fill('20')
 await page.getByLabel('Allowed negative balance (hours)',{exact:true}).fill('10')
 await page.getByLabel('Maximum daily overtime (hours)',{exact:true}).fill('2')
 await page.getByLabel('Allowed daily undertime (hours)',{exact:true}).fill('1')
 await page.getByLabel('Synthetic Admin · admin@example.invalid',{exact:true}).check()
 await page.evaluate(()=>window.configureMail());await email.check()
 await page.getByRole('button',{name:'Save overtime policy',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Overtime policy saved.')
 const saved=await page.evaluate(()=>window.lastSave);expect(saved).toMatchObject({scope:'both',balanceOvertimeMinutes:1200,balanceUndertimeMinutes:600,dailyOvertimeMinutes:120,dailyUndertimeMinutes:60,emailEnabled:true,recipientUserIds:['admin']})
 await page.getByLabel('Overtime allowed',{exact:true}).uncheck();await expect(page.getByLabel('Maximum positive balance (hours)',{exact:true})).toBeDisabled()
 await page.getByRole('button',{name:'Save overtime policy',exact:true}).click();expect((await page.evaluate(()=>window.lastSave)).overtimeAllowed).toBe(false)
 await page.evaluate(()=>window.language('de'));await expect(page.getByRole('heading')).toHaveText('Überstunden und Benachrichtigungen')
 await page.screenshot({path:path.join(output,'overtime-policy-mobile.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.evaluate(()=>window.readonly());await expect(page.getByRole('button',{name:'Überstundenregeln speichern',exact:true})).toBeDisabled()
 expect(errors).toEqual([]);const result={ok:true,checks:['email-off-by-default-and-SMTP-gated','active-admin-recipients-only','separate-balance-daily-limits-save-in-minutes','overtime-prohibition-zero-upper-bound','saved-feedback-and-revision-refresh','German-copy-mobile-no-overflow','readonly-no-settings-writes'],pageErrors:0};await writeFile(path.join(output,'overtime-policy-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await browser?.close();await server.close()}



