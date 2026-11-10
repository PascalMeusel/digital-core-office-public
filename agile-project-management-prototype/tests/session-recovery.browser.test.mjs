// Run from agile-project-management-prototype: node tests/session-recovery.browser.test.mjs
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';
const params=new URLSearchParams(location.search);localStorage.setItem('digital-core-office.language','en');localStorage.setItem('digital-core-office.theme',params.get('theme')||'light');
window.fixture={mode:params.get('mode'),poll:null,calls:[],user:{id:'synthetic-user',name:'Synthetic Employee',email:'synthetic@example.invalid',role:'employee',active:true,mustChangePassword:false}};
const originalInterval=window.setInterval;window.setInterval=(callback,delay,...args)=>{if(delay===15000){window.fixture.poll=callback;return originalInterval(callback,600000,...args)}return originalInterval(callback,delay,...args)};
const snapshot={revision:1,permissions:{editWork:params.get('viewer')!=='1',approveDecisions:false,importWorkspace:params.get('viewer')!=='1'},state:{activeSprint:'Sprint 1',releaseGoal:'Synthetic release',stakeholders:[],decisions:[],items:[{id:'synthetic-item',title:'A long synthetic project task to verify mobile wrapping and keyboard controls',type:'Task',area:'Project',status:'In Progress',owner:'Project Management',stakeholder:'Synthetic stakeholder',priority:'High',effort:3,businessValue:5,risk:2,sprint:'Sprint 1',release:'October',due:'2026-10-03',dependsOn:'',acceptance:'A deliberately long acceptance criterion that must remain readable in a narrow workspace.',updatedAt:'2026-10-03T10:00:00Z'}]}};
window.fetch=async(input)=>{const path=new URL(String(input),location.href).pathname;window.fixture.calls.push(path);const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(path.endsWith('/auth/session')||path.endsWith('/auth/sso-session')){const mode=window.fixture.mode;if(mode==='network')throw new TypeError('Failed to fetch');if(mode==='timeout')throw new DOMException('Timed out','TimeoutError');if(['503','403','401'].includes(mode))return json({message:'Synthetic rejection'},Number(mode));return json({user:window.fixture.user,token:'core-cookie-session'})}
if(path.endsWith('/workspace/export'))return json({message:'Synthetic export failure'},503);
if(path.endsWith('/workspace'))return window.fixture.workspaceFailure?json({message:'Workspace temporarily unavailable'},503):json(snapshot);throw Error('Unexpected test request '+path)};
createRoot(document.getElementById('root')).render(React.createElement(App));`
const server = await createServer({ define: { 'import.meta.env.VITE_CORE_URL': JSON.stringify('/'), 'import.meta.env.VITE_API_URL': JSON.stringify('') }, plugins: [{ name: 'agile-recovery-fixture', resolveId(id) { if (id === 'virtual:agile-recovery') return '\0' + id }, load(id) { if (id === '\0virtual:agile-recovery') return fixture }, configureServer(s) {
  s.middlewares.use('/audit-host', (req, res) => { res.setHeader('Content-Type', 'text/html'); const params = new URL(req.url, 'http://localhost').search; res.end('<html><body style="margin:0"><iframe style="border:0;width:100%;height:100vh" src="/audit-fixture' + params.replaceAll('&', '&amp;') + '&amp;embedded=1"></iframe><script>window.messages=[];addEventListener("message",e=>window.messages.push(e.data))</script></body></html>') })
  s.middlewares.use('/audit-fixture', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/audit-fixture', '<html><body><div id="root"></div><script type="module" src="/@id/virtual:agile-recovery"></script></body></html>')) })
} }], server: { host: '127.0.0.1', port: 5198, strictPort: true }, logLevel: 'error' })
await server.listen()
const output = '../.runtime/reliability-20261003/agile'
mkdirSync(output, { recursive: true })
const results = []
try {
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await type.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      for (const mode of ['503', 'network', 'timeout', '403']) {
        await page.goto('http://127.0.0.1:5198/audit-host?mode=' + mode)
        const frame = page.frameLocator('iframe')
        await expect(frame.getByRole('heading', { name: mode === '403' ? 'Access could not be verified' : 'Connection interrupted', exact: true })).toBeVisible()
        await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
        await page.frames()[1].evaluate(() => window.fixture.mode = 'valid')
        await frame.getByRole('button', { name: 'Try again', exact: true }).click()
        await expect(frame.getByRole('heading', { name: 'New item', exact: true })).toBeVisible()
      }
      const frame = page.frameLocator('iframe')
      await frame.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved synthetic draft')
      await page.frames()[1].evaluate(() => { window.fixture.mode = 'network'; window.fixture.poll() })
      await expect(frame.getByRole('alert')).toContainText('Failed to fetch')
      await expect(frame.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Unsaved synthetic draft')
      await page.frames()[1].evaluate(() => window.fixture.mode = 'valid')
      await frame.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(frame.getByRole('alert')).toHaveCount(0)
      await frame.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(frame.getByRole('alert')).toContainText('Export failed')
      await page.frames()[1].evaluate(() => { window.fixture.mode = '403'; window.fixture.poll() })
      await expect(frame.getByRole('heading', { name: 'Access could not be verified', exact: true })).toBeVisible()
      expect(await page.evaluate(() => window.messages.some(message => message.type === 'dco:session-invalidated'))).toBe(true)
      await page.frames()[1].evaluate(() => { window.fixture.mode = 'valid'; window.fixture.workspaceFailure = true })
      await frame.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(frame.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible()
      await expect(frame.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0)
      await page.frames()[1].evaluate(() => window.fixture.workspaceFailure = false)
      await frame.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(frame.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Unsaved synthetic draft')
      await expect(frame.getByRole('alert')).toHaveCount(1)
      await expect(frame.getByRole('alert')).toContainText('Export failed')
      await page.frames()[1].evaluate(() => { window.fixture.mode = '401'; window.fixture.poll() })
      await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 })
        for (const theme of ['light', 'dark']) {
          await page.goto('http://127.0.0.1:5198/audit-host?mode=valid&theme=' + theme)
          await expect(frame.getByRole('heading', { name: 'New item', exact: true })).toBeVisible()
          for (const tab of ['Portfolio', 'Backlog', 'Sprint', 'Roadmap', 'Stakeholders', 'Decisions']) {
            await frame.getByRole('button', { name: tab, exact: true }).click()
            expect(await page.frames()[1].evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
          }
          if (name === 'chromium') await page.screenshot({ path: output + '/layout-' + width + '-' + theme + '.png', fullPage: true })
        }
      }
      expect(errors).toEqual([])
      results.push({ browser: name, temporaryFailuresRetry: true, accessDeniedPreservesDraft: true, expirySignalsCore: true, mobileDesktopLightDark: true })
    } finally { await browser.close() }
  }
} finally { await server.close() }
writeFileSync(output + '/browser-verification.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
