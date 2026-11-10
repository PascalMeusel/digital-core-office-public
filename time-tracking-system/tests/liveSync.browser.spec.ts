import {expect,test,type Page,type Route} from '@playwright/test'
import {createServer,type ViteDevServer} from 'vite'
import react from '@vitejs/plugin-react'
import {fileURLToPath} from 'node:url'
import {readFileSync} from 'node:fs'
import type {StatePayload,User} from '../shared/domain.ts'

// Run: npx playwright test --config playwright.live-sync.config.ts
const root=fileURLToPath(new URL('..',import.meta.url))
const user:User={id:'synthetic-sync-user',name:'Synthetic Sync Employee',email:'sync@example.invalid',role:'employee',active:true,mustChangePassword:false,expectedWeeklyMinutes:2400,yearlyVacationDays:30,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,trackingStartDate:'2026-09-07',employmentTerms:[],calendarAccessUserIds:[]}
const totals={workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0}
const initialState:StatePayload={
  currentUser:user,users:[user],visibleCalendarUsers:[user],shareableCalendarUsers:[],calendarGroups:[],calDavAccounts:[],externalCalendarEvents:[],customCalendarEvents:[],
  timeEntries:[],absences:[],holidays:[],holidayOverrides:[],holidaySettings:{country:'DE',language:'en'},holidayTemplateOptions:{countries:[],states:[],regions:[]},
  requests:[],notifications:[],importBatches:[],userInvitations:[],backup:{dataFile:'',backupDir:'',nextAutomaticCheck:''},
  summaries:[{userId:user.id,week:totals,month:totals,year:totals,vacation:{yearlyDays:30,usedDays:0,remainingDays:30}}],
  clockStatus:'off_work',clockStatuses:{[user.id]:'off_work'},clockLocations:{},dayIssues:[],organizationTimezone:'Europe/Berlin',
}
interface SocketControl {readyState:number;sent:string[];emit:(type:'open'|'message'|'close'|'error',payload?:unknown)=>void}
declare global {interface Window {__liveSync:{sockets:SocketControl[];samples:Array<{banner:boolean;disabled:boolean;y:number|null}>;sample:()=>void;ignoreStateAbort:boolean}}}
let server:ViteDevServer,origin:string
test.beforeAll(async()=>{
  const moduleId='virtual:live-sync-fixture',resolved='\0'+moduleId
  server=await createServer({
    configFile:false,root,base:'/',plugins:[react(),{
      name:'isolated-live-sync-fixture',
      resolveId(id){if(id===moduleId)return resolved},
      load(id){
        // Optional negative control serves a saved App source without changing the working tree.
        if(process.env.DCO_LIVE_SYNC_TEST_APP_SOURCE&&id.split('?')[0].replaceAll('\\','/')===fileURLToPath(new URL('../src/App.tsx',import.meta.url)).replaceAll('\\','/'))return readFileSync(process.env.DCO_LIVE_SYNC_TEST_APP_SOURCE,'utf8')
        if(id===resolved)return `import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(App,{initialState:${JSON.stringify(initialState)}}));`
      },
      configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
        if(req.url?.split('?')[0]!=='/__live_sync_fixture'){next();return}
        try{
          const html=await vite.transformIndexHtml('/__live_sync_fixture',`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/@id/${moduleId}"></script></body></html>`)
          res.setHeader('Content-Type','text/html');res.end(html)
        }catch(error){next(error)}
      })},
    }],
    resolve:{dedupe:['react','react-dom'],preserveSymlinks:true},
    define:{'import.meta.env.VITE_API_URL':JSON.stringify('/__sync_fixture'),'import.meta.env.VITE_CORE_URL':JSON.stringify(''),'import.meta.env.VITE_SIMPLE_MODE':JSON.stringify('false'),'import.meta.env.VITE_MOBILE_APP':JSON.stringify('false')},
    server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error',
  })
  await server.listen();origin=server.resolvedUrls!.local[0].replace(/\/$/,'')
})
test.afterAll(async()=>{await server?.close()})

