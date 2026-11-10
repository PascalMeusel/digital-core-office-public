// Run from time-tracking-system: node tests/session-recovery.browser.test.mjs
import { createServer } from 'vite'
import { chromium, firefox, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const output = path.resolve('../.runtime/time-session-recovery-20261003')
const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.tsx';import '/src/index.css';
const user={id:'synthetic',name:'Synthetic Employee',email:'synthetic@example.invalid',role:'employee',active:true,mustChangePassword:false,expectedWeeklyMinutes:2400,yearlyVacationDays:30,balanceAdjustmentMinutes:0,vacationAdjustmentDays:0,trackingStartDate:'2026-01-01',employmentTerms:[],calendarAccessUserIds:[]};
const period={workedMinutes:0,expectedMinutes:0,plusMinusMinutes:0};
const state={organizationTimezone:'Europe/Berlin',coreManaged:true,currentUser:user,users:[user],visibleCalendarUsers:[user],shareableCalendarUsers:[],calendarGroups:[],calDavAccounts:[],externalCalendarEvents:[],customCalendarEvents:[],timeEntries:[],absences:[],holidays:[],requests:[],notifications:[],summaries:[{userId:user.id,week:period,month:period,year:period,vacation:{yearlyDays:30,usedDays:0,remainingDays:30}}],clockStatus:'off_work',clockStatuses:{synthetic:'off_work'},clockLocations:{},dayIssues:[]};
const params=new URLSearchParams(location.search);window.fixture={sso:params.get('sso')||'valid',stateMode:params.get('state')||'valid',calls:[],unhandled:[],state};
window.addEventListener('unhandledrejection',event=>window.fixture.unhandled.push(String(event.reason)));
window.fetch=async(input,options={})=>{const route=new URL(String(input),location.href).pathname;window.fixture.calls.push(route);const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(route.endsWith('/api/sso/session')){const mode=window.fixture.sso;if(mode==='network')throw new TypeError('Synthetic network failure');if(mode==='timeout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));if(mode!=='valid')return json({message:'Synthetic session check failure'},Number(mode));return json({token:'core-cookie-session'});}
if(route.endsWith('/api/state'))return window.fixture.stateMode==='valid'?json({...state,serverTime:new Date().toISOString()}):json({message:'Synthetic access verification failed'},Number(window.fixture.stateMode));
if(route.endsWith('/api/core/modules'))return json({modules:[]});throw Error('Unexpected fixture request '+route)};
window.WebSocket=class {static OPEN=1;static CLOSED=3;constructor(){throw Error('Synthetic HTTP-only connection')}};
localStorage.removeItem('time-tracker-token');sessionStorage.removeItem('time-tracker-token');localStorage.setItem('time-tracker-language','en');localStorage.setItem('digital-core-office.language','en');localStorage.setItem('digital-core-office.theme','light');
createRoot(document.getElementById('root')).render(React.createElement(App));`

mkdirSync(output, { recursive: true })
const server = await createServer({
  cacheDir: path.join(output, 'vite-cache'),
  define: { 'import.meta.env.VITE_CORE_URL': JSON.stringify('/') },
  plugins: [{
    name: 'time-session-fixture',
    resolveId(id) { if (id === 'virtual:time-session-fixture') return '\0' + id },
    load(id) { if (id === '\0virtual:time-session-fixture') return fixture },
    configureServer(vite) {
      vite.middlewares.use('/session-parent', (request, response) => {
        const search = new URL(request.url, 'http://localhost').search
        response.setHeader('Content-Type', 'text/html')
        response.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><script>window.sessionMessages=[];addEventListener('message',event=>{if(event.origin===location.origin&&event.source===document.querySelector('iframe')?.contentWindow&&event.data?.type==='dco:session-invalidated')window.sessionMessages.push(event.data)})</script><iframe title="Time" src="/session-child${search ? search + '&' : '?'}embedded=1" style="border:0;width:100%;height:100vh"></iframe></body></html>`)
      })
      vite.middlewares.use('/session-child', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(await vite.transformIndexHtml('/session-child', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:time-session-fixture"></script></body></html>'))
      })
    },
  }],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  logLevel: 'error',
})
await server.listen()
const results = []
try {
  for (const [name, browserType] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await browserType.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      page.setDefaultTimeout(7_000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.install()
      const workspace = page.frameLocator('iframe')
      const child = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame())
      const messages = () => page.evaluate(() => window.sessionMessages.length)
      for (const mode of ['503', 'network', 'timeout', '403']) {
        await page.goto('http://127.0.0.1:5199/session-parent?sso=' + mode)
        if (mode === 'timeout') {
          await expect.poll(() => child()?.evaluate(() => window.fixture?.calls.some(route => route.endsWith('/api/sso/session')))).toBe(true)
          await page.clock.fastForward(10_001)
        }
        await expect(workspace.getByRole('heading', { name: 'Connection unavailable', exact: true })).toBeVisible()
        await expect(workspace.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
        expect(await messages()).toBe(mode === '403' ? 1 : 0)
        expect(await child().evaluate(() => window.fixture.unhandled)).toEqual([])
        expect(await child().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (name === 'chromium' && mode === '503') {
          await page.screenshot({ path: path.join(output, 'recovery-mobile-light.png'), fullPage: true })
          await workspace.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
          await page.clock.fastForward(500)
          await page.screenshot({ path: path.join(output, 'recovery-mobile-dark.png'), fullPage: true })
        }
        await child().evaluate(() => { window.fixture.sso = 'valid' })
        await workspace.getByRole('button', { name: 'Reconnect now', exact: true }).click()
        await expect(workspace.getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled()
      }

      await page.goto('http://127.0.0.1:5199/session-parent?state=503')
      await expect(workspace.getByRole('heading', { name: 'Connection unavailable', exact: true })).toBeVisible()
      await child().evaluate(() => { window.fixture.stateMode = 'valid' })
      await workspace.getByRole('button', { name: 'Reconnect now', exact: true }).click()
      await expect(workspace.getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled()

      await workspace.getByRole('button', { name: 'Requests', exact: true }).click()
      const reason = workspace.getByRole('textbox', { name: 'Reason', exact: true })
      await reason.fill('Keep this unsent request while access is checked.')
      await reason.evaluate(element => { window.fixture.draftInput = element })
      await child().evaluate(() => { window.fixture.stateMode = '403'; dispatchEvent(new Event('online')) })
      await expect.poll(messages).toBeGreaterThan(0)
      await expect(reason).toHaveValue('Keep this unsent request while access is checked.')
      expect(await reason.evaluate(element => element === window.fixture.draftInput)).toBe(true)
      await expect(workspace.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
      await workspace.getByRole('button', { name: 'Dashboard', exact: true }).click()
      await expect(workspace.getByRole('button', { name: 'Start Work', exact: true })).toBeDisabled()
      await child().evaluate(() => { window.fixture.stateMode = 'valid' })
      await workspace.getByRole('button', { name: 'Reconnect now', exact: true }).click()
      await expect(workspace.getByRole('button', { name: 'Start Work', exact: true })).toBeEnabled()
      const priorMessages = await messages()
      await child().evaluate(() => { window.fixture.stateMode = '401'; dispatchEvent(new Event('online')) })
      await expect(workspace.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expect.poll(messages).toBeGreaterThan(priorMessages)
      expect(await child().evaluate(() => window.fixture.unhandled)).toEqual([])
      expect(errors).toEqual([])
      results.push({ browser: name, initialOutagesRecoverable: true, initialStateFailureRecoverable: true, forbiddenPreservesDraft: true, forbiddenDisablesClock: true, unauthorizedNotifiesParent: true, unhandledRejections: 0, mobileWidth: true })
    } finally { await browser.close() }
  }
} finally { await server.close() }
writeFileSync(path.join(output, 'browser-verification.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
