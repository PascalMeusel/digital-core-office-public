// Run from core-service: node --import tsx tests/device-sign-in.browser.test.mjs
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer } from 'vite'
import { chromium, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dco-device-browser-'))
assert(resolve(directory).startsWith(resolve(tmpdir()) + sep))
process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
process.env.DCO_PUBLIC_BASE_URL = 'http://127.0.0.1:5198'
process.env.DCO_INITIAL_ADMIN_EMAIL = 'device-browser-admin@example.invalid'
process.env.DCO_INITIAL_ADMIN_PASSWORD = 'Temporary-device-browser-admin!'
const { app } = await import('../server/index.ts')
const { authenticate, saveUser, changePassword, closeConnection } = await import('../server/core.ts')
const admin = authenticate(process.env.DCO_INITIAL_ADMIN_EMAIL, process.env.DCO_INITIAL_ADMIN_PASSWORD)
const email = 'long.employee.account.for.device.sign.in@example.invalid'
const employee = saveUser(admin.id, { name: 'QR Employee', email, password: 'Temporary-browser-employee!', memberships: [['time', 'employee'], ['inventory', 'receiver'], ['agile', 'viewer']].map(([moduleId, role]) => ({ moduleId, role, active: true })) })
const password = 'Permanent-browser-employee!'
changePassword(employee.id, 'Temporary-browser-employee!', password)
const api = httpServer(app)
await new Promise(done => api.listen(0, '127.0.0.1', done))
const vite = await createServer({ server: { host: '127.0.0.1', port: 5198, strictPort: true, proxy: { '/api': `http://127.0.0.1:${api.address().port}` } }, logLevel: 'error' })
await vite.listen()
const browser = await chromium.launch()
const evidence = '../.runtime/qr-device-login-20260914'
mkdirSync(evidence, { recursive: true })
const errors = []
const results = []
async function newPage(android, width = 390, language = 'en', theme = 'light') {
  const context = await browser.newContext({ viewport: { width, height: 844 } })
  await context.addInitScript(({ android, language, theme }) => {
    localStorage.setItem('digital-core-office.language', language)
    localStorage.setItem('digital-core-office.theme', theme)
    window.scanFixture = { value: '', error: '', requests: [], hold: false, reply: null }
    if (android) window.DigitalCoreOfficeAndroid = {
      postMessage(message) {
        const request = JSON.parse(message)
        window.scanFixture.requests.push(request.action)
        if (request.action !== 'scanQr') return
        const reply = () => window.DigitalCoreOfficeAndroid.onmessage?.({ data: JSON.stringify({ requestId: request.requestId, value: window.scanFixture.value, error: window.scanFixture.error }) })
        if (window.scanFixture.hold) window.scanFixture.reply = reply
        else setTimeout(reply, 50)
      },
    }
  }, { android, language, theme })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  // Workspace fixtures isolate scroll behavior from unrelated module business data.
  await page.route(/\/(time|inventory|agile)\/index.html/, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:16px"><h1>Workspace</h1><div style="height:2400px">Scrollable workspace</div><button>Last control</button></body></html>' }))
  await page.goto('http://127.0.0.1:5198/')
  return page
}
async function login(page, de = false) {
  await page.getByLabel(de ? 'E-Mail' : 'Email', { exact: true }).fill(email)
  await page.getByLabel(de ? 'Passwort' : 'Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: de ? 'Anmelden' : 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: /QR Employee/ })).toBeVisible()
}
const action = page => page.locator('.core-device-sign-in')
const dialog = page => page.getByRole('dialog')
try {
  const desktop = await newPage(false, 1280)
  await expect(action(desktop)).toHaveCount(0)
  const challengePromise = desktop.waitForResponse(response => response.url().endsWith('/qr-login/challenges') && response.request().method() === 'POST')
  await desktop.getByRole('button', { name: 'Show QR code', exact: true }).click()
  const challenge = await (await challengePromise).json()
  const mobile = await newPage(true)
  await expect(action(mobile)).toHaveCount(0)
  await login(mobile)
  await expect(action(mobile)).toBeVisible()
  await mobile.evaluate(value => { window.scanFixture.value = value }, challenge.token)
  let approvals = 0
  mobile.on('request', request => { if (request.url().endsWith('/challenges/approve')) approvals++ })
  await action(mobile).click()
  await expect(dialog(mobile)).toContainText(email)
  await expect(dialog(mobile).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog(mobile).getByRole('button', { name: 'Cancel' }).click()
  assert.equal(approvals, 0)
  await expect(action(mobile)).toBeFocused()
  await action(mobile).click()
  await dialog(mobile).getByRole('button', { name: 'Approve sign-in', exact: true }).click()
  await expect(dialog(mobile)).toContainText('Sign-in approved')
  await expect(desktop.getByRole('heading', { name: 'Welcome, QR Employee', exact: true })).toBeVisible({ timeout: 10_000 })
  assert.equal(approvals, 1)
  await expect(action(desktop)).toHaveCount(0)
  await dialog(mobile).getByRole('button', { name: 'Close' }).click()
  await action(mobile).click()
  await dialog(mobile).getByRole('button', { name: 'Approve sign-in', exact: true }).click()
  await expect(dialog(mobile).getByRole('alert')).toContainText('expired')
  await dialog(mobile).getByRole('button', { name: 'Close' }).click()
  await mobile.evaluate(() => { window.scanFixture.value = 'https://untrusted.invalid/sign-in' })
  await action(mobile).click()
  await expect(dialog(mobile).getByRole('alert')).toContainText('your server')
  assert.equal(approvals, 2, 'unrelated QR never sent for approval')
  await dialog(mobile).getByRole('button', { name: 'Close' }).click()
  await mobile.evaluate(() => { window.scanFixture.error = 'QR-Scan abgebrochen.' })
  await action(mobile).click()
  await expect(action(mobile)).toBeEnabled()
  await expect(dialog(mobile)).not.toBeVisible()
  await mobile.evaluate(() => { window.scanFixture.error = ''; window.scanFixture.hold = true })
  await action(mobile).click()
  await mobile.getByTitle('Sign out', { exact: true }).click()
  await expect(action(mobile)).toHaveCount(0)
  await mobile.evaluate(() => window.scanFixture.reply())
  await expect(dialog(mobile)).not.toBeVisible()
  assert.equal(approvals, 2, 'scan returning after logout cannot approve')
  results.push({ realDesktopClaim: true, confirmationRequired: true, singleUse: true, invalidQrRejected: true, scannerCancel: true, lateScanAfterLogoutIgnored: true })
  await mobile.context().close()
  await desktop.getByTitle('Sign out', { exact: true }).click()
  await desktop.context().close()

  for (const [width, language, theme] of [[320, 'de', 'dark'], [390, 'en', 'light'], [1280, 'en', 'light']]) {
    const page = await newPage(true, width, language, theme)
    await login(page, language === 'de')
    for (const product of ['time', 'inventory', 'agile']) {
      await page.locator(`.dco-system-switcher a[href="/${product}/"]`).click()
      const frame = page.frameLocator('.core-workspace-frame')
      await expect(frame.getByRole('heading', { name: 'Workspace' })).toBeVisible()
      const before = await action(page).boundingBox()
      await frame.getByRole('button', { name: 'Last control' }).scrollIntoViewIfNeeded()
      const after = await action(page).boundingBox()
      assert.deepEqual(after, before)
      assert.equal(Math.round(after.x + after.width), width - 16)
      assert.equal(Math.round(after.y + after.height), 844 - 16)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    await page.screenshot({ path: `${evidence}/button-${width}-${theme}.png` })
    await page.evaluate(() => { window.scanFixture.value = 'A'.repeat(43) })
    await action(page).click()
    await expect(dialog(page)).toBeVisible()
    assert(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth))
    await page.screenshot({ path: `${evidence}/confirm-${width}-${theme}.png` })
    await page.keyboard.press('Escape')
    await expect(action(page)).toBeFocused()
    results.push({ width, theme, language, fixedAcrossThreeWorkspaces: true, longIdentityFits: true, keyboardCancel: true })
    await page.getByTitle(language === 'de' ? 'Abmelden' : 'Sign out', { exact: true }).click()
    await page.context().close()
  }
  assert.deepEqual(errors, [])
  writeFileSync(`${evidence}/browser-verification.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  await vite.close()
  await new Promise(done => api.close(done))
  closeConnection()
  rmSync(directory, { recursive: true, force: true })
}