async function setup(page:Page,options:{deviceTime?:string;state?:StatePayload}={}){
  const network={mode:'ok' as 'ok'|'fail'|'unauthorized'|'forbidden'|'hold',requests:0,pending:[] as Route[],unexpected:[] as string[],state:options.state??initialState}
  const deviceTime=new Date(options.deviceTime??'2026-09-07T12:00:00Z')
  await page.clock.install({time:deviceTime})
  await page.clock.pauseAt(new Date(deviceTime.getTime()+1000))
  await page.addInitScript(()=>{
    localStorage.setItem('time-tracker-token','synthetic-browser-token')
    localStorage.setItem('digital-core-office.language','en')
    class FakeWebSocket extends EventTarget {
      static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
      readyState=0;sent:string[]=[]
      readonly url:string
      constructor(url:string){super();this.url=url;if(new URL(url,location.href).pathname.endsWith('/api/live'))window.__liveSync.sockets.push(this)}
      send(value:string){this.sent.push(value)}
      close(){this.readyState=3;this.dispatchEvent(new Event('close'))}
      emit(type:'open'|'message'|'close'|'error',payload?:unknown){
        if(type==='open')this.readyState=1
        if(type==='close')this.readyState=3
        this.dispatchEvent(type==='message'?new MessageEvent('message',{data:JSON.stringify(payload)}):new Event(type))
      }
    }
    window.__liveSync={sockets:[],samples:[],sample:()=>{},ignoreStateAbort:false}
    const nativeFetch=window.fetch.bind(window)
    window.fetch=(input,options)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url
      return nativeFetch(input,window.__liveSync.ignoreStateAbort&&url.endsWith('/api/state')?{...options,signal:undefined}:options)
    }
    Object.defineProperty(window,'WebSocket',{value:FakeWebSocket,writable:true})
  })
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url())
    if(url.origin!==origin){network.unexpected.push(url.origin);await route.abort();return}
    if(url.pathname==='/__sync_fixture/api/state'){
      network.requests++
      if(network.mode==='hold'){network.pending.push(route);return}
      await route.fulfill({status:network.mode==='unauthorized'?401:network.mode==='forbidden'?403:network.mode==='fail'?503:200,contentType:'application/json',body:JSON.stringify(network.mode==='ok'?network.state:{message:network.mode==='unauthorized'?'Synthetic session expired':'Synthetic backend unavailable'})});return
    }
    if(url.pathname==='/__sync_fixture/api/logout'){await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});return}
    if(url.pathname.startsWith('/__sync_fixture/api/')){network.unexpected.push(url.pathname);await route.fulfill({status:404,contentType:'application/json',body:'{}'});return}
    await route.continue()
  })
  await page.goto(origin+'/__live_sync_fixture')
  await expect(page.locator('.clock-actions button').first()).toBeVisible()
  await expect.poll(()=>page.evaluate(()=>window.__liveSync.sockets.length)).toBeGreaterThan(0)
  await page.evaluate(async()=>{await document.fonts.ready})
  await page.clock.runFor(50)
  await page.evaluate(()=>{
    const sample=()=>{
      const button=document.querySelector<HTMLButtonElement>('.clock-actions button')
      window.__liveSync.samples.push({banner:Boolean(document.querySelector('.clock-sync-state')),disabled:button?.disabled??true,y:button?.getBoundingClientRect().y??null})
    }
    window.__liveSync.sample=sample
    new MutationObserver(sample).observe(document.body,{subtree:true,childList:true,attributes:true})
    sample()
  })
  return network
}
async function emit(page:Page,index:number,type:'open'|'message'|'close'|'error',payload?:unknown){
  await page.evaluate(({index,type,payload})=>window.__liveSync.sockets[index].emit(type,payload),{index,type,payload})
  await page.clock.runFor(20)
}
async function clockEnabled(page:Page){await expect(page.locator('.clock-actions button').first()).toBeEnabled();await expect(page.locator('.clock-sync-state')).toHaveCount(0)}
async function clockDisabled(page:Page){await expect(page.locator('.clock-actions button').first()).toBeDisabled();await expect(page.locator('.clock-sync-state')).toBeVisible()}

