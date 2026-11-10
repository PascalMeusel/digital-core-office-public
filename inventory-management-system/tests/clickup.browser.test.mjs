// Real inventory API/database and browser UI; only ClickUp's external API is simulated.
import assert from 'node:assert/strict'
import { createServer as httpServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'dco-clickup-browser-')), output = resolve('../artifacts/inventory-clickup')
mkdirSync(output, { recursive: true })
const webUrl = 'http://127.0.0.1:5211', apiUrl = 'http://127.0.0.1:5293/api/inventorySystem', password = 'L7!nRf4*Kw9#pUv8', token = 'pk_clickup_browser_123456'
Object.assign(process.env, { INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_MEDIA_DIR: join(directory, 'media'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'none.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'admin@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password, DISABLE_LOCAL_WEB_LOGIN: 'false', INVENTORY_CLICKUP_TOKEN_KEY: Buffer.alloc(32, 23).toString('base64'), DCO_CORE_URL: '' })
const originalFetch = globalThis.fetch, tasks = [], writes = [], softwareToken = 'pk_software_browser_654321'
let denySoftwareLists = false
const lists = [{ id: '101', name: 'DemoDevice', space: { id: '11', name: 'Hardware development and laboratory experiments with long project names' }, folder: { id: '21', name: 'Projects' } }, { id: '102', name: 'DemoDevice', space: { id: '12', name: 'Software' }, folder: { hidden: true } }]
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input)); if (url.hostname !== 'api.clickup.com') return originalFetch(input, options)
  const path = url.pathname.replace('/api/v2', ''), method = options?.method ?? 'GET'
  const result = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  if (path === '/user') return result({ user: { username: 'ClickUp colleague' } })
  if (path === '/team') return result({ teams: [{ id: '7', name: 'ExampleCompany' }] })
  if (path === '/team/7/space') return result({ spaces: lists.map(l => l.space) })
  if (path === '/space/11/folder') return result({ folders: [lists[0].folder] })
  if (path === '/space/12/folder') return result({ folders: [] })
  if (path === '/space/11/list') return result({ lists: [] })
  if (path === '/space/12/list') return result({ lists: [lists[1]] })
  if (path === '/folder/21/list') return result({ lists: [lists[0]] })
  if (denySoftwareLists && options?.headers?.Authorization === softwareToken && /^\/list\/\d+$/.test(path)) return new Response('{}', { status: 403 })
  if (/^\/list\/\d+$/.test(path)) return result(lists.find(l => l.id === path.split('/')[2]))
  if (/^\/list\/\d+\/task$/.test(path)) {
    const listId = path.split('/')[2]
    if (method === 'GET') return result({ tasks: tasks.filter(t => t.list.id === listId), last_page: true })
    const body = JSON.parse(options.body), task = { id: `task${tasks.length + 1}`, name: body.name, list: { id: listId }, markdown_description: body.markdown_content, status: { status: 'open' } }
    writes.push(body); tasks.push(task); return result(task)
  }
  if (path.startsWith('/task/')) return result(tasks.find(t => t.id === path.split('/')[2]))
  throw new Error(`Unexpected ClickUp call ${path}`)
}
const { inventorySystemRouter, closeInventorySystemDatabase } = await import('../server/inventorySystem.ts')
const app = express(); app.use(cors({ origin: webUrl, credentials: true })); app.use(express.json()); app.use('/api/inventorySystem', inventorySystemRouter)
const api = httpServer(app); await new Promise(resolve => api.listen(5293, '127.0.0.1', resolve))
const web = await createServer({ server: { host: '127.0.0.1', port: 5211, strictPort: true }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:5293') } })
let admin
async function request(path, body, session = admin) {
  const response = await originalFetch(apiUrl + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const value = await response.json(); assert.ok(response.ok, `${path}: ${value.message}`); return { value, response }
}
async function login(email) { const { value, response } = await request('/auth/login', { email, password }, null); return { cookie: response.headers.getSetCookie().find(c => c.startsWith('inventory_session=')).split(';')[0], csrf: value.csrfToken } }
const results = []
try {
  await web.listen(); admin = await login('admin@example.test')
  await request('/users', { name: 'Developer', email: 'developer@example.test', role: 'software_developer', password, mustChangePassword: false })
  const software = await login('developer@example.test')
  for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({ headless: true }), errors = []
    const project = (await request('/projects', { name: `DemoDevice ${engineName}`, code: `DEMO-${engineName}` })).value.projects.find(p => p.code === `DEMO-${engineName}`)
    const data = (await request('/workflows/requests/batch', { projectId: project.id, lines: [{ itemName: 'Sensorstripe', quantity: 4 }, { itemName: 'IMU case', quantity: 1 }] }, software)).value
    const group = data.workflows.requests.filter(r => r.projectId === project.id)
    let adminPage, sw
    try {
      async function page(session) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); await context.addCookies([{ name: 'inventory_session', value: session.cookie.split('=')[1], url: 'http://127.0.0.1' }]); await context.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return page
      }
      adminPage = await page(admin); sw = await page(software)
      await request('/clickup/disconnect', {}); await request('/clickup/disconnect', {}, software)
      await adminPage.goto(webUrl + '/projects'); await adminPage.getByLabel('Project overview', { exact: true }).first().selectOption(project.id)
      await adminPage.getByText('Project details & ClickUp', { exact: true }).click()
      const panel = adminPage.locator('.clickup-panel').first()
      await panel.locator(':scope > summary').click()
      await panel.getByLabel('Personal ClickUp API token').fill(token); await panel.getByRole('button', { name: 'Connect ClickUp', exact: true }).click()
      await expect(panel.getByText('My ClickUp account', { exact: false })).toBeVisible()
      await expect(panel).toContainText('Account connected. No ClickUp list is linked to')
      await sw.goto(webUrl + '/projects'); await sw.getByLabel('Project overview', { exact: true }).first().selectOption(project.id)
      await sw.getByText('Project details & ClickUp', { exact: true }).click()
      const swPanel = sw.locator('.clickup-panel').first(); await swPanel.locator(':scope > summary').click()
      await swPanel.getByLabel('Personal ClickUp API token').fill(softwareToken); await swPanel.getByRole('button', { name: 'Connect ClickUp', exact: true }).click()
      await expect(swPanel).toContainText('Account connected. No ClickUp list is linked to')
      await expect(swPanel).toContainText('An inventory administrator or someone who manages projects must link the team lists once')
      await expect(swPanel.getByRole('button', { name: 'Add team list', exact: true })).toHaveCount(0)
      await sw.setViewportSize({ width: 390, height: 844 }); await swPanel.screenshot({ path: join(output, engineName + '-missing-project-setup.png') })
      for (const [space, folder, list] of [['11', '21', '101'], ['12', '', '102']]) {
        await panel.getByRole('button', { name: 'Add team list', exact: true }).click()
        await panel.getByLabel('Workspace', { exact: true }).selectOption('7')
        await panel.getByLabel('Space / Team', { exact: true }).selectOption(space)
        if (folder) await panel.getByLabel('Folder', { exact: true }).selectOption(folder)
        await panel.getByLabel('Project list', { exact: true }).selectOption(list)
        await panel.getByRole('button', { name: 'Link list', exact: true }).click()
        await expect(panel.getByRole('button', { name: 'Add team list', exact: true })).toBeVisible()
      }
      await expect(panel).toContainText('ExampleCompany / Software / DemoDevice')
      await expect(panel).toContainText('Hardware development and laboratory experiments')
      denySoftwareLists = true; await swPanel.getByRole('button', { name: 'Refresh setup', exact: true }).click()
      await expect(swPanel).toContainText('Project lists exist, but your ClickUp account cannot access them.')
      await expect(swPanel).not.toContainText('ExampleCompany / Software / DemoDevice')
      await expect(swPanel).toContainText('Ask the ClickUp list owner to give your account access')
      denySoftwareLists = false; await swPanel.getByRole('button', { name: 'Refresh setup', exact: true }).click()
      await expect(swPanel).toContainText('ExampleCompany / Software / DemoDevice')
      await sw.setViewportSize({ width: 1440, height: 1100 })

      await sw.goto(webUrl + '/projects'); await sw.getByLabel('Project overview', { exact: true }).first().selectOption(project.id)
      await sw.getByRole('tab', { name: 'Requests', exact: true }).click()
      const batch = sw.locator(`[data-batch-id="${group[0].batchId}"]`), links = batch.locator('.clickup-request')
      await links.locator(':scope > summary').click()
      await expect(links).toContainText('My ClickUp account')
      await links.getByLabel('Team list', { exact: true }).selectOption('101')
      await links.getByText('Preview content sent to ClickUp', { exact: true }).click()
      await expect(links.locator('pre')).toContainText('4 pcs Sensorstripe'); await expect(links.locator('pre')).toContainText('IMU case')
      const before = writes.length
      await links.getByRole('button', { name: 'Create ClickUp task', exact: true }).click()
      await expect(links.getByRole('link').filter({ hasText: 'Inventarpositionen' })).toHaveCount(1)
      assert.equal(writes.length, before + 1)
      tasks.push({ id: `existing${engineName}`, name: 'Existing software task with a long name for the experimental hardware verification procedure', list: { id: '102' }, markdown_description: 'Keep unchanged', status: { status: 'in progress' } })
      await links.getByLabel('Action', { exact: true }).selectOption('link')
      await links.getByLabel('Existing task', { exact: true }).selectOption(`existing${engineName}`)
      await links.getByLabel('Find on this page', { exact: true }).fill('not a matching task name')
      await expect(links.getByLabel('Existing task', { exact: true })).toHaveValue(`existing${engineName}`)
      await expect(links.getByLabel('Existing task', { exact: true }).locator('option:checked')).toContainText('Existing software task')
      let unexpectedLinks = 0
      const trackLink = request => { if (request.method() === 'POST' && /\/clickup\/requests\/[^/]+\/link$/.test(request.url())) unexpectedLinks++ }
      sw.on('request', trackLink)
      await links.getByLabel('Find on this page', { exact: true }).press('Enter')
      await sw.waitForTimeout(200)
      assert.equal(unexpectedLinks, 0, 'Searching must not submit an external task link')
      await expect(links.getByRole('button', { name: 'Link task', exact: true })).toBeVisible()
      await links.getByRole('button', { name: 'Link task', exact: true }).click()
      await expect(links).toContainText('in progress'); assert.equal(writes.length, before + 1)
      assert.equal(unexpectedLinks, 1, 'Only the explicit Link task button submits the selected task')
      sw.off('request', trackLink)
      assert.ok(!await sw.evaluate(secret => JSON.stringify(localStorage).includes(secret), token), 'ClickUp token must never be stored in localStorage')
      for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
        await sw.setViewportSize({ width, height: 1100 }); await sw.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await expect.poll(() => sw.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await links.getByRole('button', { name: 'Refresh ClickUp status', exact: true }).focus(); await sw.keyboard.press('Tab')
        assert.ok(await sw.evaluate(() => document.activeElement?.tagName !== 'BODY'))
        await expect(links).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        if (engineName === 'chromium') await links.screenshot({ path: join(output, `clickup-${width}-${theme}.png`) })
        await (width === 390 ? sw.locator('.inventory-mobile-navigation > summary') : sw.getByText('More tools', { exact: true })).click(); const menu = sw.locator(width === 390 ? '.inventory-mobile-navigation > nav' : '.inventory-more-menu > div'); await expect(menu).toBeVisible()
        assert.ok(await menu.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1 && el.getBoundingClientRect().left >= 0))
        await (width === 390 ? sw.locator('.inventory-mobile-navigation > summary') : sw.getByText('More tools', { exact: true })).click()
      }
      // Keep open native selects and long list paths inside a narrow screen.
      await adminPage.setViewportSize({ width: 390, height: 1000 }); await panel.getByRole('button', { name: 'Add team list', exact: true }).click()
      await panel.getByLabel('Workspace', { exact: true }).selectOption('7'); await panel.getByLabel('Space / Team', { exact: true }).focus(); await adminPage.keyboard.press('ArrowDown'); await adminPage.keyboard.press('Escape')
      assert.ok(await panel.locator('select').evaluateAll(elements => elements.every(el => el.getBoundingClientRect().right <= innerWidth + 1)))
      assert.deepEqual(errors, []); results.push({ browser: engineName, connection: true, perUser: true, teamHierarchy: true, batchCreation: true, existingTasks: true, searchRetainsSelection: true, searchEnterDoesNotLink: true, mobile: true, themes: true, longContent: true, menusAndKeyboard: true })
    } catch (error) {
      for (const [label, page] of [['admin', adminPage], ['software', sw]]) if (page) { await page.screenshot({ path: join(output, `failure-${engineName}-${label}.png`), fullPage: true }); writeFileSync(join(output, `failure-${engineName}-${label}.txt`), await page.locator('body').innerText()) }
      throw error
    } finally { await browser.close() }
  }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results))
} finally {
  globalThis.fetch = originalFetch; await web.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); closeInventorySystemDatabase()
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true })
}
