// Run from core-service: node tests/password-reset.browser.test.mjs
import {createServer} from 'vite'
import {chromium,firefox,expect} from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
import {writeFileSync,mkdirSync} from 'node:fs'
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';
localStorage.setItem('digital-core-office.language','en');window.fixture={calls:[],expired:false,user:null};
window.fetch=async(input,options={})=>{const path=new URL(String(input),location.href).pathname,body=options.body?JSON.parse(options.body):null;window.fixture.calls.push({path,body});const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/core/modules')return json({modules:[]});if(path==='/api/core/session')return window.fixture.user?json({user:window.fixture.user,modules:[]}):json({message:'Sign in'},401);
if(path.endsWith('/qr-login/challenges'))return json({token:'synthetic-qr',expiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/qr-login/challenges/claim'))return json({pending:true},202);
if(path.endsWith('/password-reset/request'))return json({accepted:true});if(path.endsWith('/password-reset/complete'))return window.fixture.expired?json({message:'The password-reset link is invalid or expired.'},400):json({completed:true});throw Error('Unexpected test request '+path)};
createRoot(document.getElementById('root')).render(React.createElement(App));`
const server=await createServer({plugins:[{name:'reset-fixture',resolveId(id){if(id==='virtual:reset-fixture')return '\0'+id},load(id){if(id==='\0virtual:reset-fixture')return fixture},configureServer(s){s.middlewares.use('/reset-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/reset-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:reset-fixture"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5195,strictPort:true},logLevel:'error'})
await server.listen();const results=[]
try{for(const[name,type]of[['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch(),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
 try{
  await page.goto('http://127.0.0.1:5195/reset-fixture')
  await page.getByRole('button',{name:'Forgot password?',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill('synthetic@example.invalid')
  for(let i=0;i<2;i++){const before=await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('button',{name:'Request link',exact:true})).toBeVisible();await expect(page.getByLabel('Email',{exact:true})).toHaveValue('synthetic@example.invalid');expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)).toBe(before)}
  const beforeIdentityChange=await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)
  await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.identity-change',newValue:'synthetic-sign-out'})))
  await expect.poll(()=>page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)).toBe(beforeIdentityChange+1)
  await expect(page.getByLabel('Email',{exact:true})).toHaveValue('synthetic@example.invalid')
  await page.getByRole('button',{name:'Request link',exact:true}).click();await expect(page.getByText('If the account exists, a reset link has been sent.',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.path.endsWith('/password-reset/request')))).toEqual([{path:'/api/core/auth/password-reset/request',body:{email:'synthetic@example.invalid'}}])
  await page.goto('http://127.0.0.1:5195/reset-fixture?reset=synthetic-reset-token')
  await expect(page.locator('#core-password-rules')).toContainText('14 to 500 characters')
  const password=page.getByLabel('New password',{exact:true}),confirmation=page.getByLabel('Confirm password',{exact:true}),save=page.getByRole('button',{name:'Save password',exact:true})
  await password.fill('short');await confirmation.fill('short');await save.click();expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.path.endsWith('/password-reset/complete')).length)).toBe(0)
  await password.fill('Synthetic new password!');await confirmation.fill('Different new password!');await save.click();await expect(page.getByRole('alert')).toContainText('Passwords do not match.')
  await confirmation.fill('Synthetic new password!');await page.evaluate(()=>window.fixture.expired=true);await save.click();await expect(page.getByRole('alert')).toContainText('invalid or expired')
  await page.evaluate(()=>window.fixture.expired=false);await save.click();await expect(page.getByText('The password was saved. Please sign in again.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible()
  expect(new URL(page.url()).search).toBe('');expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.evaluate(()=>{window.fixture.user={id:'synthetic-user',name:'Synthetic Employee',email:'synthetic@example.invalid',role:'employee',active:true,mustChangePassword:false};window.dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.identity-change',newValue:'synthetic-sign-in'}))})
  await expect(page.getByRole('heading',{name:'Welcome, Synthetic Employee',exact:true})).toBeVisible()
  const signedInChecks=await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)
  await page.evaluate(()=>{for(let i=0;i<5;i++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))}})
  expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)).toBe(signedInChecks)
  await expect(page.getByRole('heading',{name:'Welcome, Synthetic Employee',exact:true})).toBeVisible()
  await page.evaluate(()=>{window.fixture.user=null;window.dispatchEvent(new StorageEvent('storage',{key:'digital-core-office.identity-change',newValue:'synthetic-sign-out'}))})
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible()
  expect(await page.evaluate(()=>window.fixture.calls.filter(call=>call.path==='/api/core/session').length)).toBe(signedInChecks+1)
  expect(errors).toEqual([])
  results.push({browser:name,noFocusSessionRequests:true,identityChangesStillRevalidated:true,resetFormSurvivesWindowFocus:true,requestSubmittedOnce:true,passwordRulesVisible:true,shortPasswordBlocked:true,mismatchAndExpiredLinkVisible:true,successfulResetReturnsToSignIn:true,mobileWidth:true})
 }finally{await browser.close()}
}}finally{await server.close()}
mkdirSync('../.runtime/company-deploy-20260907/password-reset-r43',{recursive:true});writeFileSync('../.runtime/company-deploy-20260907/password-reset-r43/browser-verification.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results))
