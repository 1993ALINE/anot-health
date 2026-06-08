// @ts-check
/**
 * Inter-suite settle delay.
 *
 * The E2E specs run serially (workers: 1). Running all suites back-to-back was
 * overloading the dev backend and triggering ECONNRESET mid-run. Pausing a
 * couple of seconds before each spec file's own setup lets the server recover
 * between suites.
 *
 * Playwright has no built-in "delay between files" config option (config can't
 * register fixtures/hooks, and reporters can't block the run), so each spec
 * opts in by calling `settleBetweenSpecFiles()` once at its top level. The
 * registered beforeAll runs before that file's heavy login/seed setup.
 */
const { test } = require('@playwright/test')

const DEFAULT_DELAY_MS = 2000

function settleBetweenSpecFiles(ms = DEFAULT_DELAY_MS) {
  test.beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

module.exports = { settleBetweenSpecFiles }
