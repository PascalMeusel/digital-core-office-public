import { expect, test, type Page } from '@playwright/test'

const adminTabs = ['Kalender', 'Anträge', 'Admin-Kalender', 'Benutzer', 'Gruppen', 'Freie Tage', 'Einstellungen']
const smokeEmail = 'browser-smoke@example.com'
const smokeTemporaryPassword = 'UseAUnique!Temporary2026'
const smokePassword = 'UseAUnique!Changed2026'

async function visibleLayoutProblems(page: Page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth
    const selectors = [
      '.dco-suite-header',
      '.dco-local-navigation',
      '.dco-system-switcher',
      '.topbar',
      '.clock-panel',
      '.day-issues-panel',
      '.day-issue-row',
      '.day-issue-actions .secondary-button',
      '.clock-log-panel',
      '.time-export-panel',
      '.summary-panel',
      '.calendar-panel',
      '.calendar-legend',
      '.admin-work-calendar-panel',
      '.admin-work-calendar-title',
      '.admin-work-report-panel',
      '.admin-work-report-controls',
      '.admin-work-report-users',
      '.admin-work-report-table',
      '.custom-events-panel',
      '.sharing-panel',
      '.request-form-panel',
      '.requests-list-panel',
      '.admin-requests-panel',
      '.admin-calendar-controls-panel',
      '.request-stat-row',
      '.admin-users-panel',
      '.approved-actions-panel',
      '.group-admin-panel',
      '.holiday-admin-panel',
      '.holiday-template-form',
      '.license-panel',
      '.mail-server-panel',
      '.backup-panel',
      '.mail-server-actions',
      '.sharing-panel > .primary-button',
      '.clock-actions button',
    ]

    return selectors
      .flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            selector,
            text: (element.textContent ?? '').trim().slice(0, 48),
            x: rect.x,
            right: rect.right,
            width: rect.width,
            problem: rect.width > 0 && (rect.x < -1 || rect.right > viewport + 1),
          }
        }),
      )
      .filter((item) => item.problem)
  })
}

async function signIn(page: Page, password: string) {
  await page.getByLabel('E-Mail').fill(smokeEmail)
  await page.getByLabel('Passwort').fill(password)
  await page.getByRole('button', { name: 'Einloggen' }).click()
}

async function expectDropdownNearTrigger(page: Page, label: string) {
  const trigger = page.getByLabel(label).first()
  await trigger.click()
  const menu = page.locator('.app-select-menu').first()
  await expect(menu).toBeVisible()

  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()])
  expect(triggerBox).not.toBeNull()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(triggerBox!.x - 2)
  expect(menuBox!.x).toBeLessThanOrEqual(triggerBox!.x + 2)
  expect(menuBox!.y).toBeGreaterThan(triggerBox!.y)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
}

async function expectDateFieldButtonAttached(page: Page, selector: string) {
  const gap = await page.locator(selector).evaluate((field) => {
    const input = field.querySelector('input')?.getBoundingClientRect()
    const button = field.querySelector('button')?.getBoundingClientRect()
    return input && button ? Math.round(button.left - input.right) : Number.POSITIVE_INFINITY
  })
  expect(Math.abs(gap)).toBeLessThanOrEqual(1)
}

async function waitForLoginResult(page: Page) {
  const clockPanel = page.locator('.clock-panel')
  const forcedPasswordChange = page.getByRole('heading', { name: 'Passwort ändern' })
  const loginError = page.locator('.form-error').filter({ hasText: 'Invalid email or password' })

  return Promise.race([
    clockPanel.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'ready' as const),
    forcedPasswordChange.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'forced-password' as const),
    loginError.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'login-error' as const),
  ])
}

function shouldIgnoreBrowserError(text: string) {
  const expectedSocketShutdown = text.includes('4177/api/live') && (
    text.includes('closed before the connection is established')
    || text.includes('interrupted while the page was loading')
    || text.includes('can’t establish a connection')
  )
  return text.includes('status of 401')
    || (text.includes('4177/api/state') && text.includes('access control checks'))
    || expectedSocketShutdown
}