test('switching tabs does not duplicate fresh HTTP state requests, but returning to stale data refreshes it',async({page})=>{
  const network=await setup(page)
  await expect.poll(()=>network.requests).toBeGreaterThan(0);await clockEnabled(page)
  const before=network.requests
  await page.evaluate(()=>{
    for(let i=0;i<5;i++){
      Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    }
  })
  await page.clock.runFor(50);expect(network.requests).toBe(before);await clockEnabled(page)
  await page.evaluate(()=>{
    // Model browser suspension without running the regular polling timers.
    const resumedAt=performance.now()+31_000
    Object.defineProperty(performance,'now',{value:()=>resumedAt,configurable:true})
    Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(50);expect(network.requests).toBe(before)
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))})
  await page.clock.runFor(50);await expect.poll(()=>network.requests).toBe(before+1);await clockEnabled(page)
  expect(network.unexpected).toEqual([])
})

test('switching tabs does not request redundant state from a healthy live socket',async({page})=>{
  const network=await setup(page)
  await emit(page,0,'open');await emit(page,0,'message',{type:'state',payload:initialState})
  const httpRequests=network.requests,socketMessages=await page.evaluate(()=>window.__liveSync.sockets[0].sent.length)
  await page.evaluate(()=>{for(let i=0;i<5;i++){window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))}})
  await page.clock.runFor(50)
  expect(network.requests).toBe(httpRequests)
  expect(await page.evaluate(()=>window.__liveSync.sockets[0].sent.length)).toBe(socketMessages)
  await clockEnabled(page)
})

test('repeated WebSocket failures do not flash a sync banner or move/disable a clock backed by successful HTTP',async({page})=>{
  const network=await setup(page)
  const baseline=(await page.locator('.clock-actions button').first().boundingBox())!.y
  for(let attempt=0;attempt<3;attempt++){
    const index=await page.evaluate(()=>window.__liveSync.sockets.length-1)
    await emit(page,index,'error');await emit(page,index,'close')
    await expect.poll(()=>network.requests).toBeGreaterThan(attempt)
    await clockEnabled(page)
    await page.clock.runFor(35_000)
  }
  await clockEnabled(page)
  const samples=await page.evaluate(()=>window.__liveSync.samples)
  expect(samples.filter(sample=>sample.banner||sample.disabled)).toEqual([])
  expect(samples.every(sample=>sample.y!==null&&Math.abs(sample.y-baseline)<1)).toBeTruthy()
  expect(network.unexpected).toEqual([])
})

test('real HTTP failure disables clocking and a successful fallback restores it',async({page})=>{
  const network=await setup(page);network.mode='fail'
  await emit(page,0,'close');await clockDisabled(page)
  network.mode='ok'
  await page.evaluate(()=>window.dispatchEvent(new Event('online')))
  await page.clock.runFor(50);await clockEnabled(page)
})

test('a hanging HTTP state request becomes a genuine sync failure at its deadline and can recover',async({page})=>{
  const network=await setup(page);network.mode='hold'
  await page.evaluate(()=>window.dispatchEvent(new Event('online')))
  await page.clock.runFor(20)
  await expect.poll(()=>network.pending.length).toBeGreaterThan(0)
  await page.clock.runFor(14_000);await clockEnabled(page)
  await page.clock.runFor(2000);await clockDisabled(page)
  network.mode='ok'
  for(const pending of network.pending)await pending.fulfill({status:200,contentType:'application/json',body:JSON.stringify(initialState)}).catch(()=>{})
  await page.evaluate(()=>window.dispatchEvent(new Event('online')))
  await page.clock.runFor(50);await clockEnabled(page)
})

