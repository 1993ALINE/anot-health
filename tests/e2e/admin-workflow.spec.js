// @ts-check
/**
 * Anot Health — Admin / Super Admin Workflow (end-to-end).
 *
 * Exercises the platform administrator's day, driven through the real Admin
 * portal UI (src/pages/Admin/index.jsx):
 *
 *   1. The portal loads (Super Admin badge + every sidebar module)
 *   2. Overview dashboard (stat cards / user counts)
 *   3. Manage clinicians (table with name / email / status)
 *   4. Create a new scribe (Register modal + confirm)
 *   5. Manage assignments (assign the new scribe to a clinician)
 *   6. View audit logs (table + a filter)
 *   7. View settings (Deepgram / Anthropic API keys — read only, no changes)
 *   8. Profile management (form is pre-filled — no save)
 *   9. Deactivate the test scribe (cleanup)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PREREQUISITES (checked in beforeAll, fails fast if missing):
 *   1. Frontend dev server at  E2E_BASE_URL  (default http://localhost:5173)
 *        npm run dev:frontend
 *   2. Backend API at          E2E_API_URL   (default http://127.0.0.1:5000)
 *        npm run dev:backend
 *   3. The super-admin account exists (atiqur@anot.health).
 *   4. Credentials present in  playwright/.env  (git-ignored).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THE SPEC MAPS TO THE REAL DOM (a few labels differ from the brief):
 *   • Sidebar nav items are divs with data-adm-nav="<key>" (overview, clinicians,
 *     scribes, qps, admins, assignments, payroll, audit, settings,
 *     system-profile). The "Super Admin" label is the sidebar brand subtitle.
 *   • "Add Scribe" = the "+ Add Scribe" button in the scribes toolbar; it opens
 *     a "Register new Scribe" modal whose fields have no ids, so we target inputs
 *     by placeholder. Saving needs the modal "Create Scribe account" button AND a
 *     follow-up confirm dialog (.adm-modal--confirm) — success toast =
 *     "<name> registered successfully".
 *   • Assignments: pick a clinician + scribe from the two selects in
 *     .adm-form-card--dashed, then "+ Assign" → toast "Scribe assigned successfully".
 *   • Audit logs render in .adm-auditpro-table with a toolbar of filter selects.
 *   • Settings shows the API keys as "(saved)" next to the key labels (best-effort
 *     — depends on whether keys are configured in this environment).
 *   • The scribe table has no Delete action, so Test 9 deactivates ("Disable")
 *     the test scribe (confirm dialog) and verifies it flips to "Inactive". The
 *     account is then hard-deleted via the API in teardown for a clean rerun.
 *
 * Runs SERIALLY against one logged-in super-admin session.
 */

const { test, expect, request: pwRequest } = require('@playwright/test')
const { settleBetweenSpecFiles } = require('./support/settle')

// Pause ~2s before this suite's setup so back-to-back suites don't overload the
// dev backend (a source of ECONNRESET). See tests/e2e/support/settle.js.
settleBetweenSpecFiles()

// ── Config / credentials (from playwright/.env via playwright.config.js) ──────
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')

const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }

const PROVIDER_NAME = 'Dev Clinician'

// The test scribe this run creates / assigns / deactivates / deletes.
const TEST_SCRIBE_NAME = 'E2E Test Scribe'
const TEST_SCRIBE_EMAIL = 'e2e.scribe@anot.health'
const TEST_SCRIBE_PASSWORD = 'TestScribe@2026!'

