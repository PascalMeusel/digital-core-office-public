// Run from core-service: node tests/qr-login.browser.test.mjs
import {createServer} from 'vite'
import {chromium,firefox,expect} from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'

const fixture=`
import React from 'react'; import {createRoot} from 'react-dom/client';
import App from '/src/App.tsx'; import '/src/styles.css';
localStorage.setItem('digital-core-office.language','en');
window.fixture={calls:[],mode:'pending',holdCreate:false,heldClaims:[],heldCreates:[],generation:0};
const user={id:'synthetic-qr-user',name:'Synthetic QR Employee',email:'qr@example.invalid',role:'employee',active:true,mustChangePassword:false};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,options={})=>{
  const path=new URL(String(input),location.href).pathname,body=options.body?JSON.parse(options.body):null;
  window.fixture.calls.push({path,body,at:performance.now()});
  if(path==='/api/core/modules')return json({modules:[]});
  if(path==='/api/core/session')return json({message:'Sign in'},401);
  if(path.endsWith('/qr-login/challenges')){
    const token='synthetic-qr-'+(++window.fixture.generation),value={token,expiresAt:new Date(Date.now()+300000).toISOString()};
    if(window.fixture.holdCreate)return new Promise(resolve=>window.fixture.heldCreates.push(()=>resolve(json(value,201))));
    return json(value,201);
  }
  if(path.endsWith('/qr-login/challenges/claim')){
    if(window.fixture.mode==='hold')return new Promise(resolve=>window.fixture.heldClaims.push(()=>resolve(json({user,modules:[]}))));
    if(window.fixture.mode==='approved')return json({user,modules:[]});
    if(window.fixture.mode==='expired')return json({message:'QR sign-in is invalid or expired.'},401);
    if(window.fixture.mode==='failed')throw new Error('Synthetic network failure');
    return json({pending:true},202);
  }
  throw Error('Unexpected request '+path);
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
`
const server=await createServer({plugins:[{
  name:'qr-login-fixture',
  resolveId(id){if(id==='virtual:qr-login-fixture')return '\0'+id},
  load(id){if(id==='\0virtual:qr-login-fixture')return fixture},
  configureServer(vite){vite.middlewares.use('/qr-fixture',async(_request,response)=>{
    response.setHeader('Content-Type','text/html');response.end(await vite.transformIndexHtml('/qr-fixture','<html><body><div id="root"></div><script type="module" src="/@id/virtual:qr-login-fixture"></script></body></html>'))
  })},
}],server:{host:'127.0.0.1',port:5196,strictPort:true},logLevel:'error'})
await server.listen()
const results=[]
const requests=(page,suffix)=>page.evaluate(suffix=>window.fixture.calls.filter(call=>call.path.endsWith(suffix)),suffix)
const createSuffix='/qr-login/challenges',claimSuffix='/qr-login/challenges/claim'
async function show(page){
  await page.getByRole('button',{name:'Show QR code',exact:true}).click()
  await expect(page.getByRole('img',{name:'QR code for desktop sign-in',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Refresh QR code',exact:true})).toBeEnabled()
}
async function visibility(page,hidden){
  await page.evaluate(hidden=>{Object.defineProperty(document,'hidden',{value:hidden,configurable:true});document.dispatchEvent(new Event('visibilitychange'))},hidden)
}
try {
  for(const [name,type]of [['chromium',chromium],['firefox',firefox]]){
    const browser=await type.launch()
    try{
      const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[]
      page.on('pageerror',error=>errors.push(error.message))
      await page.clock.install({time:new Date('2026-09-09T12:00:00Z')})
      await page.clock.pauseAt(new Date('2026-09-09T12:00:01Z'))
      await page.goto('http://127.0.0.1:5196/qr-fixture')
      await expect(page.getByRole('button',{name:'Show QR code',exact:true})).toBeVisible()
      await page.clock.runFor(120_000)
      expect(await requests(page,createSuffix)).toHaveLength(0);expect(await requests(page,claimSuffix)).toHaveLength(0)
      await show(page);expect(await requests(page,createSuffix)).toHaveLength(1)
      await page.clock.runFor(4999);expect(await requests(page,claimSuffix)).toHaveLength(0)
      await page.clock.runFor(1);await expect.poll(async()=>(await requests(page,claimSuffix)).length).toBe(1)
      for(let i=2;i<=4;i++){await page.clock.runFor(5000);await expect.poll(async()=>(await requests(page,claimSuffix)).length).toBe(i)}
      const polls=await requests(page,claimSuffix)
      expect(polls.slice(1).every((call,index)=>call.at-polls[index].at>=5000)).toBe(true)
      await visibility(page,true);await page.clock.runFor(60_000);expect(await requests(page,claimSuffix)).toHaveLength(4)
      await visibility(page,false);await page.clock.runFor(1);await expect.poll(async()=>(await requests(page,claimSuffix)).length).toBe(5)
      for(let i=0;i<5;i++){await visibility(page,true);await visibility(page,false);await page.evaluate(()=>window.dispatchEvent(new Event('focus')))}
      await page.clock.runFor(100);expect(await requests(page,claimSuffix)).toHaveLength(5)
      await page.evaluate(()=>window.fixture.mode='approved');await page.clock.runFor(5000)
      await expect(page.getByRole('heading',{name:'Welcome, Synthetic QR Employee',exact:true})).toBeVisible()
      const signedIn=(await requests(page,claimSuffix)).length
      await page.clock.runFor(60_000);expect(await requests(page,claimSuffix)).toHaveLength(signedIn)

      await page.goto('http://127.0.0.1:5196/qr-fixture');await show(page)
      await page.evaluate(()=>window.fixture.mode='hold');await page.clock.runFor(5000)
      await expect.poll(()=>page.evaluate(()=>window.fixture.heldClaims.length)).toBe(1)
      await page.clock.runFor(30_000);expect(await requests(page,claimSuffix)).toHaveLength(1)
      await page.getByRole('button',{name:'Refresh QR code',exact:true}).click()
      await expect.poll(async()=>(await requests(page,createSuffix)).length).toBe(2)
      await expect(page.getByRole('img',{name:'QR code for desktop sign-in',exact:true})).toBeVisible()
      await page.evaluate(()=>{window.fixture.mode='expired';window.fixture.heldClaims.shift()()})
      await page.clock.runFor(5000)
      await expect(page.getByRole('alert')).toContainText('invalid or expired')
      await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible()
      const expired=(await requests(page,claimSuffix)).length
      await visibility(page,true);await visibility(page,false);await page.clock.runFor(60_000)
      expect(await requests(page,claimSuffix)).toHaveLength(expired)
      await page.getByRole('button',{name:'Hide QR code',exact:true}).click()
      await page.clock.runFor(60_000);expect(await requests(page,claimSuffix)).toHaveLength(expired)

      await page.evaluate(()=>{window.fixture.mode='pending';window.fixture.holdCreate=true})
      await page.getByRole('button',{name:'Show QR code',exact:true}).click()
      await expect.poll(()=>page.evaluate(()=>window.fixture.heldCreates.length)).toBe(1)
      await page.getByRole('button',{name:'Hide QR code',exact:true}).click()
      await page.evaluate(()=>window.fixture.heldCreates.shift()())
      await page.clock.runFor(30_000)
      await expect(page.getByRole('button',{name:'Show QR code',exact:true})).toBeVisible()
      await expect(page.getByRole('img',{name:'QR code for desktop sign-in',exact:true})).toHaveCount(0)
      expect(await requests(page,claimSuffix)).toHaveLength(expired)

      await page.evaluate(()=>{window.fixture.holdCreate=false;window.fixture.mode='failed'})
      await show(page);await page.clock.runFor(5000)
      await expect(page.getByRole('alert')).toContainText('Synthetic network failure')
      const failed=(await requests(page,claimSuffix)).length
      await page.clock.runFor(60_000);expect(await requests(page,claimSuffix)).toHaveLength(failed)
      await page.getByRole('button',{name:'Forgot password?',exact:true}).click()
      await page.clock.runFor(60_000);expect(await requests(page,claimSuffix)).toHaveLength(failed)
      await expect(page.getByRole('button',{name:'Request link',exact:true})).toBeVisible()
      expect(errors).toEqual([])
      results.push({browser:name,idleRequests:0,startsOnlyOnClick:true,minimumPollIntervalMs:5000,hiddenRequests:0,overlappingRequests:0,staleClaimIgnored:true,closedCreationIgnored:true,stopsOnExpiryErrorAndSuccess:true})
      await page.close()
      const mobile=await browser.newPage({viewport:{width:390,height:844}})
      await mobile.clock.install({time:new Date('2026-09-09T12:00:00Z')});await mobile.clock.pauseAt(new Date('2026-09-09T12:00:01Z'))
      await mobile.goto('http://127.0.0.1:5196/qr-fixture');await expect(mobile.getByRole('button',{name:'Sign in',exact:true})).toBeVisible()
      await mobile.clock.runFor(60_000);expect(await requests(mobile,createSuffix)).toHaveLength(0);expect(await requests(mobile,claimSuffix)).toHaveLength(0)
      await mobile.close()
    }finally{await browser.close()}
  }
}finally{await server.close()}
mkdirSync('../.runtime/company-deploy-20260907/qr-poll-r45',{recursive:true})
writeFileSync('../.runtime/company-deploy-20260907/qr-poll-r45/browser-verification.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results))
