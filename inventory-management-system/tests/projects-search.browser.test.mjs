// Real isolated API + browser: node tests/projects-search.browser.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'dco-project-browser-'))
const output = resolve('../artifacts/inventory-projects')
mkdirSync(output, { recursive: true })
const apiUrl = 'http://127.0.0.1:5287/api/inventorySystem'
const webUrl = 'http://127.0.0.1:5201'
const password = 'L7!nRf4*Kw9#pUv8'
const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env: { ...process.env,
  PORT: '5287', HOST: '127.0.0.1', CORS_ORIGIN: webUrl, DCO_CORE_URL: '', DISABLE_LOCAL_WEB_LOGIN: 'false',
  INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_MEDIA_DIR: join(directory, 'media'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'absent.json'),
  INVENTORY_SYSTEM_ADMIN_NAME: 'Inventory tester', INVENTORY_SYSTEM_ADMIN_EMAIL: 'inventory@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password,
} })
let apiLog = ''
api.stdout.on('data', data => apiLog += data)
api.stderr.on('data', data => apiLog += data)
const web = await createServer({ server: { host: '127.0.0.1', port: 5201, strictPort: true }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:5287') } })
let cookie, csrf
async function request(path, method = 'GET', body) {
  const response = await fetch(apiUrl + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie, 'x-inventory-csrf': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const value = await response.json()
  assert.ok(response.ok, value.message)
  return { value, response }
}
try {
  await web.listen()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch('http://127.0.0.1:5287/api/health').then(r => r.ok).catch(() => false)) break
    if (api.exitCode !== null) throw Error(apiLog)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const login = await request('/auth/login', 'POST', { email: 'inventory@example.test', password })
  cookie = login.response.headers.getSetCookie().find(value => value.startsWith('inventory_session=')).split(';')[0]
  csrf = login.value.csrfToken
  const room = (await request('/locations', 'POST', { name: 'München Lab', code: 'LAB', kind: 'room' })).value.locations[0]
  for (const [name, sku, manufacturer, part] of [['Cordless drill', 'DRILL-01', 'Bosch', 'GSR-18V'], ['Resistor assortment', 'R-100', 'Vishay', 'C123456']]) {
    const itemState = (await request('/items', 'POST', { name, sku, manufacturer, manufacturerPartNumber: part })).value
    const item = itemState.items.find(item => item.sku === sku)
    await request('/records', 'POST', { itemId: item.id, locationId: room.id, quantity: 10, state: 'in_stock', condition: 'usable' })
  }
  await request('/users', 'POST', { name: 'Read only viewer', email: 'viewer@example.test', role: 'viewer', password, mustChangePassword: false })
  const results = []
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({ headless: true })
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      await context.addCookies([{ name: 'inventory_session', value: cookie.split('=')[1], url: 'http://127.0.0.1' }])
      await context.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(webUrl + '/inventory')
      await page.getByText('Advanced stock records', { exact: true }).click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${output}/startup.png`, fullPage: true })
      const search = page.getByRole('searchbox', { name: 'Search item, part number, place, project' })
      await search.fill('bosch drill')
      await expect(page.locator('.stock-record-table tbody')).toContainText('Cordless drill')
      await expect(page.locator('.stock-record-table tbody')).not.toContainText('Resistor assortment')
      await search.fill('zzzzzz')
      await expect(page.locator('.stock-record-table tbody')).not.toContainText('Cordless drill')
      await page.getByRole('button', { name: 'Clear search and filters', exact: true }).click()
      await expect(search).toHaveValue('')
      const nav = page.locator('.inventory-desktop-navigation')
      await nav.getByRole('button', { name: 'Articles & stock', exact: true }).click()
      await page.getByRole('button', { name: 'Parts & materials', exact: true }).click()
      await page.getByPlaceholder('Search item, SKU, manufacturer, or part number').fill('bosch GSR 18v')
      await expect(page.locator('.catalog-card-grid')).toContainText('Cordless drill')
      await expect(page.locator('.catalog-card-grid')).not.toContainText('Resistor assortment')
      await nav.getByRole('button', { name: 'Projects', exact: true }).click()
      await page.getByRole('tab', { name: 'Assignments', exact: true }).click()
      await page.getByText('Assign stock directly / manage existing assignments', { exact: true }).click()
      const projectPanel = page.locator('.inventory-projects')
      await projectPanel.getByRole('button', { name: 'New project', exact: true }).click()
      const projectName = `Laboratory expansion and equipment for the north building — ${name}`
      await page.getByLabel('Project name', { exact: true }).fill(projectName)
      await page.getByLabel('Project code', { exact: true }).fill(`LAB-${name}`)
      await page.getByLabel('Description', { exact: true }).fill('Long project description. '.repeat(18))
      await page.getByRole('button', { name: 'Save project', exact: true }).click()
      await page.getByRole('button').filter({ hasText: projectName }).click()
      await page.getByRole('button', { name: 'Assign items', exact: true }).click()
      const allocation = page.locator('.project-editor')
      await allocation.getByLabel('Search stock', { exact: true }).fill('bosch')
      await expect(allocation.getByLabel('Stock record', { exact: true }).locator('option')).toHaveCount(2)
      await allocation.getByLabel('Stock record', { exact: true }).selectOption({ index: 1 })
      await allocation.getByLabel('Quantity', { exact: true }).fill('3')
      await allocation.getByLabel('Note', { exact: true }).fill('For the laboratory benches')
      await allocation.getByRole('button', { name: 'Save assignment', exact: true }).click()
      await expect(page.locator('.project-stock-table')).toContainText('Cordless drill')
      await page.reload()
      await page.getByRole('tab', { name: 'Assignments', exact: true }).click()
      await page.getByText('Assign stock directly / manage existing assignments', { exact: true }).click()
      await projectPanel.getByLabel('Project overview', { exact: true }).selectOption({ label: `LAB-${name} — ${projectName}` })
      await expect(page.locator('.project-stock-table')).toContainText('For the laboratory benches')
      for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await projectPanel.getByRole('button', { name: 'Edit project', exact: true }).click()
        const form = page.locator('.project-editor')
        await expect(form.getByLabel('Project name', { exact: true })).toHaveValue(projectName)
        await form.getByRole('combobox', { name: 'Status', exact: true }).focus()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Escape')
        expect(await form.locator('input,textarea,select').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().right <= innerWidth + 1))).toBe(true)
        if (name === 'chromium') await page.screenshot({ path: `${output}/projects-${width}-${theme}.png`, fullPage: true })
        await form.getByRole('button', { name: 'Cancel', exact: true }).click()
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await nav.getByRole('button', { name: 'Articles & stock', exact: true }).click()
      await page.getByText('Advanced stock records', { exact: true }).click()
      await search.fill(`LAB-${name}`)
      await expect(page.locator('.stock-record-table tbody')).toContainText('Cordless drill')
      await expect(page.locator('.stock-record-table tbody')).not.toContainText('Resistor assortment')
      await nav.getByRole('button', { name: 'Projects', exact: true }).click()
      await page.getByRole('tab', { name: 'Assignments', exact: true }).click()
      await page.getByText('Assign stock directly / manage existing assignments', { exact: true }).click()
      await projectPanel.getByLabel('Project overview', { exact: true }).selectOption({ label: `LAB-${name} — ${projectName}` })
      await projectPanel.getByRole('button', { name: 'Return items', exact: true }).click()
      await page.getByText('Return history (1)', { exact: true }).click()
      await expect(page.locator('details .project-stock-table')).toContainText('Cordless drill')
      const viewerLogin = await request('/auth/login', 'POST', { email: 'viewer@example.test', password })
      const viewerCookie = viewerLogin.response.headers.getSetCookie().find(value => value.startsWith('inventory_session=')).split(';')[0]
      await context.addCookies([{ name: 'inventory_session', value: viewerCookie.split('=')[1], url: 'http://127.0.0.1' }])
      await page.goto(webUrl + '/projects')
      await expect(page.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0)
      await page.getByRole('tab', { name: 'Assignments', exact: true }).click()
      await page.getByText('Assign stock directly / manage existing assignments', { exact: true }).click()
      await page.getByLabel('Search projects', { exact: true }).fill(`LAB-${name}`)
      await expect(page.locator('.project-directory')).toContainText(projectName)
      assert.deepEqual(errors, [])
      results.push({ browser: name, search: true, assignmentPersistence: true, projectSearch: true, returns: true, viewer: true, themesAndResponsive: true })
    } finally { await browser.close() }
  }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
} finally {
  await web.close()
  api.kill()
  await new Promise(resolve => api.exitCode !== null ? resolve() : api.once('exit', resolve))
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  rmSync(directory, { recursive: true, force: true })
}
