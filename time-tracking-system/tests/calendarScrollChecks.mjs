import {expect} from '@playwright/test'
import {readFileSync} from 'node:fs'

// Works against the standalone fixture and the actual embedded workspace.
export async function checkCalendarScrolling(page, surface, screenshotPath) {
  for (const mode of ['Tag', 'Woche']) {
    await surface.locator('.calendar-view-switch').getByRole('button', {name: mode, exact: true}).click()
    const viewport = surface.locator('.calendar-viewport')
    const labels = surface.locator('.calendar-time-axis span')
    expect(await labels.allTextContents(), `${mode}: the complete day must exist even without timed events`).toEqual(
      Array.from({length: 25}, (_, hour) => `${String(hour).padStart(2, '0')}:00`),
    )
    const geometry = await viewport.evaluate(el => ({height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop}))
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.height + 500)
    expect(geometry.top).toBeGreaterThan(0)
    await viewport.scrollIntoViewIfNeeded()
    await viewport.evaluate(el => {
      const header = document.querySelector('.dco-suite-header, .dco-workspace-header')
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0
      window.scrollBy(0, el.getBoundingClientRect().top - headerBottom - 8)
    })
    await viewport.focus()
    await page.keyboard.press('Control+Home')
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(0)
    const assertInside = async locator => {
      const rect = await locator.boundingBox(), bounds = await viewport.boundingBox()
      expect(rect.y).toBeGreaterThanOrEqual(bounds.y - 1)
      expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1)
    }
    await assertInside(labels.first())
    const bounds = await viewport.boundingBox()
    await page.mouse.move(bounds.x + Math.min(bounds.width - 20, 180), bounds.y + bounds.height - 60)
    await page.mouse.wheel(0, 450)
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(200)
    const afterWheel = await viewport.evaluate(el => el.scrollTop)
    // Updating calendar data must not pull the scroll position back to the morning.
    await surface.locator('body').evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(120)
    expect(await viewport.evaluate(el => el.scrollTop)).toBe(afterWheel)
    await viewport.focus()
    await page.keyboard.press('Control+End')
    await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
    await assertInside(labels.last())
    const head = await surface.locator('.timed-calendar-heading').boundingBox()
    expect(Math.abs(head.y - (await viewport.boundingBox()).y)).toBeLessThan(2)
    if (mode === 'Woche') {
      await viewport.evaluate(el => { el.scrollLeft = el.scrollWidth })
      expect(await viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
      const axis = await surface.locator('.calendar-time-axis').boundingBox()
      expect(Math.abs(axis.x - (await viewport.boundingBox()).x)).toBeLessThan(2)
      const lastDay = await surface.locator('.timed-day-column').last().boundingBox()
      expect(lastDay.x + lastDay.width).toBeLessThanOrEqual((await viewport.boundingBox()).x + bounds.width + 1)
      if (screenshotPath) await page.screenshot({path: screenshotPath})
    }
    expect(await surface.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const exportButton = surface.getByRole('button', {name: 'Kalender exportieren', exact: true})
  await expect(exportButton).toBeEnabled()
  const legend = await surface.locator('.calendar-legend').boundingBox()
  expect((await exportButton.boundingBox()).y).toBeGreaterThanOrEqual(legend.y + legend.height - 1)
  expect(await exportButton.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  const download = page.waitForEvent('download')
  await exportButton.click()
  const file = await download
  expect(await file.failure()).toBeNull()
  expect(file.suggestedFilename()).toMatch(/\.ics$/)
  expect(readFileSync(await file.path(), 'utf8')).toContain('BEGIN:VCALENDAR')
  await surface.locator('.calendar-view-switch').getByRole('button', {name: 'Monat', exact: true}).click()
}
