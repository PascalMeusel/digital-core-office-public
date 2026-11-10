import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'dco-inventory-workday-')), output = resolve('../artifacts/inventory-workday')
const webUrl = 'http://127.0.0.1:5223', apiUrl = 'http://127.0.0.1:5305/api/inventorySystem', password = 'L7!nRf4*Kw9#pUv8'
mkdirSync(output, { recursive: true })
const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env: { ...process.env, PORT: '5305', HOST: '127.0.0.1', CORS_ORIGIN: webUrl, DCO_CORE_URL: '', DISABLE_LOCAL_WEB_LOGIN: 'false', INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'none.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'administrator@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password } })
let log = ''; api.stdout.on('data', v => log += v); api.stderr.on('data', v => log += v)
const web = await createServer({ server: { host: '127.0.0.1', port: 5223, strictPort: true }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:5305'), 'import.meta.env.VITE_ENABLED_MODULES': JSON.stringify('time,inventory') } })
let admin
async function call(path, body, session = admin) {
  const response = await fetch(apiUrl + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); assert(response.ok, `${path}: ${data.message}`); return { data, response }
}
async function login(email) { const { data, response } = await call('/auth/login', { email, password }, null); return { cookie: response.headers.getSetCookie().find(c => c.startsWith('inventory_session=')).split(';')[0], csrf: data.csrfToken, id: data.currentUser.id } }
async function checkContrast(surface, label) {
  const problems = await surface.evaluate(root => {
    const rgb = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const luminance = value => rgb(value).map(channel => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0)
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
    const background = el => { for (let node = el; node; node = node.parentElement) { const color = getComputedStyle(node).backgroundColor; if (!color.startsWith('rgba') && color !== 'transparent') return color } return 'rgb(255,255,255)' }
    return [...root.querySelectorAll('input,select,textarea,button,summary,small,strong,p,label > span,a')].filter(el => el.getClientRects().length && !el.matches(':disabled') && !el.closest('fieldset:disabled')).flatMap(el => {
      const style = getComputedStyle(el), bg = background(el), text = ratio(style.color, bg), border = el.matches('input,select,textarea') ? ratio(style.borderTopColor, bg) : 3
      return text < 4.5 || border < 3 ? [{ label: (el.getAttribute('aria-label') || el.textContent || el.name).slice(0, 70), text, border, color: style.color, background: bg }] : []
    })
  })
  assert.deepEqual(problems, [], label + ' contrast')
}
try {
  await web.listen(); for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:5305/api/health'); break } catch { if (i === 59) throw Error(log); await new Promise(r => setTimeout(r, 150)) } }
  admin = await login('administrator@example.test')
  const sessions = {}
  for (const [key, name, role] of [['developer', 'Developer Example', 'software_developer'], ['buyer', 'Buyer Example', 'buyer'], ['receiver', 'Receiver', 'receiver']]) {
    await call('/users', { name, email: key + '@example.test', role, password, mustChangePassword: false }); sessions[key] = await login(key + '@example.test')
  }
  const project = (await call('/projects', { name: 'DemoDevice', code: 'DEMO' })).data.projects.find(p => p.code === 'DEMO')
  const other = (await call('/projects', { name: 'DemoStorage', code: 'DEMO-STORAGE' })).data.projects.find(p => p.code === 'DEMO-STORAGE')
  const a = (await call('/items', { name: 'DEMO PCB', sku: 'DEMO-PCB', unit: 'pcs', projectIds: [project.id, other.id], supplierUrl: 'https://example.com/pcb', estimatedUnitCost: 5 })).data.items.find(i => i.sku === 'DEMO-PCB')
  const b = (await call('/items', { name: 'Sensorstripe', sku: 'DEMO-STRIPE', unit: 'pcs', projectIds: [project.id], supplierUrl: 'https://example.com/stripe' })).data.items.find(i => i.sku === 'DEMO-STRIPE')
  const mat = (await call('/items', { name: 'Mat material', sku: 'DEMO-MAT', unit: 'm²', projectIds: [project.id] })).data.items.find(i => i.sku === 'DEMO-MAT')
  const lab = (await call('/locations', { name: 'Soldering room', code: 'LAB', kind: 'room' })).data.locations.find(place => place.code === 'LAB')
  const office = (await call('/locations', { name: 'Office', code: 'OFF', kind: 'room' })).data.locations.find(place => place.code === 'OFF')
  const shelf = (await call('/locations', { name: 'Parts shelf', code: 'LAB-SHELF', kind: 'fixture', parentId: lab.id })).data.locations.find(place => place.code === 'LAB-SHELF')
  const labBox = (await call('/locations', { name: 'Component box', code: 'LAB-BOX', kind: 'container', parentId: shelf.id })).data.locations.find(place => place.code === 'LAB-BOX')
  const officeShelf = (await call('/locations', { name: 'Parts shelf', code: 'OFF-SHELF', kind: 'fixture', parentId: office.id })).data.locations.find(place => place.code === 'OFF-SHELF')
  const officeBox = (await call('/locations', { name: 'Component box', code: 'OFF-BOX', kind: 'container', parentId: officeShelf.id })).data.locations.find(place => place.code === 'OFF-BOX')
  for (const [itemId, locationId, quantity, recordState = 'in_stock'] of [[a.id, labBox.id, 10], [a.id, officeBox.id, 4], [mat.id, labBox.id, 2.5], [b.id, officeBox.id, 3], [b.id, labBox.id, 1, 'retired']]) await call('/records', { itemId, locationId, quantity, state: recordState, condition: 'new' })
  let state = (await call('/workflows/requests/batch', { projectId: project.id, supplier: 'Example Supplier', reason: 'Grouped hardware order', lines: [{ itemId: a.id, quantity: 2 }, { itemId: b.id, quantity: 4 }] }, sessions.developer)).data
  const group = state.workflows.requests.filter(r => r.reason === 'Grouped hardware order'), first = group.find(r => r.itemId === a.id), second = group.find(r => r.itemId === b.id)
  await call(`/workflows/request-batches/${first.batchId}/review`, { lines: [{ requestId: first.id, expectedVersion: first.version, decision: 'approve' }, { requestId: second.id, expectedVersion: second.version, decision: 'defer', note: 'Confirm stripe length' }] })
  state = (await call('/workflows/requests', { kind: 'purchase', itemId: a.id, projectId: other.id, quantity: 1, reason: 'Buyer order' }, sessions.developer)).data
  const otherRequest = state.workflows.requests.find(r => r.reason === 'Buyer order'); await call(`/workflows/requests/${otherRequest.id}/review`, { expectedVersion: otherRequest.version, decision: 'approve' }, sessions.buyer)
  state = (await call('/workflows/requests', { kind: 'purchase', itemName: 'General experiment cable', quantity: 1, reason: 'Needs requester input' }, sessions.developer)).data
  const changes = state.workflows.requests.find(r => r.reason === 'Needs requester input'); await call(`/workflows/requests/${changes.id}/review`, { expectedVersion: changes.version, decision: 'changes', note: 'Add connector specification' })
  state = (await call('/workflows/requests', { kind: 'stock', itemId: a.id, quantity: 1, usage: 'borrow', reason: 'Borrow for software testing' }, sessions.developer)).data
  const handout = state.workflows.requests.find(r => r.reason === 'Borrow for software testing')
  for (let i = 0; i < 30; i++) await call('/workflows/requests', { kind: 'purchase', itemName: `General lab supply ${i}`, quantity: 1 }, sessions.developer)
  const results = []
  for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({ headless: true }), errors = []
    async function openPage(session) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await context.addCookies([{ name: 'inventory_session', value: session.cookie.split('=')[1], url: 'http://127.0.0.1' }]); await context.addInitScript(() => localStorage.setItem('digital-core-office.language', 'de'))
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(webUrl + '/requests'); return page
    }
    const page = await openPage(sessions.developer), buyer = await openPage(admin), receiver = await openPage(sessions.receiver)
    try {
      const queue = page.getByRole('region', { name: 'Anfrageübersicht', exact: true })
      await queue.getByLabel('Projektfilter', { exact: true }).selectOption(project.id); await queue.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('approved')
      await expect(queue.locator('[data-request-id]')).toHaveCount(2); await expect(queue).toContainText('Zurückgestellt'); await expect(queue).toContainText('Sammelanfragen werden immer mit allen Positionen angezeigt')
      await queue.getByLabel('Anfragen suchen', { exact: true }).fill('DEMO PCB Example Supplier'); await expect(queue.locator('[data-request-id]')).toHaveCount(2)
      await queue.getByLabel('Anfragen suchen', { exact: true }).fill('Sensorstripe PCB'); await expect(queue.locator('[data-request-id]')).toHaveCount(2)
      await queue.getByLabel('Projektfilter', { exact: true }).selectOption(other.id); await expect(queue.locator('[data-request-id]')).toHaveCount(0)
      await queue.getByRole('button', { name: 'Filter zurücksetzen', exact: true }).click(); await queue.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('action'); await expect(queue.locator('[data-request-id]')).toHaveCount(1); await expect(queue.locator(`[data-request-id="${changes.id}"]`)).toBeVisible()
      await queue.getByLabel('Projektfilter', { exact: true }).selectOption(''); await expect(queue.locator(`[data-request-id="${changes.id}"]`)).toBeVisible()
      await receiver.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('action'); await expect(receiver.locator('.request-queue [data-request-id]')).toHaveCount(1); await expect(receiver.locator(`[data-request-id="${handout.id}"]`)).toBeVisible()
      await buyer.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('action'); await expect(buyer.locator(`[data-request-id="${otherRequest.id}"]`)).toHaveCount(0)
      // A decision on an individual request opens beside the current work even
      // when the unfiltered queue is many screens long.
      state = (await call('/workflows/requests', { kind: 'purchase', itemName: 'Decision audit ' + engineName, quantity: 1 }, sessions.developer)).data
      const single = state.workflows.requests.find(r => r.itemName === 'Decision audit ' + engineName)
      await buyer.reload(); const row = buyer.locator(`[data-request-id="${single.id}"]`), defer = row.getByRole('button', { name: 'Zurückstellen', exact: true })
      await defer.click(); const dialog = buyer.getByRole('dialog'); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Begründung', { exact: true })).toBeFocused()
      await dialog.getByLabel('Begründung', { exact: true }).fill('Need the exact connector'); await buyer.keyboard.press('Escape'); await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Begründung', { exact: true })).toHaveValue('Need the exact connector')
      await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click(); await expect(defer).toBeFocused(); await defer.click(); await dialog.getByLabel('Begründung', { exact: true }).fill('Need the exact connector')
      await dialog.getByRole('button', { name: 'Entscheidung speichern', exact: true }).click(); await expect(dialog).toHaveCount(0)
      const saved = (await call('/state')).data.workflows.requests.find(r => r.id === single.id); assert.equal(saved.status, 'deferred'); assert.equal(saved.decisionNote, 'Need the exact connector')
      // The project request tab reuses the queue, keeps project context fixed,
      // and resets its filters when the project changes.
      await page.goto(webUrl + '/projects'); await page.getByLabel('Projektübersicht', { exact: true }).first().selectOption(project.id); await page.getByRole('tab', { name: 'Anfragen', exact: true }).click()
      const panel = page.getByRole('tabpanel', { name: 'Anfragen', exact: true }); await expect(panel.getByLabel('Projektfilter', { exact: true })).toHaveCount(0); await panel.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('deferred'); await expect(panel.locator('[data-request-id]')).toHaveCount(2)
      await page.getByLabel('Projektübersicht', { exact: true }).first().selectOption(''); await expect(panel.getByLabel('Anfragen anzeigen', { exact: true })).toHaveValue('open'); await expect(panel.locator(`[data-request-id="${first.id}"]`)).toHaveCount(0)
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await panel.getByLabel('Anfragen anzeigen', { exact: true }).selectOption('action'); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ animations: 'disabled', path: join(output, `${engineName}-queue-${width}-${theme}.png`), fullPage: true })
      }
      await page.goto(webUrl + '/inventory'); const stockFilters = page.locator('.workflow-page > .workflow-body > .workflow-filters'), stockItems = page.locator('.workflow-stock-item')
      await stockFilters.getByLabel('Ort', { exact: true }).selectOption(lab.id); await expect(stockItems).toHaveCount(2); await expect(stockItems.filter({ hasText: a.name }).locator('summary')).toContainText('10 pcs')
      await expect(stockItems.filter({ hasText: mat.name }).locator('summary')).toContainText('2,5 m²'); await expect(stockFilters.getByLabel('Ort', { exact: true }).locator(`option[value="${labBox.id}"]`)).toContainText('LAB · Soldering room › LAB-SHELF · Parts shelf › LAB-BOX · Component box')
      await stockFilters.getByLabel('Bestand suchen', { exact: true }).fill('Soldering DEMO-PCB'); await expect(stockItems).toHaveCount(1)
      await page.getByRole('button', { name: 'Suche und Filter zurücksetzen', exact: true }).click(); await stockFilters.getByLabel('Bestand suchen', { exact: true }).fill('DemoStorage'); await expect(stockItems).toHaveCount(1); await expect(stockItems.first()).toContainText(a.name)
      await stockFilters.getByLabel('Bestand suchen', { exact: true }).fill(''); await stockFilters.getByLabel('Ort', { exact: true }).selectOption(office.id); await expect(stockItems).toHaveCount(2); await expect(stockItems.filter({ hasText: a.name }).locator('summary')).toContainText('4 pcs')
      await stockItems.filter({ hasText: a.name }).locator('summary').click(); await expect(stockItems.filter({ hasText: a.name })).toContainText('OFF · Office › OFF-SHELF · Parts shelf › OFF-BOX · Component box')
      await stockItems.filter({ hasText: a.name }).getByRole('button', { name: 'Aus Bestand anfragen', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('LAB · Soldering room › LAB-SHELF · Parts shelf › LAB-BOX · Component box'); await expect(page.getByRole('dialog')).toContainText('OFF · Office › OFF-SHELF · Parts shelf › OFF-BOX · Component box'); await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen', exact: true }).click()
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ animations: 'disabled', path: join(output, `${engineName}-places-${width}-${theme}.png`), fullPage: true })
      }
      // Paste a mixed Excel/CSV list without catalog permissions. A manual
      // selection and an unfinished new-part draft must not be overwritten.
      await page.goto(webUrl + '/requests'); await page.getByRole('button', { name: 'Mehrere Teile anfragen', exact: true }).click()
      const form = page.getByRole('dialog'), field = label => form.getByLabel(label, { exact: true })
      await field('Für').selectOption(project.id); await field('Menge · ' + a.name).fill('7'); await field('Lieferantenlink · ' + a.name).fill('https://example.com/keep-manual')
      await form.locator('.purchase-new-part summary').click(); const manualName = 'Manual cable ' + engineName
      await field('Name des neuen Teils').fill(manualName); await field('Menge des neuen Teils').fill('3')
      await form.locator('.purchase-list-import summary').click(); await field('Teileliste').fill('Artikel;Menge;Link\nBad cable;0;javascript:alert(1)'); await form.getByRole('button', { name: 'Liste prüfen', exact: true }).click()
      await expect(form.locator('.purchase-list-import [role="alert"]')).toContainText('positive Menge'); await expect(form.getByRole('button', { name: 'Zur Freigabe senden', exact: true })).toBeDisabled(); await expect(form.getByRole('button', { name: /^Teile zur Anfrage hinzufügen/ })).toBeDisabled()
      await field('Teileliste').fill('Artikel,Menge\nMat material,2,5'); await form.getByRole('button', { name: 'Liste prüfen', exact: true }).click()
      await expect(form.locator('.purchase-list-import [role="alert"]')).toContainText('Mehr Spalten als erwartet'); await expect(form.getByRole('button', { name: /^Teile zur Anfrage hinzufügen/ })).toBeDisabled()
      const newName = 'Imported adapter ' + engineName
      await field('Teileliste').fill(`Artikel\tMenge\tEinheit\tLink\tPreis EUR\nDEMO-PCB\t2\tpcs\thttps://example.com/do-not-overwrite\t1\n${manualName}\t9\tpcs\nDEMO-STRIPE\t2\tpcs\nSensorstripe\t3\tpcs\nMat material\t2,5\tm²\thttps://example.com/mat\t12,50\n${newName}\t2\tpcs\thttps://example.com/adapter\t0,125`)
      await form.getByRole('button', { name: 'Liste prüfen', exact: true }).click(); await expect(form.locator('.purchase-list-import')).toContainText('2 bereits ausgewählt'); await expect(form.locator('.purchase-list-import')).toContainText('Wiederholte Zeilen zusammengefasst')
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await form.locator('.purchase-list-import').scrollIntoViewIfNeeded(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ animations: 'disabled', path: join(output, `${engineName}-paste-${width}-${theme}.png`) })
        await checkContrast(form.locator('.purchase-list-import'), `${engineName} paste ${theme}`)
      }
      await form.getByRole('button', { name: 'Teile zur Anfrage hinzufügen (3)', exact: true }).click(); await expect(field('Teileliste')).toHaveValue(''); await expect(field('Teileliste')).toBeFocused()
      await expect(field('Menge · ' + a.name)).toHaveValue('7'); await expect(field('Lieferantenlink · ' + a.name)).toHaveValue('https://example.com/keep-manual'); await expect(field('Menge des neuen Teils')).toHaveValue('3'); await expect(field('Menge · ' + b.name)).toHaveValue('5'); await expect(field('Menge · ' + mat.name)).toHaveValue('2.5')
      await form.locator('.purchase-extras summary').click(); await field('Notiz (optional)').fill('List audit ' + engineName); await field('Lieferant (optional)').fill('Example Supplier')
      const catalogCount = (await call('/state')).data.items.length
      await form.getByRole('button', { name: 'Zur Freigabe senden', exact: true }).click(); await expect(form).toHaveCount(0)
      const submitted = (await call('/state')).data; assert.equal(submitted.items.length, catalogCount, 'New requests do not create catalog or stock entries')
      const submittedGroup = submitted.workflows.requests.filter(r => r.reason === 'List audit ' + engineName); assert.equal(submittedGroup.length, 5); assert(submittedGroup.every(r => r.projectId === project.id && r.batchId === submittedGroup[0].batchId))
      assert.equal(submittedGroup.find(r => r.itemId === a.id).quantity, 7); assert.equal(submittedGroup.find(r => r.itemId === mat.id).quantity, 2.5); assert.equal(submittedGroup.find(r => r.itemId === mat.id).estimatedUnitCost, 12.5); assert.equal(submittedGroup.find(r => r.itemName === newName).estimatedUnitCost, 0.125); assert.equal(submittedGroup.find(r => r.itemName === manualName).quantity, 3)
      await call(`/workflows/request-batches/${submittedGroup[0].batchId}/review`, { lines: submittedGroup.map(r => ({ requestId: r.id, expectedVersion: r.version, decision: 'approve' })) })
      await buyer.goto(webUrl + '/requests'); await buyer.getByLabel('Anfragen suchen', { exact: true }).fill('List audit ' + engineName)
      await buyer.locator(`[data-batch-id="${submittedGroup[0].batchId}"]`).getByRole('button', { name: 'Freigegebene Positionen bestellen (5)', exact: true }).click()
      const orderForm = buyer.getByRole('dialog'), orderField = label => orderForm.getByLabel(label, { exact: true }), orderSave = orderForm.getByRole('button', { name: 'Getätigte Bestellung speichern', exact: true })
      const orderRow = name => orderForm.locator('.workflow-order-selection').filter({ hasText: name }), price = name => orderRow(name).getByLabel('Bestätigter Stückpreis (€)', { exact: true })
      await expect(orderField('Lieferant')).toHaveValue('Example Supplier'); await expect(orderRow(a.name).getByRole('link', { name: 'Lieferantenlink öffnen', exact: true })).toHaveAttribute('href', 'https://example.com/keep-manual')
      await price(a.name).fill('6'); await expect(orderSave).toBeDisabled(); await expect(orderRow(a.name)).toContainText('Über dem freigegebenen Preis')
      await price(a.name).fill('4,50'); await price(b.name).fill('0,10'); await price(mat.name).fill('12,50'); await price(newName).fill('0,125'); await price(manualName).fill('0,25')
      await orderField('Lieferant').fill('Example Supplier GmbH'); await orderField('Versand für die gesamte Bestellung (€)').fill('2,50')
      await orderRow(a.name).getByRole('checkbox').uncheck(); await orderRow(a.name).getByRole('checkbox').check(); await expect(price(a.name)).toHaveValue('4,50'); await expect(orderField('Lieferant')).toHaveValue('Example Supplier GmbH')
      await orderField('Freigegebene Teile suchen').fill('no-matching-part'); await orderField('Freigegebene Teile suchen').press('Enter'); await expect(orderForm.locator('.workflow-order-selection')).toHaveCount(5); await expect(orderForm).toBeVisible()
      await price(b.name).fill(''); await expect(orderForm.locator('.workflow-totals')).toContainText('Unvollständig'); await price(b.name).fill('0,10')
      await expect(orderForm.locator('.workflow-totals')).toContainText('66,75'); await orderField('Bestellnummer des Lieferanten').fill('WORKDAY-' + engineName)
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await buyer.setViewportSize({ width, height: 1000 }); await buyer.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await orderForm.locator('.workflow-totals').scrollIntoViewIfNeeded(); await expect.poll(() => buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await buyer.screenshot({ animations: 'disabled', path: join(output, `${engineName}-order-${width}-${theme}.png`) })
        await checkContrast(orderForm, `${engineName} order ${theme}`)
      }
      await orderSave.click(); await expect(orderForm).toHaveCount(0)
      const savedOrder = (await call('/state')).data.workflows.orders.find(order => order.reference === 'WORKDAY-' + engineName)
      assert.equal(savedOrder.supplier, 'Example Supplier GmbH'); assert.equal(savedOrder.shipping, 2.5); assert.equal(savedOrder.lines.reduce((cents, line) => cents + Math.round(line.quantity * line.unitCost * 100), 0) / 100 + savedOrder.shipping, 66.75)
      // A long pasted list has its own bounded preview and a reachable Add
      // action before the rows, rather than pushing the action below 100 parts.
      await page.goto(webUrl + '/requests'); await page.getByRole('button', { name: 'Mehrere Teile anfragen', exact: true }).click()
      await form.locator('.purchase-list-import summary').click(); await field('Teileliste').fill('Artikel;Menge\n' + Array.from({ length: 100 }, (_, index) => `Experimental part ${index};1`).join('\n')); await form.getByRole('button', { name: 'Liste prüfen', exact: true }).click()
      const previewList = form.getByRole('list', { name: 'Teilelisten-Vorschau', exact: true }), addList = form.getByRole('button', { name: 'Teile zur Anfrage hinzufügen (100)', exact: true })
      await expect(previewList.getByRole('listitem')).toHaveCount(100)
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 1000 }); await addList.scrollIntoViewIfNeeded(); await expect(addList).toBeInViewport()
        assert(await previewList.evaluate(el => el.clientHeight <= 382 && el.scrollHeight > el.clientHeight * 10))
        assert(await addList.evaluate(el => Boolean(el.compareDocumentPosition(el.parentElement.querySelector('[role="list"]')) & Node.DOCUMENT_POSITION_FOLLOWING)))
      }
      await addList.click(); await expect(form.locator('.purchase-selection')).toContainText('100 Teile ausgewählt'); await expect(form.getByRole('button', { name: 'Zur Freigabe senden', exact: true })).toBeEnabled()
      // A short viewport approximates the remaining space above a phone's
      // keyboard. Sticky actions must not cover the field reached with Tab.
      for (const viewport of [{ width: 320, height: 520 }, { width: 390, height: 520 }, { width: 800, height: 400 }]) {
        await page.setViewportSize(viewport)
        for (const [start, key] of [[0, 'Tab'], [8, 'Shift+Tab']]) {
          await form.getByLabel(`Menge · Experimental part ${start}`, { exact: true }).focus()
          for (let step = 0; step < 32; step++) {
            const readFocus = () => form.evaluate(dialog => {
              const active = document.activeElement, box = (active.closest('label') ?? active).getBoundingClientRect()
              const toolbar = dialog.querySelector('.workflow-dialog-toolbar').getBoundingClientRect()
              const footer = dialog.querySelector('fieldset > .form-actions').getBoundingClientRect()
              return { label: active.getAttribute('aria-label') || active.tagName, top: box.top, bottom: box.bottom, toolbar: toolbar.bottom, footer: footer.top }
            })
            await expect.poll(async () => { const focused = await readFocus(); return focused.top >= focused.toolbar - 1 && focused.bottom <= focused.footer + 1 }, { message: `${engineName} ${JSON.stringify(viewport)} ${key} step ${step}: focused field stays clear of sticky bars` }).toBe(true)
            await page.keyboard.press(key)
          }
        }
        await page.screenshot({ animations: 'disabled', path: join(output, `${engineName}-short-${viewport.width}-${viewport.height}.png`) })
      }
      // Removing a new part must free its slot in the 100-position limit,
      // including when the replacement is pasted rather than entered manually.
      await form.locator('.purchase-part').filter({ hasText: 'Experimental part 99' }).getByRole('button', { name: 'Entfernen', exact: true }).click()
      await expect(form.locator('.purchase-selection')).toContainText('99 Teile ausgewählt')
      await field('Teileliste').fill('Artikel;Menge\nReplacement experimental part;1'); await form.getByRole('button', { name: 'Liste prüfen', exact: true }).click()
      await expect(form.getByRole('button', { name: 'Teile zur Anfrage hinzufügen (1)', exact: true })).toBeEnabled()
      await form.getByRole('button', { name: 'Teile zur Anfrage hinzufügen (1)', exact: true }).click(); await expect(form.locator('.purchase-selection')).toContainText('100 Teile ausgewählt')
      await form.getByRole('button', { name: 'Abbrechen', exact: true }).click()
      // New requested parts remain visible before their first delivery creates
      // a catalog entry; procurement hints never mix projects or block new demand.
      await page.goto(webUrl + '/projects'); await page.getByLabel('Projektübersicht', { exact: true }).first().selectOption(project.id)
      await page.getByRole('tab', { name: 'Teile', exact: true }).click(); await page.locator('.project-pending-parts > summary').click()
      const pendingPart = page.locator(`.project-pending-parts [data-procurement-id="${submittedGroup.find(r => r.itemName === newName).id}"]`)
      await expect(pendingPart).toContainText(newName); await expect(pendingPart).toContainText('Bestellt'); await expect(pendingPart).toContainText('WORKDAY-' + engineName); await expect(pendingPart).toContainText('Developer Example')
      await page.getByLabel('Projektteile suchen', { exact: true }).fill(newName); await expect(page.locator('.project-pending-parts [data-procurement-id]')).toHaveCount(1); await expect(page.getByText('Keine passenden Projektteile.', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Ich brauche etwas', exact: true }).click(); await field('Teilname oder Lieferantenlink').fill('https://example.com/adapter#technical'); await field('Name des neuen Teils').fill('Additional adapter ' + engineName)
      await form.locator('.procurement-hint > summary').click(); await expect(form.locator('.procurement-hint')).toContainText(newName); await expect(form.locator('.procurement-hint')).toContainText('genaue Variante'); await expect(form.locator('.procurement-hint')).toContainText('2 pcs noch offen')
      await field('Für').selectOption(''); await expect(form.locator('.procurement-hint')).toHaveCount(0); await field('Für').selectOption(other.id); await expect(form.locator('.procurement-hint')).toHaveCount(0); await field('Für').selectOption(project.id); await expect(form.locator('.procurement-hint')).toHaveCount(1)
      await expect(form.getByRole('button', { name: 'Zur Freigabe senden', exact: true })).toBeEnabled()
      await form.getByRole('button', { name: 'Vorhandenen Artikel auswählen', exact: true }).click(); await field('Teilname oder Lieferantenlink').fill(a.name); await form.locator('.need-matches button').filter({ hasText: a.name }).click(); await form.locator('.procurement-hint > summary').click()
      await expect(form.locator('.procurement-hint')).toContainText('WORKDAY-' + engineName); await expect(form.locator('.procurement-hint')).toContainText('Freigegeben'); await expect(form.locator('.procurement-hint')).toContainText('Developer Example')
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await form.locator('.procurement-hint').scrollIntoViewIfNeeded(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ animations: 'disabled', path: join(output, `${engineName}-procurement-${width}-${theme}.png`) })
        await checkContrast(form, `${engineName} procurement ${theme}`)
      }
      await form.getByRole('button', { name: 'Abbrechen', exact: true }).click()
      // A changed approval must not be silently accepted after the conflict
      // handler refreshes the workspace. Reopen to review its new limit/version.
      state = (await call('/workflows/requests', { kind: 'purchase', itemName: 'Stale approval ' + engineName, quantity: 1, estimatedUnitCost: 5 }, sessions.developer)).data
      let stale = state.workflows.requests.find(r => r.itemName === 'Stale approval ' + engineName)
      stale = (await call(`/workflows/requests/${stale.id}/review`, { expectedVersion: stale.version, decision: 'approve' })).data.workflows.requests.find(r => r.id === stale.id)
      await buyer.goto(webUrl + '/requests'); await buyer.locator(`[data-request-id="${stale.id}"]`).getByRole('button', { name: 'Bestellung erfassen', exact: true }).click()
      await orderField('Bestätigter Stückpreis (€)').fill('3'); await orderField('Lieferant').fill('Supplier'); await orderField('Bestellnummer des Lieferanten').fill('STALE-' + engineName)
      stale = (await call(`/workflows/requests/${stale.id}/reopen`, { expectedVersion: stale.version, note: 'Revised quote' })).data.workflows.requests.find(r => r.id === stale.id)
      stale = (await call(`/workflows/requests/${stale.id}/edit`, { expectedVersion: stale.version, kind: 'purchase', itemName: stale.itemName, quantity: 1, estimatedUnitCost: 4 }, sessions.developer)).data.workflows.requests.find(r => r.id === stale.id)
      await call(`/workflows/requests/${stale.id}/review`, { expectedVersion: stale.version, decision: 'approve' })
      for (let attempt = 0; attempt < 2; attempt++) { await orderSave.click(); await expect(orderForm.getByRole('alert')).toContainText('changed'); await expect(orderField('Bestätigter Stückpreis (€)')).toHaveValue('3'); assert(!(await call('/state')).data.workflows.orders.some(order => order.reference === 'STALE-' + engineName)) }
      await orderForm.getByRole('button', { name: 'Abbrechen', exact: true }).click()
      // Receiving drafts are scoped to each delivery, including locations,
      // condition, notes and the reviewed order version.
      const receivingPlace = (await call('/locations', { name: 'Incoming shelf ' + engineName, code: 'IN-' + engineName, kind: 'room' })).data.locations.find(p => p.code === ('IN-' + engineName).toUpperCase())
      const receivedPart = (await call('/items', { name: 'Receiver part ' + engineName, sku: 'RCV-' + engineName, unit: 'pcs' })).data.items.find(i => i.sku === ('RCV-' + engineName).toUpperCase())
      async function makeDelivery(reference, quantity) {
        let r = (await call('/workflows/requests', { kind: 'purchase', itemId: receivedPart.id, quantity }, sessions.developer)).data.workflows.requests[0]
        r = (await call(`/workflows/requests/${r.id}/review`, { expectedVersion: r.version, decision: 'approve' })).data.workflows.requests.find(x => x.id === r.id)
        return (await call('/workflows/orders', { supplier: 'Receiving supplier', reference, shipping: 0, lines: [{ requestId: r.id, expectedVersion: r.version, unitCost: 1 }] })).data.workflows.orders.find(o => o.reference === reference)
      }
      const deliveryA = await makeDelivery('DEL-A-' + engineName, 5), deliveryB = await makeDelivery('DEL-B-' + engineName, 4)
      await receiver.goto(webUrl + '/orders'); await receiver.getByRole('button', { name: 'Lieferung einbuchen', exact: true }).click()
      const receiving = receiver.getByRole('dialog'), rf = label => receiving.getByLabel(label, { exact: true }), receiptSave = receiving.getByRole('button', { name: 'Wareneingang speichern', exact: true })
      const choose = async order => { await rf('Bestellung oder Paket suchen').fill(order.reference); await receiving.locator('.workflow-row').filter({ hasText: order.reference }).getByRole('button', { name: 'Bestellung auswählen', exact: true }).click() }
      const back = async () => { await receiving.getByRole('button', { name: 'Andere Bestellung auswählen', exact: true }).click(); await expect.poll(() => receiving.evaluate(el => el.scrollTop)).toBe(0); await expect(rf('Bestellung oder Paket suchen')).toBeFocused() }
      const amount = () => rf('Heute eingegangen · ' + receivedPart.name)
      await choose(deliveryA); await rf('Lagerort').selectOption(receivingPlace.id); await amount().fill('4')
      await receiving.locator('.workflow-arrival-extras summary').click(); await rf('Abweichender Lagerort (optional)').selectOption(receivingPlace.id); await rf('Zustand bei Eingang').selectOption('needs_check'); await rf('Notiz zu diesem Artikel (optional)').fill('Inspect connector')
      await receiving.getByText('Lieferschein oder Notiz (optional)', { exact: true }).click(); await rf('Lieferschein (optional)').fill('NOTE-A'); await rf('Notizen (optional)').fill('Package A')
      await back(); await expect(receiving).toContainText('Ungespeicherte Eingaben'); await choose(deliveryB); await expect(amount()).toHaveValue(''); await expect(rf('Lagerort')).toHaveValue('')
      await rf('Lagerort').selectOption(receivingPlace.id); await amount().fill('1'); await back(); await choose(deliveryA)
      await expect(amount()).toHaveValue('4'); await expect(rf('Lagerort')).toHaveValue(receivingPlace.id); await expect(rf('Abweichender Lagerort (optional)')).toHaveValue(receivingPlace.id); await expect(rf('Zustand bei Eingang')).toHaveValue('needs_check'); await expect(rf('Notiz zu diesem Artikel (optional)')).toHaveValue('Inspect connector'); await expect(rf('Lieferschein (optional)')).toHaveValue('NOTE-A')
      await receiver.keyboard.press('Escape'); await expect(receiving).toBeVisible(); await expect(amount()).toHaveValue('4')
      await call(`/workflows/orders/${deliveryA.id}/receive`, { expectedVersion: deliveryA.version, lines: [{ lineId: deliveryA.lines[0].id, quantity: 2, locationId: receivingPlace.id, condition: 'new' }] }, sessions.receiver)
      await receiptSave.click(); await expect(receiving).toContainText('Diese Bestellung wurde während der Erfassung geändert'); await expect(receiptSave).toBeDisabled(); await expect(amount()).toHaveValue('4')
      await receiving.getByRole('button', { name: 'Offene Mengen aktualisieren', exact: true }).click(); await expect(amount()).toHaveValue('4'); await expect(receiving.locator('.inventory-error')).toHaveCount(0); await expect(amount()).toHaveAttribute('max', '3'); await expect(receiving).toContainText('Mehr als die offene Menge')
      assert.equal(await amount().evaluate(el => el.validity.rangeOverflow), true)
      await amount().fill('1.5'); await rf('Lagerort').selectOption(''); await expect(rf('Lagerort')).not.toHaveAttribute('required')
      for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
        await receiver.setViewportSize({ width, height: 1000 }); await receiver.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        await receiving.locator('.workflow-arrival-line').scrollIntoViewIfNeeded(); await expect.poll(() => receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await receiver.screenshot({ animations: 'disabled', path: join(output, `${engineName}-receiving-${width}-${theme}.png`) })
        await checkContrast(receiving, `${engineName} receiving ${theme}`)
      }
      await receiptSave.click(); await expect(rf('Bestellung oder Paket suchen')).toBeVisible(); await expect(receiving).toContainText('Deine weiteren Eingaben sind unten weiterhin verfügbar')
      let receivedState = (await call('/state')).data, finalA = receivedState.workflows.orders.find(o => o.id === deliveryA.id)
      assert.equal(finalA.lines[0].receivedQuantity, 3.5); const recordA = receivedState.records.find(r => r.id === finalA.lines[0].receipts.at(-1).recordId); assert.equal(recordA.quarantined, true); assert.equal(recordA.notes, 'Inspect connector'); assert.equal(recordA.locationId, receivingPlace.id)
      await choose(deliveryB); await expect(amount()).toHaveValue('1'); await expect(rf('Lagerort')).toHaveValue(receivingPlace.id)
      await back(); await receiving.getByRole('button', { name: 'Eingang ohne Bestellung', exact: true }).click()
      await rf('Artikel').selectOption(receivedPart.id); await receiving.locator('[name="quantity"]').fill('2'); await rf('Stückkosten inkl. Versand, falls bekannt (€)').fill('1,25'); await rf('Zustand bei Eingang').selectOption('damaged'); await rf('Lagerort').selectOption(receivingPlace.id)
      await rf('Artikel').selectOption(mat.id); await expect(receiving.locator('[name="quantity"]')).toHaveValue('1'); await expect(rf('Stückkosten inkl. Versand, falls bekannt (€)')).toHaveValue(''); await expect(rf('Zustand bei Eingang')).toHaveValue('new'); await expect(receiving.getByLabel('Menge (m²)', { exact: true })).toBeVisible()
      await rf('Artikel').selectOption(receivedPart.id); await expect(receiving.locator('[name="quantity"]')).toHaveValue('2'); await expect(rf('Stückkosten inkl. Versand, falls bekannt (€)')).toHaveValue('1,25'); await expect(rf('Zustand bei Eingang')).toHaveValue('damaged')
      await receiving.getByRole('button', { name: 'Bestellung auswählen', exact: true }).click(); await choose(deliveryB); await expect(amount()).toHaveValue('1')
      await receiver.route(`**/workflows/orders/${deliveryB.id}/receive`, async route => { const response = await route.fetch(); assert(response.ok()); await route.abort('failed') }, { times: 1 })
      await receiptSave.click(); await expect(receiving.locator('.inventory-error')).toBeVisible(); await expect(amount()).toHaveValue('1')
      const afterLostReceipt = (await call('/state')).data; assert.equal(afterLostReceipt.workflows.orders.find(o => o.id === deliveryB.id).lines[0].receivedQuantity, 1)
      await receiptSave.click(); assert.equal((await call('/state')).data.records.length, afterLostReceipt.records.length, 'Retrying a lost receipt response does not duplicate stock')
      await expect(rf('Bestellung oder Paket suchen')).toBeVisible(); await receiving.getByRole('button', { name: /^Eingang ohne Bestellung/ }).click(); await expect(receiving.locator('[name="quantity"]')).toHaveValue('2')
      const recordsBefore = (await call('/state')).data.records.map(r => r.id); await receiptSave.click(); await expect(receiving).toHaveCount(0)
      const newRecords = (await call('/state')).data.records.filter(r => !recordsBefore.includes(r.id)); assert.equal(newRecords.length, 1); assert.equal(newRecords[0].itemId, receivedPart.id); assert.equal(newRecords[0].quantity, 2); assert.equal(newRecords[0].unitCost, 1.25); assert.equal(newRecords[0].quarantined, true)
      assert.deepEqual(errors, []); results.push({ browser: engineName, projectAndGeneralFilters: true, groupedSearch: true, permissionAwareActionQueue: true, decisionDialog: true, keyboardAndDraft: true, projectSwitch: true, mixedPastedRequest: true, clipboardValidation: true, selectionProtection: true, orderSupplierAndLinks: true, decimalOrderTotals: true, approvalLimitsAndRevision: true, nestedRoomStock: true, unambiguousPlaces: true, sharedProjectStockSearch: true, responsiveThemes: true, receivingOrderDrafts: true, concurrentDeliveryReview: true, unorderedArticleDrafts: true, projectNewParts: true, procurementHints: true, hundredRowPreview: true, receivingResponseRetry: true, linePlacesWithoutCommonPlace: true, textContrastAtLeast4_5: true, inputContrastAtLeast3: true, narrow320: true }); console.log('PASS workday flow ' + engineName)
    } catch (error) { await page.screenshot({ animations: 'disabled', path: join(output, engineName + '-failure.png'), fullPage: true }); await buyer.screenshot({ animations: 'disabled', path: join(output, engineName + '-buyer-failure.png'), fullPage: true }); await receiver.screenshot({ animations: 'disabled', path: join(output, engineName + '-receiver-failure.png'), fullPage: true }); throw error } finally { await browser.close() }
  }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results))
} finally { await web.close(); api.kill(); await new Promise(r => api.exitCode !== null ? r() : api.once('exit', r)); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) }