// State shared across the serial tests.
const shared = {
  context: /** @type {import('@playwright/test').BrowserContext|null} */ (null),
  page: /** @type {import('@playwright/test').Page|null} */ (null),
  token: /** @type {string|null} */ (null),
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Direct API login — returns { token, user }. Used for setup/cleanup.
 *
 * The dev backend can drop the connection (ECONNRESET / socket hang up) when
 * it's under load from the full suite, so we retry transient connection errors
 * up to 3 times with a 2s pause. Auth failures (bad status) are NOT retried —
 * those are deterministic and should fail fast.
 */
async function apiLogin(api, email, password) {
  const MAX_RETRIES = 3
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await api.post(`${API_URL}/api/auth/login`, { data: { email, password } })
      if (!res.ok()) {
        throw new Error(`API login failed for ${email}: ${res.status()} ${await res.text()}`)
      }
      return res.json()
    } catch (err) {
      lastErr = err
      const transient = /ECONNRESET|socket hang up|ECONNREFUSED|ETIMEDOUT/i.test(err.message || '')
      if (transient && attempt < MAX_RETRIES) {
        console.warn(
          `[admin] apiLogin connection error for ${email} ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message} — retrying in 2s…`,
        )
        await new Promise((resolve) => setTimeout(resolve, 2000))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/** Authorization header for a bearer token. */
const auth = (token) => ({ Authorization: `Bearer ${token}` })

/** UI login as the (super) admin — resolves once routed to /admin. */
async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.fill('#login-email', ADMIN.email)
  await page.fill('#login-password', ADMIN.password)
  await Promise.all([
    page.waitForURL(/\/admin(\b|\/|$)/, { timeout: 20_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ])
}

/** Click a sidebar module by its data-adm-nav key. */
async function gotoTab(page, key) {
  await page.locator(`[data-adm-nav="${key}"]`).first().click()
}

/**
 * Best-effort: remove the test scribe (and any assignment referencing it) via the
 * API so the create-scribe test can run repeatably. Tolerant of missing rows.
 */
async function purgeTestScribe(api, token) {
  try {
    // Drop any assignment that references the test scribe first (FK safety).
    const assignRes = await api.get(`${API_URL}/api/assignments`, { headers: auth(token) })
    if (assignRes.ok()) {
      const { assignments = [] } = await assignRes.json()
      for (const a of assignments) {
        if (a.scribe_email === TEST_SCRIBE_EMAIL) {
          await api.delete(`${API_URL}/api/assignments/${a.id}`, { headers: auth(token) }).catch(() => {})
        }
      }
    }
    // Then delete the user itself.
    const usersRes = await api.get(`${API_URL}/api/users`, { headers: auth(token) })
    if (usersRes.ok()) {
      const body = await usersRes.json()
      const users = Array.isArray(body) ? body : body.users || []
      const existing = users.find((u) => u.email === TEST_SCRIBE_EMAIL)
      if (existing) {
        await api.delete(`${API_URL}/api/users/${existing.id}`, { headers: auth(token) }).catch(() => {})
      }
    }
  } catch (e) {
    console.warn('[cleanup] purgeTestScribe failed:', e.message)
  }
}

// ── Global setup ──────────────────────────────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  if (!ADMIN.email || !ADMIN.password) {
    throw new Error('Missing admin credentials. Set ADMIN_EMAIL / ADMIN_PASSWORD in playwright/.env.')
  }

  const api = await pwRequest.newContext()
  try {
    const fe = await api.get(BASE_URL).catch(() => null)
    if (!fe || !fe.ok()) {
      throw new Error(`Frontend not reachable at ${BASE_URL}. Start it with: npm run dev:frontend`)
    }
    const be = await api.get(`${API_URL}/api/auth/login`).catch(() => null)
    if (!be) throw new Error(`Backend not reachable at ${API_URL}. Start it with: npm run dev:backend`)

    const admin = await apiLogin(api, ADMIN.email, ADMIN.password)
    shared.token = admin.token

    // Make sure no leftover test scribe exists from a previous run.
    await purgeTestScribe(api, shared.token)
  } finally {
    await api.dispose()
  }

  shared.context = await browser.newContext()
  shared.page = await shared.context.newPage()

  // ── Setup: login + verify the admin portal loads ──
  await loginAsAdmin(shared.page)
  await expect(shared.page).toHaveURL(/\/admin/)
  await expect(shared.page.locator('.adm-sidebar')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  // ── Teardown: hard-delete the test scribe (and its assignment) via the API. ──
  if (shared.token) {
    const api = await pwRequest.newContext()
    try {
      await purgeTestScribe(api, shared.token)
    } finally {
      await api.dispose()
    }
  }
  await shared.context?.close()
})

// Sequential workflow on a single shared admin session.
test.describe.configure({ mode: 'serial' })

test.describe('Admin / Super Admin Workflow', () => {
  // ── Test 1: Admin portal loads correctly ────────────────────────────────────
  test('1. Portal loads with badge + all sidebar modules', async () => {
    const page = shared.page

    // Super Admin label (sidebar brand subtitle).
    await expect(page.getByText(/Super Admin/i).first()).toBeVisible({ timeout: 15_000 })

    // Every sidebar module is present.
    const modules = [
      ['overview', 'Overview'],
      ['clinicians', 'Clinicians'],
      ['scribes', 'Scribes'],
      ['qps', 'QPS Staff'],
      ['admins', 'Admins'],
      ['assignments', 'Assignments'],
      ['payroll', 'Payroll'],
      ['audit', 'Audit Logs'],
      ['settings', 'Settings'],
      ['system-profile', 'Profile Management'],
    ]
    for (const [key, label] of modules) {
      const item = page.locator(`[data-adm-nav="${key}"]`)
      await expect(item).toHaveCount(1)
      await expect(item).toContainText(label)
    }
  })

  // ── Test 2: Overview dashboard ──────────────────────────────────────────────
  test('2. Overview dashboard loads', async () => {
    const page = shared.page
    await gotoTab(page, 'overview')

    // Stat cards render with user counts.
    await expect(page.locator('.adm-stats-grid')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.adm-stats-grid .adm-stat-card, .adm-stats-grid > *').first()).toBeVisible()

    // Spotlight panels (e.g. Clinicians) render too.
    await expect(page.getByText('Clinicians', { exact: true }).first()).toBeVisible()
  })

  // ── Test 3: Manage clinicians ───────────────────────────────────────────────
  test('3. Manage clinicians', async () => {
    const page = shared.page
    await gotoTab(page, 'clinicians')

    // Table head + at least one clinician row showing name / email / status.
    await expect(page.locator('.adm-table__head').first()).toBeVisible({ timeout: 15_000 })
    const rows = page.locator('.adm-table__row')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    await expect(rows.first().locator('.adm-badge').first()).toBeVisible()
  })

  // ── Test 4: Create a new scribe ─────────────────────────────────────────────
  test('4. Create a new scribe', async () => {
    const page = shared.page
    await gotoTab(page, 'scribes')

    await page.getByRole('button', { name: /\+\s*Add Scribe/i }).first().click()

    // "Register new Scribe" modal — fields are targeted by placeholder.
    const modal = page.locator('.adm-modal').filter({ hasText: /Register new/i })
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await modal.getByPlaceholder('Full name').fill(TEST_SCRIBE_NAME)
    await modal.getByPlaceholder('name@anot.ai').fill(TEST_SCRIBE_EMAIL)
    await modal.getByPlaceholder(/Min\. 12 chars/i).fill(TEST_SCRIBE_PASSWORD)

    // Submit → confirm dialog → confirm.
    await modal.getByRole('button', { name: /Create Scribe account/i }).click()
    const confirm = page.locator('.adm-modal--confirm')
    await expect(confirm).toBeVisible({ timeout: 10_000 })

    const register = page.waitForResponse(
      (r) => /\/api\/auth\/register/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await confirm.getByRole('button', { name: /Create Scribe account/i }).click()
    expect((await register).ok()).toBeTruthy()

    // Success toast + the new scribe appears in the list.
    await expect(page.getByText(new RegExp(`${TEST_SCRIBE_NAME} registered successfully`, 'i'))).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      page.locator('.adm-table__row').filter({ hasText: TEST_SCRIBE_NAME }).first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 5: Manage assignments ──────────────────────────────────────────────
  test('5. Assign the test scribe to a clinician', async () => {
    const page = shared.page
    await gotoTab(page, 'assignments')

    const assignCard = page.locator('.adm-form-card--dashed')
    await expect(assignCard).toBeVisible({ timeout: 15_000 })
    const selects = assignCard.locator('select')
    await selects.nth(0).selectOption({ label: PROVIDER_NAME })
    await selects.nth(1).selectOption({ label: TEST_SCRIBE_NAME })

    const assign = page.waitForResponse(
      (r) => /\/api\/assignments$/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await assignCard.getByRole('button', { name: /\+\s*Assign/i }).click()
    expect((await assign).ok()).toBeTruthy()

    await expect(page.getByText(/Scribe assigned successfully/i)).toBeVisible({ timeout: 15_000 })

    // The new pairing shows in the assignments table.
    await expect(
      page.locator('.adm-table__row').filter({ hasText: TEST_SCRIBE_NAME }).first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 6: View audit logs ─────────────────────────────────────────────────
  test('6. View audit logs', async () => {
    const page = shared.page
    await gotoTab(page, 'audit')

    // The audit table loads with entries (status / user / time / action columns).
    await expect(page.locator('.adm-auditpro-table')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.adm-auditpro-table thead')).toContainText(/Action/i)
    await expect(page.locator('.adm-auditpro-table tbody tr').first()).toBeVisible({ timeout: 15_000 })

    // Apply a filter (by role) and confirm the table responds without error.
    const roleSelect = page.locator('.adm-auditpro-select').first()
    await roleSelect.selectOption({ label: 'Admin' })
    await expect(
      page.locator('.adm-auditpro-table, .adm-empty-state').first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 7: View settings (read-only) ───────────────────────────────────────
  test('7. View settings — API keys (no changes)', async () => {
    const page = shared.page
    await gotoTab(page, 'settings')

    // Deepgram + Anthropic sections render.
    await expect(page.getByText(/Deepgram \(transcription\)/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Anthropic API key/i)).toBeVisible()

    // Both API keys are configured and so display a green "(saved)" marker beside
    // their key labels. The Deepgram key label reads "API key (saved)"; the
    // Anthropic one reads "Anthropic API key (saved)".
    const deepgramKeyLabel = page.locator('label.adm-form-label').filter({ hasText: /^API key/ })
    await expect(deepgramKeyLabel.first()).toContainText(/saved/i, { timeout: 15_000 })

    const anthropicKeyLabel = page.locator('label.adm-form-label').filter({ hasText: /Anthropic API key/i })
    await expect(anthropicKeyLabel.first()).toContainText(/saved/i)
    // Intentionally do NOT change or save any settings.
  })

  // ── Test 8: Profile management (no save) ────────────────────────────────────
  test('8. Profile management form is pre-filled', async () => {
    const page = shared.page
    await gotoTab(page, 'system-profile')

    await expect(page.locator('.pm-card')).toBeVisible({ timeout: 15_000 })
    // "Profile Management" appears in several places (nav, topbar, hero, card);
    // assert the Profile card's own heading specifically (unique #pm-heading).
    await expect(page.locator('#pm-heading')).toHaveText(/Profile Management/i)

    // Name + email are pre-filled from the signed-in account.
    const inputs = page.locator('.pm-input')
    await expect(inputs.nth(0)).not.toHaveValue('')
    await expect(inputs.nth(1)).toHaveValue(/@/)
    // Intentionally do NOT save changes.
  })

  // ── Test 9: Deactivate the test scribe (cleanup) ────────────────────────────
  test('9. Deactivate the test scribe', async () => {
    const page = shared.page
    await gotoTab(page, 'scribes')

    // Narrow the table to the test scribe.
    await page.getByPlaceholder(/Search Scribes/i).fill(TEST_SCRIBE_NAME)
    const row = page.locator('.adm-table__row').filter({ hasText: TEST_SCRIBE_NAME })
    await expect(row.first()).toBeVisible({ timeout: 15_000 })

    // Disable → confirm dialog → confirm.
    await row.first().getByRole('button', { name: /^Disable$/i }).click()
    const confirm = page.locator('.adm-modal--confirm')
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/users\/.*\/toggle-status/.test(r.url()) && r.request().method() === 'PUT',
        { timeout: 20_000 },
      ),
      confirm.getByRole('button', { name: /Disable user/i }).click(),
    ])

    // Confirmation toast + the row now reads Inactive.
    await expect(page.getByText(new RegExp(`${TEST_SCRIBE_NAME} deactivated`, 'i'))).toBeVisible({
      timeout: 15_000,
    })
    await expect(row.first().locator('.adm-badge')).toContainText(/Inactive/i, { timeout: 15_000 })
  })
})
