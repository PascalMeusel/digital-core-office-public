import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests-suite',
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4300',
    browserName: 'chromium',
    viewport: { width: 1366, height: 768 },
  },
  webServer: {
    command: 'node scripts/start-suite-playwright-server.mjs',
    url: 'http://127.0.0.1:4300/api/health',
    reuseExistingServer: false,
    timeout: 240_000,
  },
})
