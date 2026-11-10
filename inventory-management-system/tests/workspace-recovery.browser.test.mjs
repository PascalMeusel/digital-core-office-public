// Run from inventory-management-system: node tests/workspace-recovery.browser.test.mjs
import { createServer } from 'vite'
import { chromium, firefox, expect } from '../../time-tracking-system/node_modules/@playwright/test/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))

const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import App from'/src/InventorySystem.tsx';import'/src/index.css';
localStorage.setItem('digital-core-office.language','en');
const params=new URLSearchParams(location.search);const stamp=new Date().toISOString();
const user={id:params.get('user')||'synthetic-a',name:'Inventory Tester',email:'inventory@example.invalid',role:'admin',active:true,mustChangePassword:false,createdAt:stamp,updatedAt:stamp};
const item={id:'item-a',sku:'PART-100',name:'Long component description for receiving layout verification and narrow screens',category:'Components',unit:'pcs',minQuantity:0,reorderQuantity:0,active:true,createdAt:stamp,updatedAt:stamp};
const locationItem={id:'place-a',name:'Main receiving shelf with a deliberately long location name',code:'MAIN-01',kind:'fixture',active:true,createdAt:stamp,updatedAt:stamp};
const record={id:'record-a',version:1,quarantined:false,itemId:item.id,locationId:locationItem.id,label:'Synthetic stock',quantity:10,state:'in_stock',condition:'new',createdAt:stamp,updatedAt:stamp};
const hold={...record,id:'hold-a',quarantined:true,state:'damaged',condition:'needs_check'};
window.fixture={mode:params.get('mode')||'valid',mutations:[],conflict:true,state:{currentUser:user,csrfToken:'synthetic-csrf',usersManagedByCore:true,users:[user],locations:[locationItem],items:[item,{...item,id:'item-b',sku:'PART-200',name:'Replacement component'}],categories:['Components'],tags:[],categoryTags:[],recordTags:[],records:[record,hold],assignments:[],projects:[],activity:[],receipts:[{id:'receipt-a',receivedAt:stamp,receiverLabel:'Inventory Tester',createdAt:stamp,createdBy:user.id}],receiptLines:[{id:'line-a',receiptId:'receipt-a',recordId:'hold-a',itemId:item.id,locationId:locationItem.id,quantity:10,currentQuantity:10,currentVersion:1,condition:'needs_check',discrepancy:'wrong_item',reviewRequired:true,quarantined:true,createdAt:stamp}],recordEvents:[],qrLabels:[],permissions:['read_inventory','manage_catalog','manage_locations','request_stock','order_stock','receive_stock','adjust_stock','update_state','export_inventory'],totals:[],referenceRooms:[],generatedAt:stamp}};
window.fetch=async(input,init={})=>{const path=new URL(String(input),location.href).pathname;const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(path.endsWith('/state')){if(window.fixture.mode==='network')throw new TypeError('Failed to fetch');if(['401','403','503'].includes(window.fixture.mode))return json({message:'Synthetic session failure'},Number(window.fixture.mode));return json(window.fixture.state)}
if(path.endsWith('/auth/logout'))return new Response(null,{status:204});
if(path.includes('/qr-login/challenges'))return json({token:'synthetic-qr',expiresAt:new Date(Date.now()+300000).toISOString(),pending:true});
const body=JSON.parse(init.body||'{}');window.fixture.mutations.push({path,body});
if(path.endsWith('/records/record-a')){if(window.fixture.conflict){window.fixture.conflict=false;window.fixture.state.records[0]={...record,version:2,quantity:8};return json({message:'Stock changed on another device.'},409)}window.fixture.state.records[0]={...window.fixture.state.records[0],...body,quantity:Number(body.quantity),version:3};return json(window.fixture.state)}
if(path.endsWith('/receipt-lines/line-a/release')){window.fixture.state.receiptLines[0]={...window.fixture.state.receiptLines[0],quarantined:false,currentVersion:2,releasedByEventId:'release-a'};return json(window.fixture.state)}
if(path.endsWith('/receipts')){if(window.fixture.mode==='lost-receipt')throw new TypeError('Response lost');return json(window.fixture.state)}
throw Error('Unexpected test request '+path)};
history.replaceState(null,'','/'+(params.get('view')||'receiving')+location.search);
createRoot(document.getElementById('root')).render(React.createElement(App));`

const server = await createServer({
  plugins: [{ name: 'inventory-regression-fixture', resolveId(id) { if (id === 'virtual:inventory-fixture') return '\0' + id }, load(id) { if (id === '\0virtual:inventory-fixture') return fixture }, configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/inventory-fixture') && !/^\/(receiving|catalog|inventory)(\?|$)/.test(req.url ?? '')) return next()
      res.setHeader('Content-Type', 'text/html')
      res.end(await s.transformIndexHtml('/inventory-fixture', '<html><body><div id="root"></div><script type="module" src="/@id/virtual:inventory-fixture"></script></body></html>'))
    })
  } }], server: { host: '127.0.0.1', port: 5200, strictPort: true }, logLevel: 'error',
})
await server.listen()
const output = '../.runtime/inventory-workspace-verification'
mkdirSync(output, { recursive: true })
const results = []
try {
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await type.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      page.setDefaultTimeout(10000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('dialog', dialog => dialog.accept())
      for (const mode of ['503', 'network', '403']) {
        await page.goto('http://127.0.0.1:5200/inventory-fixture?mode=' + mode)
        await expect(page.getByRole('heading', { name: mode === '403' ? 'Inventory access unavailable' : 'Inventory connection interrupted', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
        await page.evaluate(() => window.fixture.mode = 'valid')
        await page.getByRole('button', { name: 'Try again', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Receive inventory', exact: true })).toBeVisible()
      }
      await page.goto('http://127.0.0.1:5200/inventory-fixture?mode=401')
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await page.goto('http://127.0.0.1:5200/inventory-fixture')
      const form = page.locator('.receiving-form')
      await form.getByLabel('Supplier', { exact: true }).fill('Draft supplier')
      await form.locator('.receipt-line select').nth(0).selectOption('item-a')
      await form.locator('.receipt-line select').nth(2).selectOption('place-a')
      await form.getByLabel('Qty', { exact: true }).fill('3')
      const nav = page.locator('.inventory-desktop-navigation')
      await page.locator('.inventory-mobile-navigation > summary').click()
      await page.locator('.inventory-mobile-navigation').getByRole('button', { name: 'Articles & stock', exact: true }).click()
      await page.getByRole('button', { name: 'Parts & materials', exact: true }).click()
      await page.locator('.inventory-mobile-navigation > summary').click()
      await page.locator('.inventory-mobile-navigation').getByRole('button', { name: 'Receiving', exact: true }).click()
      await expect(form.getByLabel('Supplier', { exact: true })).toHaveValue('Draft supplier')
      await page.reload()
      await expect(form.getByLabel('Qty', { exact: true })).toHaveValue('3')
      await expect(form.getByLabel('Supplier', { exact: true })).toHaveValue('Draft supplier')
      for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 844 })
        await page.evaluate(theme => { localStorage.setItem('digital-core-office.theme', theme); dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.theme', newValue: theme })) }, theme)
        const layout = await page.locator('.receiving-workspace').evaluate(root => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          badControls: [...root.querySelectorAll('input:not([type=file]):not([type=checkbox]),select,textarea')].filter(el => el.getBoundingClientRect().width && (el.getBoundingClientRect().height < 43 || el.getBoundingClientRect().right > innerWidth + 1)).map(el => el.outerHTML),
        }))
        expect(layout).toEqual({ overflow: false, badControls: [] })
        if (name === 'chromium') await page.screenshot({ path: `${output}/receiving-${width}-${theme}.png`, fullPage: true })
      }
      // A lost response keeps the same receipt command across a browser reload.
      const attachment = { name: 'delivery.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2_100_000, 65) }
      await form.locator('input[type=file]').setInputFiles(attachment)
      await page.evaluate(() => window.fixture.mode = 'lost-receipt')
      await form.getByRole('button', { name: 'Save & next delivery', exact: true }).click()
      await expect(page.locator('.inventory-error')).toBeVisible()
      const firstKey = await page.evaluate(() => window.fixture.mutations.at(-1).body.idempotencyKey)
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('receiving-draft')).map(key => sessionStorage.getItem(key).length).every(size => size < 10000))).toBe(true)
      await page.reload()
      await expect(page.getByRole('alert').filter({ hasText: 'Choose the delivery note again:' })).toBeVisible()
      await form.locator('input[type=file]').setInputFiles(attachment)
      await page.evaluate(() => window.fixture.mode = 'lost-receipt')
      await form.getByRole('button', { name: 'Save & next delivery', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.fixture.mutations.at(-1)?.body.idempotencyKey)).toBe(firstKey)
      await page.goto('http://127.0.0.1:5200/inventory-fixture?user=synthetic-b')
      await expect(form.getByLabel('Supplier', { exact: true })).toHaveValue('')
      // Explicit inspection is required to release a quarantined delivery.
      const release = page.locator('.receipt-release')
      await expect(release.getByRole('button', { name: 'Release inspected stock' })).toBeDisabled()
      await release.getByLabel('Actual delivered item').selectOption('item-b')
      await release.getByLabel('Inspected condition').selectOption('usable')
      await release.getByLabel('Release reason').fill('Inspected against the packing list')
      await release.getByLabel('Item inspected and correctly identified').check()
      await release.getByRole('button', { name: 'Release inspected stock' }).click()
      await expect(page.locator('.receipt-release')).toHaveCount(0)
      expect(await page.evaluate(() => window.fixture.mutations.at(-1).body)).toEqual({ expectedVersion: 1, reason: 'Inspected against the packing list', itemId: 'item-b', condition: 'usable' })
      await nav.getByRole('button', { name: 'Articles & stock', exact: true }).click()
      await page.getByText('Advanced stock records', { exact: true }).click()
      await page.getByTitle('Edit record', { exact: true }).first().click()
      const editor = page.locator('.workflow-form')
      await editor.getByLabel('Quantity', { exact: true }).fill('5')
      await editor.getByLabel('Begründung / correction reason (required)', { exact: true }).fill('Counted shelf')
      await editor.getByLabel('Quantity', { exact: true }).evaluate(input => { window.retainedStockInput = input; window.fixture.mode = '403' })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Inventory access unavailable' })).toBeVisible()
      await expect(editor).toBeHidden()
      expect(await page.evaluate(() => window.retainedStockInput.isConnected)).toBe(true)
      await page.evaluate(() => window.fixture.mode = 'valid')
      await page.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('5')
      expect(await editor.getByLabel('Quantity', { exact: true }).evaluate(input => input === window.retainedStockInput)).toBe(true)
      await editor.getByRole('button', { name: 'Save record', exact: true }).click()
      await expect(page.locator('.record-revision-notice')).toBeVisible()
      await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('5')
      expect(await page.evaluate(() => window.fixture.mutations.at(-1).body.expectedVersion)).toBe(1)
      await expect(editor.getByRole('button', { name: 'Save record', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'Load current values', exact: true }).click()
      await expect(editor.getByLabel('Quantity', { exact: true })).toHaveValue('8')
      await editor.getByLabel('Begründung / correction reason (required)', { exact: true }).fill('Counted current shelf')
      await editor.getByRole('button', { name: 'Save record', exact: true }).click()
      expect(await page.evaluate(() => window.fixture.mutations.at(-1).body.expectedVersion)).toBe(2)
      expect(errors).toEqual([])
      results.push({ browser: name, startupRecovery: true, confirmedExpiry: true, runtimeForbiddenRetainsDraftDOM: true, mobileDesktopThemes: true, draftNavigationReloadIsolation: true, receiptRetryIdempotency: true, quarantineRelease: true, staleStockEditPreserved: true })
    } finally { await browser.close() }
  }
} finally { await server.close() }
writeFileSync(output + '/browser-verification.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results))
