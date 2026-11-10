import { expect, test, type Page } from '@playwright/test'

const email = 'suite-smoke@example.com'
const changedPassword = 'UseAUnique!Changed2026'

async function authenticate(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(changedPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()
}

async function expectSharedShell(page: Page, product: 'core' | 'time' | 'inventory' | 'agile') {
  const header = page.locator('.dco-suite-header')
  await expect(header).toBeVisible()
  await expect(header).toHaveAttribute('data-product', product)
  await expect(page.locator(`.dco-system-switcher a[aria-current="page"]`)).toHaveCount(1)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

async function expectWorkspace(page: Page, product: 'time' | 'inventory' | 'agile') {
  const frameElement = page.locator(`iframe[src^="/${product}/index.html"]`)
  await expect(frameElement).toBeVisible()
  const frame = page.frameLocator(`iframe[src^="/${product}/index.html"]`)
  await expect(frame.locator(`.dco-workspace-header[data-product="${product}"]`)).toBeVisible()
  await expect(frame.locator('.dco-suite-header')).toHaveCount(0)
  if (product === 'time') await expect(frame.locator('.clock-panel')).toBeVisible()
  if (product === 'inventory') await expect(frame.locator('.inventory-metrics')).toBeVisible()
  if (product === 'agile') await expect(frame.locator('.workbench')).toBeVisible()
  return frame
}

test('anonymous Core header keeps preferences but hides account controls', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.dco-suite-header[data-product="core"]')).toBeVisible()
  await expect(page.getByTitle(/Sign out|Abmelden/)).toHaveCount(0)
  await expect(page.getByTitle(/Dark theme|Dunkles Design/)).toBeVisible()
})

test('the signed-in Inventory app can approve the desktop suite QR sign-in', async ({ page, request }) => {
  const challengeResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/core/auth/qr-login/challenges') && response.request().method() === 'POST'
  ))
  await page.goto('/')
  await page.getByRole('button', { name: /Show QR code|QR-Code anzeigen/, exact: true }).click()
  const challengeResponse = await challengeResponsePromise
  const challenge = await challengeResponse.json() as { token: string }
  await expect(page.locator('.core-login-qr-code img')).toBeVisible()

  const mobileLogin = await request.post('/inventory/api/inventorySystem/auth/login', {
    data: { email, password: changedPassword, stayLoggedIn: true },
    headers: { 'x-inventory-mobile-app': '1' },
  })
  expect(mobileLogin.ok()).toBe(true)
  const mobileSession = await mobileLogin.json() as { csrfToken: string; sessionToken: string }
  const approval = await request.post('/inventory/api/inventorySystem/auth/qr-login/challenges/approve', {
    data: { token: challenge.token },
    headers: {
      authorization: `Bearer ${mobileSession.sessionToken}`,
      'x-inventory-csrf': mobileSession.csrfToken,
      'x-inventory-mobile-app': '1',
    },
  })
  expect(approval.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: /Welcome|Willkommen/ })).toBeVisible({ timeout: 8_000 })
  await expect(page.locator('.dco-suite-header[data-product="core"]')).toBeVisible()
})

test('every product keeps its startup symbol for the same duration and fade', async ({ page }) => {
  const paths = [
    '/time/index.html?embedded=1',
    '/inventory/index.html?embedded=1',
    '/agile/index.html?embedded=1',
  ]
  const removalTimes: number[] = []

  for (const path of paths) {
    await page.goto(path)
    const bootShell = page.locator('.initial-app-shell')
    await expect(bootShell).toBeVisible()
    await expect(bootShell).toHaveCSS('transition-duration', '0.24s, 0.24s')
    await page.waitForTimeout(500)
    await expect(bootShell).toBeVisible()

    const removedAt = await page.evaluate(() => new Promise<number>((resolve) => {
      const root = document.getElementById('root')
      if (!root?.querySelector('.initial-app-shell')) {
        resolve(window.performance.now())
        return
      }

      const observer = new MutationObserver(() => {
        if (!root.querySelector('.initial-app-shell')) {
          observer.disconnect()
          resolve(window.performance.now())
        }
      })
      observer.observe(root, { childList: true, subtree: true })
    }))
    removalTimes.push(removedAt)
  }

  for (const removalTime of removalTimes) {
    expect(removalTime).toBeGreaterThanOrEqual(1_080)
    expect(removalTime).toBeLessThan(1_350)
  }
  expect(Math.max(...removalTimes) - Math.min(...removalTimes)).toBeLessThan(80)
})