test('a previously started HTTP response arriving after logout cannot restore the old identity',async({page})=>{
  const network=await setup(page);network.mode='hold'
  await page.evaluate(()=>{window.__liveSync.ignoreStateAbort=true;window.dispatchEvent(new Event('online'))})
  await page.clock.runFor(20)
  await expect.poll(()=>network.pending.length).toBeGreaterThan(0)
  await page.getByRole('button',{name:'Sign out',exact:true}).click()
  await expect(page.locator('.clock-panel')).toHaveCount(0)
  for(const pending of network.pending)await pending.fulfill({status:200,contentType:'application/json',body:JSON.stringify(initialState)})
  await page.clock.runFor(50)
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible()
  await expect(page.locator('.clock-panel')).toHaveCount(0)
  expect(await page.evaluate(()=>localStorage.getItem('time-tracker-token'))).toBeNull()
})

for(const [status,mode] of [[401,'unauthorized'],[403,'forbidden']] as const)test(`HTTP ${status} removes the old state instead of leaving clock actions accessible`,async({page})=>{
  const network=await setup(page);network.mode=mode
  await emit(page,0,'close')
  await expect(page.locator('.clock-panel')).toHaveCount(0)
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>localStorage.getItem('time-tracker-token'))).toBeNull()
})

test('heartbeats without new state cannot keep an old payload fresh indefinitely',async({page})=>{
  const network=await setup(page)
  await emit(page,0,'open');await emit(page,0,'message',{type:'state',payload:initialState})
  network.mode='hold'
  for(let interval=0;interval<5;interval++){
    await page.clock.runFor(20_000)
    await emit(page,0,'message',{type:'heartbeat'})
  }
  await clockDisabled(page)
  for(const pending of network.pending)await pending.abort().catch(()=>{})
})

test('callbacks queued by a replaced socket cannot replace state or mark a recovered HTTP connection failed',async({page})=>{
  const network=await setup(page)
  await emit(page,0,'open');await emit(page,0,'close')
  await expect.poll(()=>network.requests).toBeGreaterThan(0)
  await page.clock.runFor(2000)
  await expect.poll(()=>page.evaluate(()=>window.__liveSync.sockets.length)).toBeGreaterThan(1)
  await clockEnabled(page)
  await page.evaluate(()=>{window.__liveSync.samples=[];window.__liveSync.sample()})
  const stale={...initialState,currentUser:{...user,name:'STALE SOCKET IDENTITY'},users:[{...user,name:'STALE SOCKET IDENTITY'}]}
  await emit(page,0,'message',{type:'state',payload:stale})
  await emit(page,0,'error');await emit(page,0,'close');await emit(page,0,'message',{type:'heartbeat'})
  await clockEnabled(page)
  await expect(page.getByText('STALE SOCKET IDENTITY',{exact:true})).toHaveCount(0)
  expect(await page.evaluate(()=>window.__liveSync.samples.some(sample=>sample.banner||sample.disabled))).toBeFalsy()
})

function runningState() {
  return {...initialState,serverTime:'2026-09-09T09:04:30.000Z',clockStatus:'working' as const,
    clockStatuses:{[user.id]:'working' as const},timeEntries:[{id:'shared-shift',userId:user.id,date:'2026-09-09',startedAt:'2026-09-09T07:52:00.000Z',breaks:[],source:'clock' as const}]}
}

test('two PCs show the same advancing work timer despite incorrect device dates, clock offsets and clock changes',async({browser})=>{
  const state=runningState(),pages:Page[]=[]
  try {
    for(const deviceTime of ['2026-09-09T09:04:30Z','2026-09-08T09:04:30Z','2026-09-09T08:34:30Z']) {
      const page=await browser.newPage({timezoneId:'Pacific/Honolulu'});pages.push(page)
      const network=await setup(page,{deviceTime,state})
      await expect.poll(()=>network.requests).toBeGreaterThan(0)
      await expect(page.locator('.clock-live-stats').first()).toContainText('09:52')
      await expect(page.locator('.clock-primary-reading > span')).toHaveText(/^1:12:3[0-9]$/)
      await clockEnabled(page)
      await page.clock.setSystemTime(new Date('2026-09-01T00:00:00Z'))
      await page.clock.runFor(10_000)
      await expect(page.locator('.clock-primary-reading > span')).toHaveText(/^1:12:4[0-9]$/)
      await clockEnabled(page)
      expect(network.unexpected).toEqual([])
    }
  } finally {await Promise.all(pages.map(page=>page.close()))}
})

