// @ts-check
/**
 * Playwright global setup — runs ONCE before the whole E2E suite.
 *
 * Purpose: don't start hitting the dev servers until they're actually up. The
 * cross-role workflow opens a backend connection in almost every test, and a
 * cold/half-started backend was a source of ECONNRESET / socket-hang-up flakes
 * when the suites ran back-to-back. We poll both the API and the frontend until
 * each responds (or time out with an actionable error), then settle briefly so
 * the first spec's setup isn't the very first request the backend ever sees.
 */
const path = require('path')
const { request } = require('@playwright/test')

require('dotenv').config({ path: path.join(__dirname, '.env') })

const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const READY_TIMEOUT_MS = 60_000

module.exports = async () => {
  const api = await request.newContext()
  const deadline = Date.now() + READY_TIMEOUT_MS
  let backendReady = false
  let frontendReady = false

  try {
    while (Date.now() < deadline && (!backendReady || !frontendReady)) {
      if (!backendReady) {
        // /api/auth/login is POST-only, so a GET returning 404/405 still proves
        // the server process is up and accepting connections.
        const be = await api.get(`${API_URL}/api/auth/login`).catch(() => null)
        if (be) backendReady = true
      }
      if (!frontendReady) {
        const fe = await api.get(BASE_URL).catch(() => null)
        if (fe && fe.ok()) frontendReady = true
      }
      if (!backendReady || !frontendReady) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  } finally {
    await api.dispose()
  }

  if (!backendReady) {
    throw new Error(
      `[global-setup] Backend not reachable at ${API_URL} after ${READY_TIMEOUT_MS / 1000}s. ` +
        'Start it with: npm run dev:backend',
    )
  }
  if (!frontendReady) {
    throw new Error(
      `[global-setup] Frontend not reachable at ${BASE_URL} after ${READY_TIMEOUT_MS / 1000}s. ` +
        'Start it with: npm run dev:frontend',
    )
  }

  // Let the freshly-confirmed backend breathe before suite 1 starts hammering it.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  console.log('[global-setup] backend + frontend are ready.')
}