test('admin workflow screens render without browser errors or mobile overflow', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !shouldIgnoreBrowserError(text)) {
      browserErrors.push(text)
    }
  })
  page.on('pageerror', (error) => {
    if (!shouldIgnoreBrowserError(error.message)) {
      browserErrors.push(error.message)
    }
  })

  await page.addInitScript(() => localStorage.setItem('time-tracker-language', 'de'))
  await page.goto('/')
  await signIn(page, smokeTemporaryPassword)

  let loginResult = await waitForLoginResult(page)
  if (loginResult === 'login-error') {
    await signIn(page, smokePassword)
    loginResult = await waitForLoginResult(page)
  }

  if (loginResult === 'forced-password') {
    await page.getByLabel('Aktuelles Passwort').fill(smokeTemporaryPassword)
    await page.getByLabel('Neues Passwort').fill(smokePassword)
    await page.getByLabel('Passwort bestätigen').fill(smokePassword)
    await page.getByRole('button', { name: 'Neues Passwort speichern' }).click()
    await page.locator('.clock-panel').waitFor({ state: 'visible', timeout: 5_000 })
  }

  await expect(page.locator('.clock-panel')).toBeVisible()
  await expect(page.locator('.dco-suite-header[data-product="time"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tage mit Klärungsbedarf' })).toBeVisible()
  await expect(await visibleLayoutProblems(page)).toEqual([])

  const nav = page.locator('.dco-local-navigation')
  for (const tabName of adminTabs) {
    const tabButton = nav.getByRole('button', { exact: true, name: tabName })
    await tabButton.click()
    await expect(tabButton).toBeVisible()
    await expect(await visibleLayoutProblems(page)).toEqual([])
    if (tabName === 'Kalender') {
      await expect(page.locator('.calendar-controls .date-field-month')).toBeVisible()
      await expectDateFieldButtonAttached(page, '.calendar-controls .date-field-month')
      await page.locator('.calendar-controls .date-field-month .date-field-button').click()
      await expect(page.locator('.date-picker-month-grid')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { exact: true, name: 'Woche' }).click()
      await expect(page.locator('.calendar-controls .date-field-week')).toBeVisible()
      await expectDateFieldButtonAttached(page, '.calendar-controls .date-field-week')
      await expect(page.locator('.timed-calendar-week')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Kalender exportieren' })).toBeVisible()
      await expect(await visibleLayoutProblems(page)).toEqual([])
      await page.getByRole('button', { exact: true, name: 'Tag' }).click()
      await expect(page.locator('.calendar-controls .date-field-day')).toBeVisible()
      await expectDateFieldButtonAttached(page, '.calendar-controls .date-field-day')
      await expect(page.locator('.timed-calendar-day')).toBeVisible()
      await expect(await visibleLayoutProblems(page)).toEqual([])
    }
    if (tabName === 'Anträge') {
      await expect(page).toHaveURL(/\/requests$/)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Antragsübersicht' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Antragsübersicht' })).toBeVisible()
      await expectDropdownNearTrigger(page, 'Status')
      await page.getByRole('button', { name: 'Eigener Antrag' }).click()
      await expectDropdownNearTrigger(page, 'Typ')
      await page.getByRole('textbox', { name: 'Startdatum' }).fill('02.07.2026')
      await expect(page.getByRole('textbox', { name: 'Startdatum' })).toHaveValue('02.07.2026')
      await page.getByRole('button', { name: 'Startdatum' }).click()
      await expect(page.locator('.date-picker-weekdays span').first()).toHaveText('Mo')
      await page.keyboard.press('Escape')
    }
    if (tabName === 'Admin-Kalender') {
      await expect(page).toHaveURL(/\/admin-calendar$/)
      await expect(page.locator('.admin-work-calendar-panel')).toBeVisible()
      await expect(page.locator('.admin-work-report-panel')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Arbeitsbericht' })).toBeVisible()
      await page.getByRole('button', { name: 'Angezeigte auswählen' }).click()
      await expect(page.locator('.admin-work-report-table')).toBeVisible()
    }
  }

  await expect(browserErrors).toEqual([])
})