test('every product shows its own loading screen while its session starts', async ({ page }) => {
  const checks = [
    { product: 'time', path: '/time/index.html?embedded=1', sessionPattern: '**/time/api/sso/session' },
    { product: 'inventory', path: '/inventory/index.html?embedded=1', sessionPattern: '**/inventory/api/inventorySystem/state' },
    { product: 'agile', path: '/agile/index.html?embedded=1', sessionPattern: '**/agile/api/agile/auth/sso-session' },
  ] as const

  for (const check of checks) {
    await page.route(check.sessionPattern, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"test session delay"}' })
    })
    await page.goto(check.path)
    await expect(page.locator(`.dco-suite-loading[data-product="${check.product}"]`)).toBeVisible()
    await page.waitForTimeout(1_250)
    await page.unroute(check.sessionPattern)
  }
})

test('inventory metrics switch from global totals to the opened item', async ({ page }) => {
  const timestamp = '2026-09-03T08:00:00.000Z'
  const user = {
    id: 'user-1', name: 'Inventory Tester', email: 'inventory@example.com', role: 'admin',
    active: true, mustChangePassword: false, createdAt: timestamp, updatedAt: timestamp,
  }
  const location = {
    id: 'location-1', name: 'Main shelf', code: 'SHELF-1', kind: 'fixture',
    active: true, createdAt: timestamp, updatedAt: timestamp,
  }
  const items = [
    {
      id: 'item-1', sku: 'RES-10K', name: '10k resistor', category: 'Electronics', unit: 'pcs',
      minQuantity: 10, reorderQuantity: 20, active: true, createdAt: timestamp, updatedAt: timestamp,
    },
    {
      id: 'item-2', sku: 'CAP-100N', name: '100n capacitor', category: 'Electronics', unit: 'pcs',
      minQuantity: 2, reorderQuantity: 5, active: true, createdAt: timestamp, updatedAt: timestamp,
    },
  ]
  const records = items.map((item, index) => ({
    id: `record-${index + 1}`, itemId: item.id, locationId: location.id, quantity: index === 0 ? 3 : 7,
    state: 'in_stock', condition: 'new', createdAt: timestamp, updatedAt: timestamp,
  }))
  const totals = [
    { itemId: 'item-1', requestedQuantity: 5, orderedQuantity: 4, deliveredQuantity: 0, inStockQuantity: 3, usableQuantity: 3, totalTrackedQuantity: 12, belowMinimum: true },
    { itemId: 'item-2', requestedQuantity: 9, orderedQuantity: 8, deliveredQuantity: 0, inStockQuantity: 7, usableQuantity: 7, totalTrackedQuantity: 24, belowMinimum: false },
  ]

  await page.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
  await page.route('**/inventory/api/inventorySystem/state', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      currentUser: user,
      csrfToken: 'test-csrf',
      users: [user], locations: [location], items, categories: ['Electronics'], tags: [],
      categoryTags: [], recordTags: [], records, assignments: [], activity: [], receipts: [], receiptLines: [], recordEvents: [],
      permissions: ['read_inventory', 'receive_stock'], totals, referenceRooms: [], generatedAt: timestamp,
    }),
  }))

  await page.goto('/inventory/index.html?embedded=1')
  const metrics = page.locator('.inventory-metrics')
  await expect(metrics).toHaveAttribute('data-scope', 'global')
  await expect(metrics.locator('.inventory-metric strong')).toHaveText(['10', '12', '14', '1'])

  await page.getByRole('button', { name: 'Inventory', exact: true }).click()
  await page.locator('.inventory-record-row').first().click()
  await expect(metrics).toHaveAttribute('data-scope', 'item')
  await expect(metrics.locator('.inventory-metrics-context')).toContainText('10k resistor')
  await expect(metrics.locator('.inventory-metric strong')).toHaveText(['3', '4', '5', '7'])
})

