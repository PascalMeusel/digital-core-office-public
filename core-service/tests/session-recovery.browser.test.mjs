// Run from core-service: node tests/session-recovery.browser.test.mjs
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/styles.css';
localStorage.setItem('digital-core-office.language','en');
window.fixture={mode:new URLSearchParams(location.search).get('mode'),user:{id:'synthetic-user',name:'Synthetic Employee',email:'synthetic@example.invalid',role:'employee',active:true,mustChangePassword:false},calls:[]};
window.fixture.modules=window.fixture.mode==='embedded'?[{id:'time',label:'Time',labelDe:'Zeit',path:'/time/'}]:[];
window.fetch=async(input)=>{const path=new URL(String(input),location.href).pathname;window.fixture.calls.push(path);const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/core/modules')return window.fixture.mode==='catalog'?json({message:'Unavailable'},503):json({modules:[]});
if(path==='/api/core/session'){if(window.fixture.mode==='network')throw new TypeError('Failed to fetch');if(window.fixture.mode==='timeout')throw new DOMException('Timed out','TimeoutError');if(window.fixture.mode==='503'||window.fixture.mode==='403')return json({message:'Unavailable'},Number(window.fixture.mode));if(window.fixture.mode==='401')return json({message:'Sign in'},401);return json({user:window.fixture.user,modules:window.fixture.modules})}
if(path.endsWith('/qr-login/challenges'))return json({token:'synthetic-qr',expiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/qr-login/challenges/claim'))return json({pending:true},202);
throw Error('Unexpected test request '+path)};
createRoot(document.getElementById('root')).render(React.createElement(App));`
const server = await createServer({ plugins: [{ name: 'session-fixture', resolveId(id) { if (id === 'virtual:session-fixture') return '\0' + id }, load(id) { if (id === '\0virtual:session-fixture') return fixture }, configureServer(s) {
  s.middlewares.use('/time/index.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><p>Workspace fixture</p><label>Unsent draft<input></label></body></html>') })
  s.middlewares.use('/session-fixture', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml('/session-fixture', '<html><body><div id="root"></div><script type="module" src="/@id/virtual:session-fixture"></script></body></html>')) })
} }], server: { host: '127.0.0.1', port: 5196, strictPort: true }, logLevel: 'error' })
await server.listen()
const results = []
const output = '../.runtime/session-investigation-20261001'
mkdirSync(output, { recursive: true })
try {
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await type.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      for (const mode of ['503', 'network', 'timeout', '403']) {
        await page.goto('http://127.0.0.1:5196/session-fixture?mode=' + mode)
        await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
        expect(await page.evaluate(() => window.fixture.calls.some(path => path.endsWith('/auth/logout')))).toBe(false)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (name === 'chromium' && mode === '503') {
          await page.screenshot({ path: output + '/connection-mobile.png', fullPage: true })
          await page.getByRole('button', { name: 'Dark theme', exact: true }).click()
          await page.screenshot({ path: output + '/connection-mobile-dark.png', fullPage: true })
          await page.getByRole('button', { name: 'Light theme', exact: true }).click()
        }
        await page.evaluate(() => window.fixture.mode = 'valid')
        await page.getByRole('button', { name: 'Try again', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Employee', exact: true })).toBeVisible()
      }
      await page.goto('http://127.0.0.1:5196/session-fixture?mode=catalog')
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Employee', exact: true })).toBeVisible()
      await page.evaluate(() => { localStorage.setItem('time-tracker-token', 'synthetic-marker'); window.fixture.mode = '503'; window.dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.identity-change', newValue: 'synthetic-change' })) })
      await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Employee', exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('time-tracker-token'))).toBe('synthetic-marker')
      await page.evaluate(() => { window.fixture.mode = 'valid'; window.fixture.user = { ...window.fixture.user, id: 'synthetic-other', name: 'Other Employee' } })
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Welcome, Other Employee', exact: true })).toBeVisible()
      await page.evaluate(() => { window.fixture.mode = '401'; window.dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.identity-change', newValue: 'synthetic-sign-out' })) })
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('time-tracker-token'))).toBeNull()
      await page.goto('http://127.0.0.1:5196/session-fixture?mode=401')
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await page.goto('http://127.0.0.1:5196/session-fixture?mode=embedded')
      await page.getByRole('link', { name: 'Time', exact: true }).click()
      await expect(page.frameLocator('iframe').getByText('Workspace fixture', { exact: true })).toBeVisible()
      await page.frameLocator('iframe').getByRole('textbox', { name: 'Unsent draft', exact: true }).fill('Keep this draft through a temporary Core failure.')
      await page.evaluate(() => window.fixture.frame = document.querySelector('iframe'))
      const beforeMessage = await page.evaluate(() => window.fixture.calls.filter(path => path === '/api/core/session').length)
      await page.evaluate(() => {
        const data = { type: 'dco:session-invalidated' }
        window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data }))
        window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.invalid', source: document.querySelector('iframe').contentWindow, data }))
      })
      expect(await page.evaluate(() => window.fixture.calls.filter(path => path === '/api/core/session').length)).toBe(beforeMessage)
      await page.frames()[1].evaluate(() => parent.postMessage({ type: 'dco:session-invalidated' }, location.origin))
      await expect.poll(() => page.evaluate(() => window.fixture.calls.filter(path => path === '/api/core/session').length)).toBe(beforeMessage + 1)
      await expect(page.frameLocator('iframe').getByText('Workspace fixture', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => window.fixture.frame === document.querySelector('iframe'))).toBe(true)
      await page.evaluate(() => window.fixture.mode = '503')
      await page.frames()[1].evaluate(() => parent.postMessage({ type: 'dco:session-invalidated' }, location.origin))
      await expect(page.getByRole('heading', { name: 'Connection interrupted', exact: true })).toBeVisible()
      await expect(page.locator('iframe')).toHaveCount(1)
      await expect(page.locator('iframe')).toBeHidden()
      await expect(page.locator('iframe')).toHaveAttribute('inert', '')
      await expect(page.getByText('Synthetic Employee · Employee', { exact: true })).toHaveCount(0)
      await expect(page.frameLocator('iframe').getByText('Workspace fixture', { exact: true })).toBeHidden()
      expect(await page.evaluate(() => window.fixture.frame === document.querySelector('iframe'))).toBe(true)
      await page.evaluate(() => window.fixture.mode = 'valid')
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(page.frameLocator('iframe').getByRole('textbox', { name: 'Unsent draft', exact: true })).toHaveValue('Keep this draft through a temporary Core failure.')
      await expect(page.locator('iframe')).toBeVisible()
      await expect(page.locator('iframe')).not.toHaveAttribute('inert', '')
      expect(await page.evaluate(() => window.fixture.frame === document.querySelector('iframe'))).toBe(true)
      await page.evaluate(() => window.fixture.mode = '401')
      await page.frames()[1].evaluate(() => parent.postMessage({ type: 'dco:session-invalidated' }, location.origin))
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expect(page.locator('iframe')).toHaveCount(0)
      expect(errors).toEqual([])
      results.push({ browser: name, serverFailureRecoverable: true, networkFailureRecoverable: true, timeoutRecoverable: true, proxyForbiddenDoesNotSignOut: true, catalogFailureIndependent: true, identityChangeRevalidated: true, expiredSessionRequiresSignIn: true, embeddedExpiryRechecksCore: true, unverifiableWorkspaceHiddenAndRetained: true, embeddedDraftSurvivesCoreFailure: true, untrustedMessagesIgnored: true, mobileWidth: true })
    } finally { await browser.close() }
  }
} finally { await server.close() }
writeFileSync(output + '/browser-verification.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
