// @ts-check
/**
 * Anot Health — QPS (Quality) Workflow (end-to-end).
 *
 * Exercises the quality reviewer's day, driven through the real QPS portal UI
 * (src/pages/QPS/index.jsx):
 *
 *   1. The portal loads (QPS Portal header, sidebar nav)
 *   2. View the queue of submitted notes for a provider
 *   3. Open a note, score the rubric and submit a grade
 *   4. Review the graded note + its scores
 *   5. View scribe performance reports
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PREREQUISITES (checked in beforeAll, fails fast if missing):
 *   1. Frontend dev server at  E2E_BASE_URL  (default http://localhost:5173)
 *        npm run dev:frontend
 *   2. Backend API at          E2E_API_URL   (default http://127.0.0.1:5000)
 *        npm run dev:backend
 *   3. Dev users seeded (qps@dev.anot.local, scribe@…, clinician@…):
 *        npm run seed:dev
 *   4. Credentials present in  playwright/.env  (git-ignored).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THE SPEC MAPS TO THE REAL DOM (a few labels differ from the brief):
 *   • The "QPS Portal" header is the sidebar brand subtitle (PortalSidebarBrand).
 *   • The QPS sidebar nav items (.sf-nav-item) are Notes / Graded / Performance
 *     (there is no separate "My Grades" item — the brief's wording maps to these).
 *   • QPS picks a provider (.sf-provider-card) to load that clinician's queue;
 *     pending notes are .qps-note-card rows with a "Review Note" button.
 *   • The rubric uses four 0–100 sliders (input[type=range]) — Accuracy,
 *     Completeness, Medical Terminology, Formatting — a required comment, and a
 *     "Submit Grade" button; success toast = "Grade submitted successfully".
 *   • Graded notes live on the Graded tab as .qps-note-card--graded rows; opening
 *     one ("View Grade") reopens it in a locked, read-only state (disabled rubric
 *     sliders + an "Already graded" marker). The QPS list endpoint does not join
 *     the grades table, so the reopened note shows default slider values, not the
 *     stored scores — the spec asserts the locked grading UI, not a score value.
 *
 * The seed creates a clinician-owned visit, drafts a note as the scribe and
 * submits it, so Tests 2–4 always have a submitted note ready to grade.
 *
 * Runs SERIALLY against one logged-in QPS session.
 */

const { test, expect, request: pwRequest } = require('@playwright/test')
const { settleBetweenSpecFiles } = require('./support/settle')

// Pause ~2s before this suite's setup so back-to-back suites don't overload the
// dev backend (a source of ECONNRESET). See tests/e2e/support/settle.js.
settleBetweenSpecFiles()

// ── Config / credentials (from playwright/.env via playwright.config.js) ──────
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')

const QPS = { email: process.env.QPS_EMAIL, password: process.env.QPS_PASSWORD }
const CLINICIAN = { email: process.env.CLINICIAN_EMAIL, password: process.env.CLINICIAN_PASSWORD }
const SCRIBE = { email: process.env.SCRIBE_EMAIL, password: process.env.SCRIBE_PASSWORD }
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }

const PROVIDER_NAME = 'Dev Clinician'

// Unique-per-run identity so reruns never collide and selectors stay precise.
const RUN_ID = Date.now().toString().slice(-6)
const PATIENT_NAME = `QPS WF Patient ${RUN_ID}`
const PATIENT_MRN = `QWF${RUN_ID}`
const PATIENT_DOB = '1979-02-09'
const VISIT_TIME = '13:30'
const SEED_TRANSCRIPT = JSON.stringify(['Patient presents for routine follow-up. Vitals stable.'])
const SEED_FINAL_NOTE = [
  'SUBJECTIVE: Routine follow-up, no new complaints.',
  'OBJECTIVE: BP 118/76, afebrile.',
  'ASSESSMENT: Stable.',
  'PLAN: Continue current management.',
].join('\n')
const GRADE_COMMENT = 'Good clinical note with clear documentation'

