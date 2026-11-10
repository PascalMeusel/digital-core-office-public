import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'dco-request-usability-')), output = resolve('../artifacts/inventory-request-usability')
const webUrl = 'http://127.0.0.1:5221', apiUrl = 'http://127.0.0.1:5303/api/inventorySystem', password = 'L7!nRf4*Kw9#pUv8'
mkdirSync(output, { recursive: true })
const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { windowsHide: true, env: { ...process.env, PORT: '5303', HOST: '127.0.0.1', CORS_ORIGIN: webUrl, DCO_CORE_URL: '', DISABLE_LOCAL_WEB_LOGIN: 'false', INVENTORY_SYSTEM_DATA: join(directory, 'inventory.sqlite'), INVENTORY_REFERENCE_DATA_FILE: join(directory, 'none.json'), INVENTORY_SYSTEM_ADMIN_EMAIL: 'administrator@example.test', INVENTORY_SYSTEM_ADMIN_PASSWORD: password } })
let log = ''; api.stdout.on('data', v => log += v); api.stderr.on('data', v => log += v)
const web = await createServer({ server: { host: '127.0.0.1', port: 5221, strictPort: true }, define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:5303'), 'import.meta.env.VITE_ENABLED_MODULES': JSON.stringify('time,inventory') } })
let admin
async function call(path, body, session = admin) {
  const response = await fetch(apiUrl + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-inventory-csrf': session.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json(); assert(response.ok, `${path}: ${data.message}`); return { data, response }
}
async function login(email) { const { data, response } = await call('/auth/login', { email, password }, null); return { cookie: response.headers.getSetCookie().find(c => c.startsWith('inventory_session=')).split(';')[0], csrf: data.csrfToken } }
try {
  await web.listen(); for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:5303/api/health'); break } catch { if (i === 59) throw Error(log); await new Promise(r => setTimeout(r, 150)) } }
  admin = await login('administrator@example.test')
  await call('/users', { name: 'Developer Example', email: 'developer@example.test', role: 'software_developer', password, mustChangePassword: false })
  const software = await login('developer@example.test')
  const project = (await call('/projects', { name: 'DemoDevice', code: 'DEMO' })).data.projects.find(p => p.code === 'DEMO')
  const other = (await call('/projects', { name: 'Other project', code: 'OTHER' })).data.projects.find(p => p.code === 'OTHER')
  const place = (await call('/locations', { name: 'Laborregal', code: 'LAB', kind: 'room' })).data.locations.find(l => l.code === 'LAB')
  const a = (await call('/items', { name: 'DEMO PCB', sku: 'PCB', unit: 'pcs', category: 'DemoDevice', supplierUrl: 'https://example.com/pcb', estimatedUnitCost: 5 })).data.items.find(i => i.name === 'DEMO PCB')
  const b = (await call('/items', { name: 'Mat material', sku: 'MAT', unit: 'm²', projectIds: [other.id], supplierUrl: 'https://example.com/mat', estimatedUnitCost: 2 })).data.items.find(i => i.name === 'Mat material')
  await call('/catalog/import', { idempotencyKey: crypto.randomUUID(), rows: Array.from({ length: 40 }, (_, i) => ({ name: `DEMO part ${i}`, unit: 'pcs', projectIds: [project.id] })) })
  await call('/records', { itemId: a.id, locationId: place.id, quantity: 10, state: 'in_stock', condition: 'new' })
  const results = [], failures = []
  for (const [engineKey, engine] of (process.env.AUDIT_BASELINE ? [['chromium', chromium]] : [['chromium', chromium], ['firefox', firefox]])) for (const width of (process.env.AUDIT_BASELINE ? [390] : [390, 1440])) {
    const engineName = `${engineKey}-${width}`
    const browser = await engine.launch({ headless: true }), errors = []
    async function openPage(session) {
      const context = await browser.newContext({ viewport: { width, height: 844 } }); await context.addCookies([{ name: 'inventory_session', value: session.cookie.split('=')[1], url: 'http://127.0.0.1' }]); await context.addInitScript(() => localStorage.setItem('digital-core-office.language', 'de'))
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return page
    }
    const page = await openPage(software), buyer = await openPage(admin), dialog = page.getByRole('dialog')
    const field = label => dialog.getByLabel(label, { exact: true })
    const button = name => dialog.getByRole('button', { name, exact: true })
    async function open(entry = 'Ich brauche etwas') { await page.goto(webUrl + '/requests'); await page.getByRole('button', { name: entry, exact: true }).click(); if (entry === 'Ich brauche etwas') await expect(field('Teilname oder Lieferantenlink')).toBeFocused() }
    async function choose(item) { await field('Teilname oder Lieferantenlink').fill(item.name); const match = dialog.locator('.need-matches button').filter({ hasText: item.name }); await match.focus(); await match.press('Enter'); await expect(field('Menge')).toBeFocused() }
    async function scenario(name, fn) {
      try { await fn(); results.push({ browser: engineName, scenario: name, ok: true }); console.log(`PASS ${engineName} / ${name}`) }
      catch (error) { const failure = `${engineName} / ${name}: ${error.message.split('\n').slice(0, 6).join(' ')}`; failures.push(failure); console.log(`FAIL ${failure}`); await page.screenshot({ path: join(output, `${engineName}-${name}-failure.png`), fullPage: true }).catch(() => {}) }
    }
    try {
      await scenario('source-switch', async () => {
        await open(); await choose(a); await field('Verwendung').selectOption('consume'); await field('Menge').fill('3')
        await dialog.getByRole('radio', { name: 'Kauf anfragen', exact: true }).check(); await field('Lieferantenlink (optional)').fill('https://example.com/custom-pcb')
        await dialog.getByRole('radio', { name: 'Aus Bestand anfragen', exact: true }).check(); await expect(field('Verwendung')).toHaveValue('consume')
        await field('Für').selectOption(project.id); await field('Für').selectOption(''); await expect(field('Menge')).toHaveValue('3')
        await button('Bestand anfragen').click(); await expect(dialog).toHaveCount(0)
        const r = (await call('/state')).data.workflows.requests.find(r => r.itemId === a.id && r.kind === 'stock'); assert.equal(r.usage, 'consume'); assert.equal(r.quantity, 3); assert(!r.projectId)
      })
      await scenario('article-drafts', async () => {
        await open(); await choose(a); await field('Menge').fill('4'); await dialog.getByRole('radio', { name: 'Kauf anfragen', exact: true }).check(); await field('Lieferantenlink (optional)').fill('https://example.com/special')
        await button('Anderen Artikel auswählen').click(); await choose(b); await expect(field('Menge')).toHaveValue('1'); await expect(field('Lieferantenlink (optional)')).toHaveValue(b.supplierUrl)
        await field('Menge').fill('2.5'); await button('Anderen Artikel auswählen').click(); await choose(a)
        await expect(field('Menge')).toHaveValue('4'); await expect(dialog.getByRole('radio', { name: 'Kauf anfragen', exact: true })).toBeChecked(); await expect(field('Lieferantenlink (optional)')).toHaveValue('https://example.com/special')
        await button('Anderen Artikel auswählen').click(); await choose(b); await expect(field('Menge')).toHaveValue('2.5')
      })
      await scenario('new-part-draft', async () => {
        await open(); await button('Neues Teil anfragen').click(); await field('Teilname oder Lieferantenlink').fill('New insulation material')
        await field('Menge').fill('2.5'); await field('Einheit').selectOption('m²'); await field('Lieferantenlink (optional)').fill('https://example.com/insulation')
        await button('Vorhandenen Artikel auswählen').click(); await choose(a); await button('Anderen Artikel auswählen').click(); await button('Neues Teil anfragen').click()
        await expect(field('Teilname oder Lieferantenlink')).toHaveValue('New insulation material'); await expect(field('Menge')).toHaveValue('2.5'); await expect(field('Einheit')).toHaveValue('m²'); await expect(field('Lieferantenlink (optional)')).toHaveValue('https://example.com/insulation')
      })
      await scenario('stock-article-and-project-switch', async () => {
        await open('Mehrere Teile anfragen'); await button('Vorhandenen Bestand anfragen').click(); await field('Artikel').selectOption(a.id); await field('Menge').fill('4'); await field('Verwendung').selectOption('consume')
        await field('Für').selectOption(project.id); await field('Artikel suchen').fill('Mat'); await field('Artikel suchen').press('Enter'); await expect(dialog).toBeVisible()
        await field('Artikel').selectOption(b.id); await expect(field('Menge')).toHaveValue('1'); await field('Menge').fill('2.5')
        await field('Artikel suchen').fill(''); await field('Artikel').selectOption(a.id); await expect(field('Menge')).toHaveValue('4'); await field('Für').selectOption(''); await expect(field('Verwendung')).toHaveValue('consume')
        await field('Artikel').selectOption(b.id); await expect(field('Menge')).toHaveValue('2.5'); await button('Anfrage senden').click(); await expect(dialog).toHaveCount(0)
        const requests = (await call('/state')).data.workflows.requests.filter(r => r.itemId === b.id && r.kind === 'stock'); assert(requests.some(r => r.quantity === 2.5 && r.usage === 'consume' && !r.projectId))
      })
      await scenario('batch-search-enter', async () => {
        await open('Mehrere Teile anfragen'); await field('Menge · ' + a.name).fill('4'); await field('Lieferantenlink · ' + a.name).fill('https://example.com/entered')
        await expect(button('Vorhandenen Bestand anfragen')).toHaveCount(0)
        const before = (await call('/state')).data.workflows.requests.length
        await field('Teile suchen').fill('Mat material'); await field('Teile suchen').press('Enter'); await expect(dialog).toBeVisible(); assert.equal((await call('/state')).data.workflows.requests.length, before, 'Search Enter must not submit the request')
        await expect(field('Menge · ' + a.name)).toHaveValue('4'); await expect(field('Menge · ' + b.name)).toBeVisible()
      })
      await scenario('batch-duplicate', async () => {
        await open('Mehrere Teile anfragen'); await field('Menge · ' + a.name).fill('4'); await dialog.locator('.purchase-new-part summary').click()
        await field('Name des neuen Teils').fill(a.name); await field('Menge des neuen Teils').fill('2'); await button('Zur Anfrage hinzufügen').click()
        await expect(field('Menge · ' + a.name)).toHaveValue('4'); await expect(dialog.getByRole('alert')).toContainText('bereits ausgewählt')
      })
      await scenario('batch-project-and-validation', async () => {
        await open('Mehrere Teile anfragen'); await field('Für').selectOption(project.id); await field('Menge · ' + a.name).fill('3'); await field('Lieferantenlink · ' + a.name).fill('https://example.com/a')
        await field('Für').selectOption(other.id); await expect(field('Menge · ' + a.name)).toHaveValue('3'); await expect(field('Menge · ' + b.name)).toBeVisible()
        await field('Menge · ' + b.name).fill('1.5'); await field('Für').selectOption(''); await field('Teile suchen').fill('unmatched'); await expect(field('Menge · ' + b.name)).toHaveValue('1.5')
        await dialog.locator('.purchase-new-part summary').click(); await field('Name des neuen Teils').fill('Invalid zero ' + engineName); await field('Menge des neuen Teils').fill('0'); await button('Zur Anfrage hinzufügen').click()
        await expect(field('Name des neuen Teils')).toHaveValue('Invalid zero ' + engineName); await expect(dialog.getByRole('alert')).toBeVisible()
        await field('Menge des neuen Teils').fill('2'); await field('Lieferantenlink für neues Teil (optional)').fill('not-a-link'); await button('Zur Anfrage hinzufügen').click(); await expect(dialog.getByRole('alert')).toContainText('Lieferantenlink'); await expect(field('Name des neuen Teils')).toHaveValue('Invalid zero ' + engineName)
        await field('Lieferantenlink für neues Teil (optional)').fill('https://example.com/new'); await button('Zur Anfrage hinzufügen').click(); await button('Zur Freigabe senden').click(); await expect(dialog).toHaveCount(0)
        const state = (await call('/state')).data, added = state.workflows.requests.find(r => r.itemName === 'Invalid zero ' + engineName), group = state.workflows.requests.filter(r => r.batchId === added.batchId)
        assert.equal(group.length, 3); assert(group.every(r => !r.projectId)); assert.equal(group.find(r => r.itemId === a.id).quantity, 3); assert.equal(group.find(r => r.itemId === a.id).supplierUrl, 'https://example.com/a')
      })
      await scenario('review-decision-note', async () => {
        const state = (await call('/workflows/requests/batch', { projectId: project.id, reason: 'Review audit ' + engineName, lines: [{ itemId: a.id, quantity: 1 }, { itemId: b.id, quantity: 2 }] }, software)).data
        const request = state.workflows.requests.find(r => r.reason === 'Review audit ' + engineName && r.itemId === a.id)
        await buyer.goto(webUrl + '/requests'); await buyer.locator(`[data-batch-id="${request.batchId}"]`).getByRole('button', { name: 'Positionen prüfen', exact: true }).click()
        const form = buyer.getByRole('dialog'), decision = form.getByLabel('Entscheidung · ' + a.name, { exact: true }), note = form.getByLabel('Begründung · ' + a.name, { exact: true })
        await decision.selectOption('defer'); await note.fill('Clarify the hardware revision'); await decision.selectOption('approve'); await decision.selectOption('defer'); await expect(note).toHaveValue('Clarify the hardware revision')
        await form.getByRole('button', { name: 'Entscheidungen speichern', exact: true }).click(); await expect(form).toHaveCount(0)
        const saved = (await call('/state')).data.workflows.requests.find(r => r.id === request.id); assert.equal(saved.status, 'deferred'); assert.equal(saved.decisionNote, 'Clarify the hardware revision')
      })
      await scenario('lost-response-retry', async () => {
        await open(); await button('Neues Teil anfragen').click(); const name = 'Retry part ' + engineName
        await field('Teilname oder Lieferantenlink').fill(name); await field('Menge').fill('2.5'); await field('Einheit').selectOption('m²')
        // The server commits, but the browser loses the response. Retrying must
        // retain the draft and the idempotency key, not create a second request.
        await page.route('**/api/inventorySystem/workflows/requests/batch', async route => { const response = await route.fetch(); assert(response.ok()); await route.abort('failed') }, { times: 1 })
        await button('Zur Freigabe senden').click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(field('Menge')).toHaveValue('2.5'); await expect(field('Einheit')).toHaveValue('m²')
        await button('Zur Freigabe senden').click(); await expect(dialog).toHaveCount(0)
        const saved = (await call('/state')).data.workflows.requests.filter(r => r.itemName === name); assert.equal(saved.length, 1); assert.equal(saved[0].quantity, 2.5)
      })
      await scenario('edit-switch-and-search', async () => {
        let state = (await call('/workflows/requests', { kind: 'purchase', itemId: a.id, quantity: 2, estimatedUnitCost: 5, supplierUrl: a.supplierUrl, reason: 'Edit audit ' + engineName }, software)).data
        const r = state.workflows.requests.find(r => r.reason === 'Edit audit ' + engineName)
        await page.goto(webUrl + '/requests'); await page.locator(`[data-request-id="${r.id}"]`).getByRole('button', { name: 'Anfrage bearbeiten', exact: true }).click()
        await field('Geschätzter Stückpreis (€)').fill('4€'); assert.equal(await field('Geschätzter Stückpreis (€)').evaluate(el => el.validity.patternMismatch), true); await field('Geschätzter Stückpreis (€)').fill('4,25'); await field('Geschätzter Versand (€)').fill('1,50'); await field('Lieferantenlink (optional)').fill('https://example.com/edited'); await field('Was wird benötigt?').selectOption('stock'); await field('Was wird benötigt?').selectOption('purchase')
        await expect(field('Geschätzter Stückpreis (€)')).toHaveValue('4,25'); await expect(field('Lieferantenlink (optional)')).toHaveValue('https://example.com/edited')
        await field('Artikel suchen').fill('Mat'); await field('Artikel suchen').press('Enter'); await expect(dialog).toBeVisible()
        await field('Artikel').selectOption(b.id); await expect(field('Lieferantenlink (optional)')).toHaveValue(b.supplierUrl); await expect(field('Geschätzter Stückpreis (€)')).toHaveValue('2')
        await field('Artikel suchen').fill(''); await field('Artikel').selectOption(a.id); await expect(field('Geschätzter Stückpreis (€)')).toHaveValue('4,25'); await button('Anfrage senden').click(); await expect(dialog).toHaveCount(0)
        state = (await call('/state')).data; assert.equal(state.workflows.requests.find(v => v.id === r.id).estimatedUnitCost, 4.25); assert.equal(state.workflows.requests.find(v => v.id === r.id).estimatedShipping, 1.5)
      })
      await scenario('order-selection-draft', async () => {
        let state = (await call('/workflows/requests', { kind: 'purchase', itemId: a.id, quantity: 2, estimatedUnitCost: 5, reason: 'Order audit ' + engineName }, software)).data
        let r = state.workflows.requests.find(r => r.reason === 'Order audit ' + engineName)
        state = (await call(`/workflows/requests/${r.id}/review`, { expectedVersion: r.version, decision: 'approve' })).data; r = state.workflows.requests.find(v => v.id === r.id)
        await buyer.goto(webUrl + '/orders'); await buyer.getByRole('button', { name: 'Bestellung erfassen', exact: true }).first().click()
        const form = buyer.getByRole('dialog'), row = form.locator('.workflow-order-selection').filter({ hasText: a.name }).last()
        await row.getByRole('checkbox').check(); await row.getByLabel('Bestätigter Stückpreis (€)', { exact: true }).fill('3.5'); await row.getByRole('checkbox').uncheck(); await row.getByRole('checkbox').check(); await expect(row.getByLabel('Bestätigter Stückpreis (€)', { exact: true })).toHaveValue('3.5')
        await form.getByLabel('Lieferant', { exact: true }).fill('Supplier'); await form.getByLabel('Bestellnummer des Lieferanten', { exact: true }).fill('AUDIT-' + engineName); await form.getByRole('button', { name: 'Getätigte Bestellung speichern', exact: true }).click(); await expect(form).toHaveCount(0)
        assert.equal((await call('/state')).data.workflows.orders.find(o => o.reference === 'AUDIT-' + engineName).lines[0].unitCost, 3.5)
      })
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  }
  writeFileSync(join(output, process.env.AUDIT_BASELINE ? 'baseline.json' : 'verification.json'), JSON.stringify({ results, failures }, null, 2)); console.log(JSON.stringify({ results, failures })); assert.deepEqual(failures, [])
} finally { await web.close(); api.kill(); await new Promise(r => api.exitCode !== null ? r() : api.once('exit', r)); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }) }
