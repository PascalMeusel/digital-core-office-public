import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'dco-guidance-')), output = resolve('../artifacts/inventory-guidance')
const webUrl = 'http://127.0.0.1:5219', apiUrl = 'http://127.0.0.1:5301/api/inventorySystem', password = 'L7!nRf4*Kw9#pUv8'
mkdirSync(output, { recursive: true })
const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env: { ...process.env, PORT: '5301', HOST: '127.0.0.1', CORS_ORIGIN: webUrl, DCO_CORE_URL: '', DISABLE_LOCAL_WEB_LOGIN: 'false', INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'none.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'administrator@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password } })
let log = ''; api.stdout.on('data', v => log += v); api.stderr.on('data', v => log += v)
const web = await createServer({ server: { host: '127.0.0.1', port: 5219, strictPort: true }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:5301'), 'import.meta.env.VITE_ENABLED_MODULES': JSON.stringify('time,inventory') } })
let admin
async function call(path, body, session = admin) {
  const response = await fetch(apiUrl + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); assert(response.ok, `${path}: ${data.message}`); return { data, response }
}
async function login(email) { const { data, response } = await call('/auth/login', { email, password }, null); return { cookie: response.headers.getSetCookie().find(c => c.startsWith('inventory_session=')).split(';')[0], csrf: data.csrfToken } }
try {
  await web.listen(); for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:5301/api/health'); break } catch { if (i === 59) throw Error(log); await new Promise(r => setTimeout(r, 150)) } }
  admin = await login('administrator@example.test')
  await call('/users', { name: 'Developer Example', email: 'developer@example.test', role: 'software_developer', password, mustChangePassword: false })
  await call('/users', { name: 'Receiver', email: 'receiver@example.test', role: 'receiver', password, mustChangePassword: false })
  const software = await login('developer@example.test'), receiver = await login('receiver@example.test')
  const project = (await call('/projects', { name: 'DemoDevice', code: 'DEMO' })).data.projects.find(p => p.code === 'DEMO')
  const emptyProject = (await call('/projects', { name: 'New empty project', code: 'EMPTY' })).data.projects.find(p => p.code === 'EMPTY')
  const place = (await call('/locations', { name: 'Laborregal', code: 'LAB', kind: 'room' })).data.locations.find(l => l.code === 'LAB')
  const results = []
  for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({ headless: true }), errors = []
    const item = (await call('/items', { name: `DemoDevice IMU ${engineName}`, sku: `IMU-${engineName}`, unit: 'pcs', category: 'DemoDevice', supplierUrl: 'https://example.com/imu' })).data.items.find(i => i.name === `DemoDevice IMU ${engineName}`)
    await call('/catalog/import', { idempotencyKey: crypto.randomUUID(), rows: Array.from({ length: 7 }, (_, i) => ({ name: `A variant ${i} of ${item.name}`, unit: 'pcs' })) })
    await call('/catalog/import', { idempotencyKey: crypto.randomUUID(), rows: Array.from({ length: 11 }, (_, i) => ({ name: `Project part ${i + 1} ${engineName}`, unit: 'pcs', projectIds: [project.id] })) })
    const record = (await call('/records', { itemId: item.id, locationId: place.id, quantity: 5, unitCost: 2, state: 'in_stock', condition: 'new' })).data.records.find(r => r.itemId === item.id)
    await call('/records', { itemId: item.id, locationId: place.id, quantity: 20, state: 'damaged', condition: 'damaged' })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await context.addCookies([{ name: 'inventory_session', value: software.cookie.split('=')[1], url: 'http://127.0.0.1' }])
    await context.addInitScript(() => { localStorage.setItem('digital-core-office.language', 'de'); localStorage.setItem('digital-core-office.theme', 'light') })
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
    try {
      await page.goto(webUrl + '/projects'); await page.getByLabel('Projektübersicht', { exact: true }).first().selectOption(project.id); await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click()
      const dialog = page.getByRole('dialog'), input = dialog.getByLabel('Teilname oder Lieferantenlink', { exact: true })
      await expect(input).toBeInViewport(); await expect(dialog.getByLabel('Für', { exact: true })).toHaveValue(project.id)
      const catalog = dialog.getByRole('group', { name: 'Passende Artikel', exact: true }), newPart = dialog.getByRole('button', { name: 'Neues Teil anfragen', exact: true })
      await expect(input).toHaveValue(''); await expect(catalog.getByRole('button')).toHaveCount(engineName === 'chromium' ? 12 : 24)
      await expect(catalog.getByRole('button', { name: new RegExp('^' + item.name) })).toBeVisible()
      await expect(dialog.getByLabel('Menge', { exact: true })).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Zur Freigabe senden', exact: true })).toBeDisabled()
      for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await expect(input).toHaveCSS('background-color', theme === 'dark' ? 'rgb(16, 26, 40)' : 'rgb(255, 255, 255)')
        // Changing result sets must reset the inner list, not reuse a previous scroll anchor.
        async function scrollToEnd() {
          await catalog.evaluate(el => { el.scrollTop = el.scrollHeight })
          await expect.poll(() => catalog.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
        }
        async function expectListStart() {
          await expect.poll(() => catalog.evaluate(el => el.scrollTop)).toBe(0)
          await expect(catalog.getByRole('button').first()).toBeInViewport()
        }
        await scrollToEnd(); await dialog.getByLabel('Für', { exact: true }).focus(); await dialog.getByLabel('Für', { exact: true }).selectOption(''); await expectListStart()
        await expect(dialog.getByLabel('Für', { exact: true })).toBeFocused()
        await scrollToEnd(); await dialog.getByLabel('Für', { exact: true }).selectOption(project.id); await expectListStart()
        await scrollToEnd(); await dialog.getByRole('button', { name: 'Alle Artikel anzeigen', exact: true }).click(); await expectListStart()
        await scrollToEnd(); await dialog.getByRole('button', { name: 'Projektteile anzeigen', exact: true }).click(); await expectListStart()
        await scrollToEnd(); await input.fill('Project part'); await expectListStart(); await expect(input).toBeFocused()
        await scrollToEnd(); await input.fill(''); await expectListStart(); await expect(input).toBeFocused()
        await expect(newPart).toBeInViewport(); await expect(catalog.getByRole('button').first()).toBeInViewport()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: join(output, `${engineName}-visible-parts-${width}-${theme}.png`), animations: 'disabled' })
      }
      // All project parts are reachable without typing; new-part entry stays outside the scroll area.
      await catalog.getByRole('button').last().focus(); await expect(catalog.getByRole('button').last()).toBeInViewport(); await expect(newPart).toBeInViewport()
      await dialog.getByRole('button', { name: 'Alle Artikel anzeigen', exact: true }).click(); await expect(catalog).toContainText('A variant 0 of ' + item.name)
      await dialog.getByRole('button', { name: 'Projektteile anzeigen', exact: true }).click(); await expect(catalog).not.toContainText('A variant 0 of ' + item.name)
      await dialog.getByLabel('Für', { exact: true }).selectOption(emptyProject.id); await expect(dialog).toContainText('Diesem Projekt sind noch keine Teile zugeordnet')
      await dialog.getByRole('button', { name: 'Alle Artikel anzeigen', exact: true }).click(); await expect(catalog).toContainText(item.name)
      await dialog.getByLabel('Für', { exact: true }).selectOption(''); await expect(catalog).toContainText('A variant 0 of ' + item.name)
      await dialog.getByLabel('Für', { exact: true }).selectOption(project.id)
      await input.pressSequentially(item.name); await expect(input).toBeFocused()
      await expect(dialog.locator('.need-matches button').first()).toContainText('5 pcs frei verfügbar')
      await expect(catalog).toContainText('A variant 0 of ' + item.name)
      await input.fill(''); await expect(catalog).not.toContainText('A variant 0 of ' + item.name)
      // Choose the project article directly from the initial list, with an empty search.
      await dialog.getByRole('button', { name: new RegExp('^' + item.name) }).click()
      await expect(dialog).toContainText('5 pcs frei verfügbar'); await expect(dialog).toContainText('Laborregal')
      await expect(dialog.getByRole('radio', { name: 'Aus Bestand anfragen', exact: true })).toBeChecked()
      await dialog.getByRole('button', { name: 'Anderen Artikel auswählen', exact: true }).click(); await expect(input).toBeFocused(); await expect(input).toHaveValue(''); await expect(catalog).toContainText(item.name)
      await dialog.getByRole('button', { name: new RegExp('^' + item.name) }).click()
      await dialog.getByLabel('Menge', { exact: true }).fill('7'); await expect(dialog).toContainText('Dadurch wird kein Kauf angefragt')
      for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await expect(input).toHaveCSS('background-color', theme === 'dark' ? 'rgb(16, 26, 40)' : 'rgb(255, 255, 255)')
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await dialog.getByLabel('Menge', { exact: true }).focus(); await page.keyboard.press('Tab'); await expect(dialog.getByRole('radio', { name: 'Aus Bestand anfragen', exact: true })).toBeFocused()
        await page.screenshot({ path: join(output, `${engineName}-need-${width}-${theme}.png`), animations: 'disabled' })
      }
      await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Menge', { exact: true })).toHaveValue('7')
      await dialog.getByRole('button', { name: 'Bestand anfragen', exact: true }).click(); await expect(dialog).toHaveCount(0)
      let state = (await call('/state')).data, stock = state.workflows.requests.find(r => r.itemId === item.id)
      assert.equal(stock.kind, 'stock'); assert.equal(stock.quantity, 7); assert.equal(stock.projectId, project.id)
      assert.equal(state.assignments.length, engineName === 'chromium' ? 0 : 1, 'Submitting a request does not allocate stock')
      await call(`/workflows/requests/${stock.id}/fulfill`, { expectedVersion: stock.version, lines: [{ recordId: record.id, expectedVersion: record.version, quantity: 2 }] }, receiver)
      await page.goto(webUrl + '/requests'); const stockRow = page.locator(`[data-request-id="${stock.id}"]`)
      await expect(stockRow).toContainText('Teilweise ausgegeben'); await expect(stockRow).toContainText('Ausgabeteam bestätigt 5 pcs')
      await stockRow.getByText('Anfrageverlauf', { exact: true }).click(); await expect(stockRow.locator('[aria-current="step"]')).toContainText('Ausgabe')
      // A supplier link can be submitted directly as a new part; no catalog management role is needed.
      await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click()
      await input.fill('https://example.com/new-part'); await dialog.getByLabel('Name des neuen Teils', { exact: true }).fill('Neue Sensormatte ' + engineName)
      await dialog.getByLabel('Menge', { exact: true }).fill('2.5'); await dialog.getByLabel('Einheit', { exact: true }).selectOption('m²')
      await expect(dialog.getByLabel('Für', { exact: true })).toHaveValue('')
      await dialog.getByRole('button', { name: 'Zur Freigabe senden', exact: true }).click(); await expect(dialog).toHaveCount(0)
      state = (await call('/state')).data; let request = state.workflows.requests.find(r => r.itemName === 'Neue Sensormatte ' + engineName)
      assert.equal(request.itemId, undefined); assert(!request.projectId); assert.equal(request.unit, 'm²'); assert.equal(request.supplierUrl, 'https://example.com/new-part'); assert(!state.items.some(i => i.name === request.itemName))
      const row = page.locator(`[data-request-id="${request.id}"]`); await expect(row).toContainText('Wartet auf Freigabe'); await expect(row).toContainText('prüft eine freigabeberechtigte Person')
      // Real review, deferral, changes, ordering and partial receipt transitions.
      for (const [decision, note, text] of [['defer', 'Nächste Bauphase', 'Wartet auf erneute Entscheidung'], ['changes', 'Link prüfen', 'Developer Example passt die Anfrage']]) {
        request = (await call(`/workflows/requests/${request.id}/review`, { expectedVersion: request.version, decision, note })).data.workflows.requests.find(r => r.id === request.id)
        await page.reload(); await expect(row).toContainText(text); await expect(row).toContainText(note)
      }
      request = (await call(`/workflows/requests/${request.id}/edit`, { kind: 'purchase', itemName: request.itemName, unit: request.unit, quantity: request.quantity, supplierUrl: request.supplierUrl, expectedVersion: request.version }, software)).data.workflows.requests.find(r => r.id === request.id)
      state = (await call(`/workflows/requests/${request.id}/review`, { expectedVersion: request.version, decision: 'approve' })).data; request = state.workflows.requests.find(r => r.id === request.id)
      await page.reload(); await expect(row).toContainText(`${state.users.find(u => u.id === request.reviewedBy).name} bestellt beim Lieferanten`)
      let order = (await call('/workflows/orders', { supplier: 'Test supplier', reference: `GUIDE-${engineName}`, shipping: 1, lines: [{ requestId: request.id, expectedVersion: request.version, unitCost: 2 }] })).data.workflows.orders.find(o => o.reference === `GUIDE-${engineName}`)
      await page.reload(); await expect(row).toContainText('Wartet auf Lieferung: 2.5 m²')
      order = (await call(`/workflows/orders/${order.id}/receive`, { expectedVersion: order.version, lines: [{ lineId: order.lines[0].id, quantity: 1, locationId: place.id, condition: 'new' }] }, receiver)).data.workflows.orders.find(o => o.id === order.id)
      await page.reload(); await expect(row).toContainText('Teilweise eingegangen'); await expect(row).toContainText('1 / 2.5 m² eingegangen'); await expect(row).toContainText('Wartet auf Lieferung: 1.5 m²')
      await row.getByText('Anfrageverlauf', { exact: true }).click(); await expect(row.locator('[aria-current="step"]')).toContainText('Wareneingang'); await expect(row).toContainText(`GUIDE-${engineName}`); await expect(row).toContainText('Laborregal')
      await row.screenshot({ path: join(output, engineName + '-partial-progress.png') })
      await call(`/workflows/orders/${order.id}/receive`, { expectedVersion: order.version, lines: [{ lineId: order.lines[0].id, quantity: 1.5, locationId: place.id, condition: 'new' }] }, receiver)
      await page.reload(); await page.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('all'); await expect(row).toContainText('Lieferung eingebucht'); await expect(row).toContainText('2.5 / 2.5 m² eingegangen')
      // Name-only new requests remain explicit, and selecting purchase keeps that intent even with free stock.
      await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click(); await input.fill('Experimentelles neues Teil')
      await dialog.getByRole('button', { name: 'Als neues Teil anfragen: Experimentelles neues Teil', exact: true }).click(); await expect(dialog).toContainText('Neues Teil: Diese Anfrage geht zur Freigabe')
      await input.fill(item.name); await dialog.getByRole('button', { name: 'Vorhandenen Artikel verwenden: ' + item.name, exact: true }).click(); await dialog.getByRole('radio', { name: 'Kauf anfragen', exact: true }).check()
      await dialog.getByLabel('Lieferantenlink (optional)', { exact: true }).fill(''); await expect(dialog.getByLabel('Lieferantenlink (optional)', { exact: true })).toHaveValue('')
      await dialog.getByRole('button', { name: 'Zur Freigabe senden', exact: true }).click(); await expect(dialog).toHaveCount(0)
      state = (await call('/state')).data; const purchase = state.workflows.requests.find(r => r.itemId === item.id && r.kind === 'purchase'); assert(purchase); assert.equal(purchase.quantity, 1)
      await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click(); await input.fill('https://example.com/alternate-supplier'); await dialog.getByLabel('Name des neuen Teils', { exact: true }).fill(item.name)
      await dialog.getByRole('button', { name: 'Zur Freigabe senden', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Diesen Artikel gibt es bereits')
      await dialog.getByRole('button', { name: 'Vorhandenen Artikel verwenden: ' + item.name, exact: true }).click(); await expect(dialog.getByLabel('Lieferantenlink (optional)', { exact: true })).toHaveValue('https://example.com/alternate-supplier')
      await expect(dialog.getByRole('radio', { name: 'Kauf anfragen', exact: true })).toBeChecked(); await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
      // The separate new-part entry works with an empty search and never hides below the catalog.
      await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click(); await newPart.click(); await expect(input).toBeFocused()
      await input.pressSequentially('Neue Laborleitung ' + engineName); await expect(input).toBeFocused(); await expect(dialog.getByRole('button', { name: 'Vorhandenen Artikel auswählen', exact: true })).toBeVisible()
      await dialog.getByLabel('Menge', { exact: true }).fill('2'); await dialog.getByRole('button', { name: 'Zur Freigabe senden', exact: true }).click(); await expect(dialog).toHaveCount(0)
      state = (await call('/state')).data; assert.equal(state.workflows.requests.find(r => r.itemName === 'Neue Laborleitung ' + engineName).quantity, 2)
      assert.deepEqual(errors, []); results.push({ browser: engineName, role: 'software_developer', quickStock: true, linkNewPart: true, explicitPurchase: true, noImplicitReservation: true, progress: ['approval', 'deferred', 'changes', 'approved', 'ordered', 'partial', 'received'], themesAndMobile: true })
    } catch (error) { await page.screenshot({ path: join(output, engineName + '-failure.png'), fullPage: true }); writeFileSync(join(output, engineName + '-failure.txt'), await page.locator('body').innerText()); throw error } finally { await browser.close() }
  }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results))
} finally { await web.close(); api.kill(); await new Promise(r => api.exitCode !== null ? r() : api.once('exit', r)); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) }
