import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const baseUrl = process.env.QA_BASE_URL ?? 'http://127.0.0.1:4300'
const outputDirectory = fileURLToPath(new URL('../../artifacts/location-directory/', import.meta.url))
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch()

async function authenticate(page) {
  await page.goto(baseUrl)
  await page.locator('input[type="email"]').fill('suite-smoke@example.com')
  await page.locator('input[type="password"]').fill('UseAUnique!Temporary2026')
  await page.locator('button[type="submit"]').click()
  await page.getByRole('heading', { name: /Welcome|Willkommen/ }).waitFor()
}

async function capture(name, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await authenticate(page)
  await page.goto(`${baseUrl}/inventory`)
  const frame = page.frameLocator('iframe[src^="/inventory/index.html"]')
  await frame.locator('.dco-workspace-header[data-product="inventory"]').waitFor()
  const locationNavigation = frame.locator('.dco-local-navigation button', { hasText: /Places|Orte/ })
  if (await locationNavigation.count() === 0) {
    console.log('Inventory navigation:', await frame.locator('.dco-local-navigation button').allTextContents())
    throw new Error('The locations navigation entry is unavailable.')
  }
  await locationNavigation.click()
  await frame.locator('.location-directory-metrics').waitFor()
  await frame.locator('.location-tree-row').first().waitFor()

  const frameElement = page.locator('iframe[src^="/inventory/index.html"]')
  const overflow = await frameElement.evaluate((element) => {
    const documentElement = element.contentDocument?.documentElement
    return documentElement ? documentElement.scrollWidth - documentElement.clientWidth : -1
  })
  const metrics = await frame.locator('.location-directory-metrics strong').allTextContents()
  const visibleRows = await frame.locator('.location-tree-row').count()
  const planOpen = await frame.locator('.location-plan-disclosure').evaluate((element) => element.hasAttribute('open'))
  const toolbarLayout = await frame.locator('.location-directory-toolbar').evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    width: element.clientWidth,
    viewport: window.innerWidth,
  }))
  await page.screenshot({ path: join(outputDirectory, `${name}.png`), fullPage: true })
  if (viewport.width <= 560) {
    await frame.locator('.location-directory-toolbar').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(outputDirectory, `${name}-directory.png`) })
  }
  await frame.locator('.location-tree-row').nth(1).locator('.location-tree-toggle').click()
  const expandedRows = await frame.locator('.location-tree-row').count()
  await context.close()
  return { name, metrics, visibleRows, expandedRows, overflow, planOpen, toolbarLayout }
}

const results = []
results.push(await capture('desktop-1440', { width: 1440, height: 1000 }))
results.push(await capture('mobile-390', { width: 390, height: 844 }))
console.log(JSON.stringify(results, null, 2))

await browser.close()