test('receiving workspace supports accountable batch entry', async ({ page }) => {
  const timestamp = '2026-09-03T08:00:00.000Z'
  const user = { id: 'user-1', name: 'Inventory Tester', email: 'inventory@example.com', role: 'admin', active: true, mustChangePassword: false, createdAt: timestamp, updatedAt: timestamp }
  const location = { id: 'location-1', name: 'Incoming shelf', code: 'INCOMING', kind: 'room', active: true, createdAt: timestamp, updatedAt: timestamp }
  const item = { id: 'item-1', sku: 'RES-10K', name: '10k resistor', category: 'Electronics', unit: 'pcs', minQuantity: 10, reorderQuantity: 20, active: true, createdAt: timestamp, updatedAt: timestamp }
  await page.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
  await page.route('**/inventory/api/inventorySystem/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    currentUser: user, csrfToken: 'test-csrf', users: [user], locations: [location], items: [item], categories: ['Electronics'], tags: [], categoryTags: [], recordTags: [], records: [], assignments: [], activity: [], receipts: [], receiptLines: [], recordEvents: [], permissions: ['read_inventory', 'receive_stock', 'adjust_stock', 'export_inventory'], totals: [{ itemId: item.id, requestedQuantity: 0, orderedQuantity: 0, deliveredQuantity: 0, inStockQuantity: 0, usableQuantity: 0, totalTrackedQuantity: 0, belowMinimum: true }], referenceRooms: [], generatedAt: timestamp,
  }) }))
  await page.goto('/inventory/receiving?embedded=1')
  await expect(page.getByRole('heading', { name: 'Receive inventory' })).toBeVisible()
  const expectedReceiptDate = await page.evaluate(() => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` })
  await expect(page.getByLabel('Receipt date')).toHaveValue(expectedReceiptDate)
  await expect(page.getByText('Receiver is attributed automatically from your account.')).toBeVisible()
  await expect(page.getByText('Import existing lists')).toBeVisible()
  await expect(page.getByText('Monthly receipt journal')).toBeVisible()
})

test('desktop QR workspace explains and manages physical labels without a camera UI', async ({ page }) => {
  const timestamp = '2026-09-03T08:00:00.000Z'
  const user = { id: 'user-1', name: 'Inventory Tester', email: 'inventory@example.com', role: 'admin', active: true, mustChangePassword: false, createdAt: timestamp, updatedAt: timestamp }
  const location = { id: 'location-1', name: 'Shelf A', code: 'SHELF-A', kind: 'room', active: true, createdAt: timestamp, updatedAt: timestamp }
  const item = { id: 'item-1', sku: 'RES-10K', name: '10k resistor', category: 'Electronics', unit: 'pcs', minQuantity: 10, reorderQuantity: 20, active: true, createdAt: timestamp, updatedAt: timestamp }
  await page.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
  await page.route('**/inventory/api/inventorySystem/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    currentUser: user, csrfToken: 'test-csrf', users: [user], locations: [location], items: [item], categories: ['Electronics'], tags: [], categoryTags: [], recordTags: [], records: [], assignments: [], activity: [], receipts: [], receiptLines: [], recordEvents: [], qrLabels: [], permissions: ['read_inventory'], totals: [{ itemId: item.id, requestedQuantity: 0, orderedQuantity: 0, deliveredQuantity: 0, inStockQuantity: 0, usableQuantity: 0, totalTrackedQuantity: 0, belowMinimum: true }], referenceRooms: [], generatedAt: timestamp,
  }) }))
  await page.goto('/inventory/qr?embedded=1')
  await expect(page.getByRole('heading', { name: 'QR labels', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Create a label' })).toBeVisible()
  await expect(page.getByText('Print and attach')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Existing labels' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Open a code on desktop' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Scan QR' })).toHaveCount(0)
  await expect(page.locator('.scanner-frame')).toHaveCount(0)
})

test('one login moves through every system with one stable suite shell', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('digital-core-office.language')) localStorage.setItem('digital-core-office.language', 'en')
    if (!localStorage.getItem('digital-core-office.theme')) localStorage.setItem('digital-core-office.theme', 'light')
  })
  await authenticate(page)
  await expectSharedShell(page, 'core')
  await page.evaluate(() => { (window as Window & { dcoPersistentShellProbe?: string }).dcoPersistentShellProbe = 'preserved' })

  const initialHeaderHeight = await page.locator('.dco-suite-header').evaluate((element) => element.getBoundingClientRect().height)

  await page.locator('.dco-system-switcher a[href^="/time"]').click({ force: true })
  await page.waitForURL(/\/time(?:\/|$)/)
  await expectSharedShell(page, 'time')
  await expectWorkspace(page, 'time')

  await page.locator('.dco-system-switcher a[href^="/inventory"]').click({ force: true })
  await page.waitForURL(/\/inventory(?:\/|$)/)
  await expectSharedShell(page, 'inventory')
  await expectWorkspace(page, 'inventory')

  await page.locator('.dco-system-switcher a[href^="/agile"]').click({ force: true })
  await page.waitForURL(/\/agile(?:\/|$)/)
  await expectSharedShell(page, 'agile')
  await expectWorkspace(page, 'agile')
  await expect.poll(() => page.evaluate(() => (window as Window & { dcoPersistentShellProbe?: string }).dcoPersistentShellProbe)).toBe('preserved')

  await page.goBack()
  await page.waitForURL(/\/inventory(?:\/|$)/)
  await expectSharedShell(page, 'inventory')
  await expectWorkspace(page, 'inventory')
  await page.goForward()
  await page.waitForURL(/\/agile(?:\/|$)/)
  await expectWorkspace(page, 'agile')

  await page.reload()
  await expectSharedShell(page, 'agile')
  await expectWorkspace(page, 'agile')

  await page.locator('.dco-system-switcher a[href="/"]').click({ force: true })
  await page.waitForURL('http://127.0.0.1:4300/')
  await expectSharedShell(page, 'core')
  const finalHeaderHeight = await page.locator('.dco-suite-header').evaluate((element) => element.getBoundingClientRect().height)
  expect(finalHeaderHeight).toBe(initialHeaderHeight)
})

test('suite theme and language follow the user between systems', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('digital-core-office.language')) localStorage.setItem('digital-core-office.language', 'en')
  })
  await authenticate(page)
  await page.getByTitle('Dark theme').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.locator('.dco-system-switcher a[href^="/inventory"]').click({ force: true })
  await page.waitForURL(/\/inventory(?:\/|$)/)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const inventoryFrame = await expectWorkspace(page, 'inventory')
  await expect(inventoryFrame.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTitle('Deutsch').click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('digital-core-office.language'))).toBe('de')
  await expect(page.getByTitle('English')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'System wechseln' }).getByRole('link', { name: 'Zeit' })).toBeVisible()
  await expect(inventoryFrame.getByRole('navigation', { name: 'Inventarbereiche' })).toBeVisible()

  await page.locator('.dco-system-switcher a[href^="/agile"]').click({ force: true })
  await page.waitForURL(/\/agile(?:\/|$)/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('digital-core-office.language'))).toBe('de')
  await expect(page.getByTitle('English')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'System wechseln' }).getByRole('link', { name: 'Zeit' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const agileFrame = await expectWorkspace(page, 'agile')
  await expect(agileFrame.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('mobile shell remains usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    if (!localStorage.getItem('digital-core-office.language')) localStorage.setItem('digital-core-office.language', 'en')
  })
  await authenticate(page)
  await expectSharedShell(page, 'core')
  await page.locator('.dco-system-switcher a[href^="/inventory"]').click({ force: true })
  await page.waitForURL(/\/inventory(?:\/|$)/)
  await expectSharedShell(page, 'inventory')
  const inventoryFrame = await expectWorkspace(page, 'inventory')
  await expect(inventoryFrame.locator('.dco-local-navigation')).toBeVisible()
  expect(await inventoryFrame.locator('.dco-local-navigation button').evaluateAll(buttons => buttons.every(button => {
    const label = button.querySelector('span')
    if (!label) return false
    const outer = button.getBoundingClientRect(), inner = label.getBoundingClientRect()
    return inner.width > 0 && inner.left >= outer.left && inner.right <= outer.right
  }))).toBe(true)
})

test('a centrally created employee replaces the administrator in every workspace and logout revokes access', async ({ page, context }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('digital-core-office.language', 'en'))
  await authenticate(page)
  const adminCookie = (await context.cookies()).find((cookie) => cookie.name === 'dco_core_session')!
  await page.getByRole('button', { name: 'Add user', exact: true }).click()
  const form = page.locator('.core-user-form')
  await form.getByLabel('Name', { exact: true }).fill('Suite Employee')
  await form.getByLabel('Email', { exact: true }).fill('suite-employee@example.com')
  await form.getByLabel('Temporary password').fill('EmployeeTemporary!2026')
  await expect(form.getByLabel('Inventory role')).toHaveValue('viewer')
  await page.screenshot({ path: testInfo.outputPath('core-user-directory.png'), fullPage: true })
  await form.getByRole('button', { name: 'Save user', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit Suite Employee', exact: true })).toBeVisible()

  for (const product of ['time', 'inventory', 'agile'] as const) {
    await page.locator(`.dco-system-switcher a[href^="/${product}"]`).click({ force: true })
    await expectWorkspace(page, product)
  }
  const otherTab = await context.newPage()
  await otherTab.goto('/inventory')
  await expectWorkspace(otherTab, 'inventory')
  await page.getByTitle('Sign out', { exact: true }).click()
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('suite-employee@example.com')
  await page.getByLabel('Password', { exact: true }).fill('EmployeeTemporary!2026')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByLabel('Current password').fill('EmployeeTemporary!2026')
  await page.getByLabel('New password', { exact: true }).fill('EmployeeChanged!2026')
  await page.getByLabel('Confirm password').fill('EmployeeChanged!2026')
  await page.getByRole('button', { name: 'Save password', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill('suite-employee@example.com')
  await page.getByLabel('Password', { exact: true }).fill('EmployeeChanged!2026')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.dco-suite-header')).toContainText('Suite Employee')
  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0)

  const endpoints = {
    time: '/time/api/state',
    inventory: '/inventory/api/inventorySystem/state',
    agile: '/agile/api/agile/auth/session',
  }
  for (const product of ['time', 'inventory', 'agile'] as const) {
    await page.locator(`.dco-system-switcher a[href^="/${product}"]`).click({ force: true })
    await expectWorkspace(page, product)
    const response = await context.request.get(endpoints[product], { headers: { authorization: `Bearer ${adminCookie.value}` } })
    expect(response.ok()).toBe(true)
    const payload = await response.json()
    expect((payload.currentUser ?? payload.user).email).toBe('suite-employee@example.com')
    expect((payload.currentUser ?? payload.user).role).toBe(product === 'inventory' ? 'viewer' : 'employee')
  }
  await otherTab.reload()
  await expect(otherTab.locator('.dco-suite-header')).toContainText('Suite Employee')
  await page.getByTitle('Sign out', { exact: true }).click()
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  for (const endpoint of Object.values(endpoints)) {
    expect((await context.request.get(endpoint, { headers: { authorization: `Bearer ${adminCookie.value}` } })).status()).toBe(401)
  }
  await otherTab.reload()
  await expect(otherTab.getByLabel('Email', { exact: true })).toBeVisible()
})

test('a delayed session refresh cannot restore a signed-out identity', async ({ page }) => {
  await authenticate(page)
  let release!: () => void
  let captured!: () => void
  let fulfilled!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { captured = resolve })
  const completed = new Promise<void>((resolve) => { fulfilled = resolve })
  let delayed = false
  await page.route('**/api/core/session', async (route) => {
    if (delayed) { await route.continue(); return }
    delayed = true
    const response = await route.fetch()
    captured()
    await held
    await route.fulfill({ response })
    fulfilled()
  })
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'digital-core-office.identity-change' })))
  await started
  await page.getByTitle('Sign out', { exact: true }).click()
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  release()
  await completed
  await page.waitForTimeout(200)
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Welcome/ })).toHaveCount(0)
})

test('each module reports failed logout without falsely clearing a live account', async ({ page }) => {
  await authenticate(page)
  const endpoints = { time: '/time/api/logout', inventory: '/inventory/api/inventorySystem/auth/logout', agile: '/agile/api/agile/auth/logout' }
  for (const product of ['time', 'inventory', 'agile'] as const) {
    const pattern = `**${endpoints[product]}`
    await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Synthetic logout failure"}' }))
    await page.goto(`/${product}/index.html`)
    await expect(page.locator('.dco-suite-header')).toContainText('Suite Smoke')
    await page.getByTitle('Sign out', { exact: true }).click()
    await expect(page.getByText(/Synthetic logout failure|Sign-out could not be completed/)).toBeVisible()
    await expect(page.locator('.dco-suite-header')).toContainText('Suite Smoke')
    await page.unroute(pattern)
  }
})
