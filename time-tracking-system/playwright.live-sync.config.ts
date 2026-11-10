import {defineConfig} from '@playwright/test'

// The test owns an isolated Vite fixture. No Time backend or real database is started.
export default defineConfig({
  testDir:'./tests',testMatch:'liveSync.browser.spec.ts',workers:1,timeout:30_000,
  use:{browserName:'chromium',viewport:{width:1440,height:1080},headless:true},
  outputDir:'./test-results/live-sync',
})
