// @ts-check
const path = require('path')
const { defineConfig, devices } = require('@playwright/test')

// Test credentials live in playwright/.env (git-ignored — never commit real creds).
require('dotenv').config({ path: path.join(__dirname, 'playwright', '.env') })

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'

module.exports = defineConfig({
  testDir: './tests/e2e',

  // Wait for the backend + frontend to actually be up before any suite runs.
  // This (plus the per-file settle delay in tests/e2e/support/settle.js and the
  // ECONNRESET retry in the admin spec) keeps the dev backend from being hit
  // before it's ready / faster than it can recover between suites.
  globalSetup: require.resolve('./playwright/global-setup.js'),

  // 60s per test: the admin suite (and the full cross-role workflow) can run
  // slowly when the backend is under load and connections are being retried, so
  // we give every spec generous headroom. The cross-role flow is serial, so we
  // keep workers at 1.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // The full clinician → scribe → clinician → QPS → admin flow is inherently
  // sequential (each role acts on state the previous role created), so we don't
  // parallelize and we retry once to absorb transient AI-pipeline/network timing.
  retries: 1,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Auto-grant mic so the recording flow never shows a permission prompt
        // (the MediaRecorder/getUserMedia APIs are also mocked in the spec).
        permissions: ['microphone'],
      },
    },
  ],
})
