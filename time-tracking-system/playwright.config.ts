import { defineConfig } from '@playwright/test'

const desktop = { width: 1366, height: 768 }
const mobile = { width: 390, height: 844 }

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'node scripts/start-playwright-server.mjs',
    url: 'http://localhost:5173',
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true',
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium-desktop', use: { browserName: 'chromium', viewport: desktop } },
    { name: 'chromium-mobile', use: { browserName: 'chromium', viewport: mobile } },
    { name: 'firefox-desktop', use: { browserName: 'firefox', viewport: desktop } },
    { name: 'webkit-desktop', use: { browserName: 'webkit', viewport: desktop } },
    { name: 'webkit-mobile', use: { browserName: 'webkit', viewport: mobile } },
  ],
})