// State shared across the serial tests.
const shared = {
  context: /** @type {import('@playwright/test').BrowserContext|null} */ (null),
  page: /** @type {import('@playwright/test').Page|null} */ (null),
  clinicianToken: /** @type {string|null} */ (null),
  scribeToken: /** @type {string|null} */ (null),
  clinicianId: /** @type {string|number|null} */ (null),
  scribeId: /** @type {string|number|null} */ (null),
  visitId: /** @type {string|number|null} */ (null),
  noteId: /** @type {string|number|null} */ (null),
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Direct API login — returns { token, user }. Used for setup/cleanup. */
async function apiLogin(api, email, password) {
  const res = await api.post(`${API_URL}/api/auth/login`, { data: { email, password } })
  if (!res.ok()) {
    throw new Error(`API login failed for ${email}: ${res.status()} ${await res.text()}`)
  }
  return res.json()
}

/** Authorization header for a bearer token. */
const auth = (token) => ({ Authorization: `Bearer ${token}` })

/** Today's date as YYYY-MM-DD in local time. */
function localToday() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True if the locator becomes visible within `ms`, false otherwise (no throw). */
async function visibleSoon(locator, ms = 3000) {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout: ms })
    .then(() => true)
    .catch(() => false)
}

/** UI login as QPS — resolves once routed to /qps. */
async function loginAsQps(page) {
  await page.goto('/login')
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.fill('#login-email', QPS.email)
  await page.fill('#login-password', QPS.password)
  await Promise.all([
    page.waitForURL(/\/qps(\b|\/|$)/, { timeout: 20_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ])
}

/** Click a sidebar nav item (Notes / Graded / Performance). */
async function navClick(page, label) {
  await page
    .locator('.sf-nav-item')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .click()
}

/** Open the provider's pending-notes queue (provider card → review list). */
async function gotoReviewQueue(page) {
  await navClick(page, 'Notes')
  const providerCard = page.locator('.sf-provider-card').filter({ hasText: PROVIDER_NAME })
  if (await visibleSoon(providerCard, 5000)) {
    await providerCard.first().click()
  }
  await expect(page.getByText(/need review|Notes Needing Review/i).first()).toBeVisible({ timeout: 15_000 })
}

/**
 * Seed a submitted note ready for grading:
 *   1. Ensure the scribe⇄clinician assignment exists (admin API; tolerant of 409).
 *   2. Create patient + visit (clinician API).
 *   3. Save a draft note with transcription + final note (scribe API).
 *   4. Submit the note (scribe API) → status 'submitted' (gradeable by QPS).
 */
async function seedSubmittedNote(api) {
  if (ADMIN.email && ADMIN.password) {
    try {
      const admin = await apiLogin(api, ADMIN.email, ADMIN.password)
      const usersRes = await api.get(`${API_URL}/api/users`, { headers: auth(admin.token) })
      if (usersRes.ok()) {
        const body = await usersRes.json()
        const users = Array.isArray(body) ? body : body.users || []
        shared.clinicianId = users.find((u) => u.email === CLINICIAN.email)?.id ?? null
        shared.scribeId = users.find((u) => u.email === SCRIBE.email)?.id ?? null
        if (shared.clinicianId && shared.scribeId) {
          const assignRes = await api.post(`${API_URL}/api/assignments`, {
            headers: auth(admin.token),
            data: { clinician_id: shared.clinicianId, scribe_id: shared.scribeId },
          })
          if (!assignRes.ok() && assignRes.status() !== 409) {
            console.warn(`[seed] assignment create returned ${assignRes.status()} (continuing).`)
          }
        }
      }
    } catch (e) {
      console.warn('[seed] could not ensure scribe assignment:', e.message)
    }
  }

  const patientRes = await api.post(`${API_URL}/api/patients`, {
    headers: auth(shared.clinicianToken),
    data: { name: PATIENT_NAME, mrn: PATIENT_MRN, date_of_birth: PATIENT_DOB },
  })
  if (!patientRes.ok() && patientRes.status() !== 409) {
    throw new Error(`seed patient create failed: ${patientRes.status()} ${await patientRes.text()}`)
  }
  const patientId = (await patientRes.json()).patient.id

  const visitRes = await api.post(`${API_URL}/api/visits`, {
    headers: auth(shared.clinicianToken),
    data: { patient_id: patientId, visit_date: localToday(), visit_time: VISIT_TIME, visit_type: 'Follow-up' },
  })
  if (!visitRes.ok()) {
    throw new Error(`seed visit create failed: ${visitRes.status()} ${await visitRes.text()}`)
  }
  shared.visitId = (await visitRes.json()).visit.id

  const draftRes = await api.post(`${API_URL}/api/notes/draft`, {
    headers: auth(shared.scribeToken),
    data: { visit_id: shared.visitId, transcription: SEED_TRANSCRIPT, final_note: SEED_FINAL_NOTE },
  })
  if (!draftRes.ok()) {
    throw new Error(`seed draft create failed: ${draftRes.status()} ${await draftRes.text()}`)
  }
  shared.noteId = (await draftRes.json()).note.id

  const submitRes = await api.put(`${API_URL}/api/notes/${shared.noteId}/submit`, {
    headers: auth(shared.scribeToken),
  })
  if (!submitRes.ok()) {
    throw new Error(`seed note submit failed: ${submitRes.status()} ${await submitRes.text()}`)
  }

  console.log(`[seed] submitted note ${shared.noteId} on visit ${shared.visitId} for "${PATIENT_NAME}".`)
}

// ── Global setup ──────────────────────────────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  if (!QPS.email || !QPS.password) {
    throw new Error('Missing QPS credentials. Set QPS_EMAIL / QPS_PASSWORD in playwright/.env.')
  }
  if (!CLINICIAN.email || !SCRIBE.email) {
    throw new Error('Missing clinician/scribe credentials needed to seed a submitted note.')
  }

  const api = await pwRequest.newContext()
  try {
    const fe = await api.get(BASE_URL).catch(() => null)
    if (!fe || !fe.ok()) {
      throw new Error(`Frontend not reachable at ${BASE_URL}. Start it with: npm run dev:frontend`)
    }
    const be = await api.get(`${API_URL}/api/auth/login`).catch(() => null)
    if (!be) throw new Error(`Backend not reachable at ${API_URL}. Start it with: npm run dev:backend`)

    const clin = await apiLogin(api, CLINICIAN.email, CLINICIAN.password)
    shared.clinicianToken = clin.token
    const scr = await apiLogin(api, SCRIBE.email, SCRIBE.password)
    shared.scribeToken = scr.token

    await seedSubmittedNote(api)
  } finally {
    await api.dispose()
  }

  shared.context = await browser.newContext()
  shared.page = await shared.context.newPage()

  // ── Setup: login + verify the QPS portal loads ──
  await loginAsQps(shared.page)
  await expect(shared.page).toHaveURL(/\/qps/)
  await expect(shared.page.locator('.qps-portal')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  // ── Teardown: remove the seeded visit (cascades its note + grade) via clinician API. ──
  if (shared.visitId && shared.clinicianToken) {
    const api = await pwRequest.newContext()
    try {
      const res = await api.delete(`${API_URL}/api/visits/${shared.visitId}`, {
        headers: auth(shared.clinicianToken),
      })
      if (!res.ok()) console.warn(`[cleanup] DELETE /api/visits/${shared.visitId} -> ${res.status()}`)
    } catch (e) {
      console.warn('[cleanup] visit delete failed:', e.message)
    } finally {
      await api.dispose()
    }
  }
  await shared.context?.close()
})