test('a second PC receives break changes through HTTP and WebSocket without using its wall clock',async({page})=>{
  const state=runningState(),network=await setup(page,{deviceTime:'2026-09-08T09:04:30Z',state})
  await expect(page.locator('.clock-primary-reading > span')).toHaveText(/^1:12:3[0-9]$/)
  network.state={...state,serverTime:'2026-09-09T09:06:00.000Z',clockStatus:'on_break',clockStatuses:{[user.id]:'on_break'},timeEntries:[{...state.timeEntries[0],breaks:[{id:'remote-break',startedAt:'2026-09-09T09:05:00.000Z'}]}]}
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.clock.runFor(50)
  await expect(page.locator('.clock-primary-reading > span')).toHaveText('1:13:00')
  await page.clock.runFor(10_000)
  await expect(page.locator('.clock-primary-reading > span')).toHaveText('1:13:00')
  const resumed={...state,serverTime:'2026-09-09T09:10:00.000Z',timeEntries:[{...state.timeEntries[0],breaks:[{id:'remote-break',startedAt:'2026-09-09T09:05:00.000Z',stoppedAt:'2026-09-09T09:10:00.000Z'}]}]}
  const index=await page.evaluate(()=>window.__liveSync.sockets.length-1)
  await emit(page,index,'open');await emit(page,index,'message',{type:'state',payload:resumed})
  await expect(page.locator('.clock-primary-reading > span')).toHaveText('1:13:00')
  await page.clock.setSystemTime(new Date('2026-10-09T09:10:00Z'));await page.clock.runFor(10_000)
  await expect(page.locator('.clock-primary-reading > span')).toHaveText(/^1:13:(09|10|11)$/)
  await clockEnabled(page);expect(network.unexpected).toEqual([])
})

for(const timezoneId of ['UTC','Europe/Berlin','America/New_York','Asia/Tokyo','Pacific/Honolulu','Pacific/Kiritimati']) {
  test(`company clock and elapsed work are independent of PC timezone ${timezoneId}`,async({browser})=>{
    const cases=[
      {name:'summer',serverTime:'2026-09-09T09:04:30Z',startedAt:'2026-09-09T07:52:00Z',date:'2026-09-09',clockIn:'09:52',worked:/^1:12:3[0-9]$/},
      {name:'Berlin next day while UTC is still yesterday',serverTime:'2026-09-08T22:30:00Z',startedAt:'2026-09-08T22:05:00Z',date:'2026-09-09',clockIn:'00:05',worked:/^0:25:0[0-9]$/},
      {name:'winter',serverTime:'2026-01-15T07:45:00Z',startedAt:'2026-01-15T06:00:00Z',date:'2026-01-15',clockIn:'07:00',worked:/^1:45:0[0-9]$/},
      {name:'spring daylight-saving transition',serverTime:'2026-03-29T01:30:00Z',startedAt:'2026-03-29T00:30:00Z',date:'2026-03-29',clockIn:'01:30',worked:/^1:00:0[0-9]$/},
      {name:'autumn daylight-saving transition',serverTime:'2026-10-25T02:30:00Z',startedAt:'2026-10-25T00:30:00Z',date:'2026-10-25',clockIn:'02:30',worked:/^2:00:0[0-9]$/},
    ]
    for(const scenario of cases) {
      const page=await browser.newPage({timezoneId})
      try {
        const state={...runningState(),serverTime:scenario.serverTime,timeEntries:[{...runningState().timeEntries[0]!,date:scenario.date,startedAt:scenario.startedAt}]}
        const network=await setup(page,{deviceTime:scenario.serverTime,state})
        await expect.poll(()=>network.requests).toBeGreaterThan(0)
        await expect(page.locator('.clock-live-stats > div').first().locator('strong'),scenario.name).toHaveText(scenario.clockIn)
        await expect(page.locator('.clock-primary-reading > span'),scenario.name).toHaveText(scenario.worked)
        await clockEnabled(page);expect(network.unexpected).toEqual([])
      } finally {await page.close()}
    }
  })
}