// Sequential workflow on a single shared QPS session.
test.describe.configure({ mode: 'serial' })

test.describe('QPS Quality Workflow', () => {
  // ── Test 1: QPS portal loads correctly ──────────────────────────────────────
  test('1. Portal loads with nav', async () => {
    const page = shared.page

    // "QPS Portal" header (sidebar brand subtitle).
    await expect(page.getByText(/QPS Portal/i).first()).toBeVisible({ timeout: 15_000 })

    // Sidebar nav items (Notes / Graded / Performance).
    for (const label of ['Notes', 'Graded', 'Performance']) {
      await expect(
        page.locator('.sf-nav-item').filter({ has: page.getByText(label, { exact: true }) }).first(),
      ).toBeVisible()
    }
  })

  // ── Test 2: View pending notes for grading ──────────────────────────────────
  test('2. View pending notes for grading', async () => {
    const page = shared.page
    await gotoReviewQueue(page)

    // The seeded submitted note is listed with the patient + a Review button.
    const card = page.locator('.qps-note-card').filter({ hasText: PATIENT_NAME })
    await expect(card.first()).toBeVisible({ timeout: 15_000 })
    await expect(card.first()).toContainText(PATIENT_MRN)
    await expect(card.first().getByRole('button', { name: /Review Note/i })).toBeVisible()
  })

  // ── Test 3: Open and grade a note ───────────────────────────────────────────
  test('3. Open and grade a note', async () => {
    const page = shared.page
    await gotoReviewQueue(page)

    const card = page.locator('.qps-note-card').filter({ hasText: PATIENT_NAME })
    await expect(card.first()).toBeVisible({ timeout: 15_000 })
    await card.first().getByRole('button', { name: /Review Note/i }).click()

    // Note content is shown in the read-only Final Note panel.
    await expect(page.locator('.sf-textarea-readonly')).toContainText(/SUBJECTIVE|ASSESSMENT/i, {
      timeout: 15_000,
    })

    // Set all four rubric sliders to 80.
    const sliders = page.locator('input[type="range"]')
    await expect(sliders.first()).toBeVisible({ timeout: 15_000 })
    const count = await sliders.count()
    expect(count).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < count; i++) {
      await sliders.nth(i).fill('80')
    }

    // Required comment.
    await page.getByPlaceholder(/Write feedback or comments/i).fill(GRADE_COMMENT)

    // Submit the grade.
    const grade = page.waitForResponse(
      (r) => /\/api\/notes\/grade/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await page.getByRole('button', { name: /Submit Grade/i }).click()
    expect((await grade).ok()).toBeTruthy()

    await expect(page.getByText(/Grade submitted successfully/i)).toBeVisible({ timeout: 15_000 })

    // After grading, the QPS view auto-returns to the provider's review queue
    // (a ~1.5s deferred setScreen('recordings') in handleSubmit). Wait for that
    // navigation to land here so its timer can't fire mid-way through Test 4 and
    // bounce us off the review screen while we're inspecting the graded note.
    await expect(page.getByText(/notes need review/i).first()).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 4: View graded notes ───────────────────────────────────────────────
  test('4. View graded notes', async () => {
    const page = shared.page
    await navClick(page, 'Graded')

    // The freshly-graded note appears with a "Graded" badge.
    const graded = page.locator('.qps-note-card--graded').filter({ hasText: PATIENT_NAME })
    await expect(graded.first()).toBeVisible({ timeout: 15_000 })
    await expect(graded.first().locator('.badge-green')).toContainText(/Graded/i)

    // Open it and confirm it reopens in a read-only "already graded" state.
    // NOTE: the QPS list endpoint (GET /api/notes?status=uploaded) does not join
    // the grades table, so a graded note reopened from this list carries no stored
    // rubric scores — the page shows its default slider values and locks editing
    // (isGraded ⇒ sliders disabled, comment read-only, no Submit, "Already graded").
    // We therefore assert the locked grading UI rather than a specific score value.
    await graded.first().getByRole('button', { name: /View Grade/i }).click()

    // The graded note's content is shown in the read-only Final Note panel.
    await expect(page.locator('.sf-textarea-readonly')).toContainText(/SUBJECTIVE|ASSESSMENT/i, {
      timeout: 15_000,
    })

    // Rubric sliders render but are disabled, and the "Already graded" marker shows
    // in place of the Submit button.
    const sliders = page.locator('input[type="range"]')
    await expect(sliders.first()).toBeVisible({ timeout: 15_000 })
    await expect(sliders.first()).toBeDisabled()
    await expect(page.getByText(/Already graded/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /Submit Grade/i })).toHaveCount(0)
  })

  // ── Test 5: View performance reports ────────────────────────────────────────
  test('5. View performance reports', async () => {
    const page = shared.page
    await navClick(page, 'Performance')

    // Performance page loads with its summary stat cards + scribe section.
    await expect(page.getByText(/Performance Reports|Scribes Tracked/i).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/Scribe Performance/i)).toBeVisible({ timeout: 15_000 })
  })
})
