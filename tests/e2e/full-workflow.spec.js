// @ts-check
/**
 * Anot Health — full clinical-documentation workflow (end-to-end).
 *
 * Covers the real cross-role journey:
 *   Clinician schedules a patient + visit → records mock audio → sends to scribe
 *   → Scribe drafts & submits the note → QPS grades it
 *   → Clinician reviews & locks it.
 *
 * Ordering note: QPS grades BEFORE the clinician locks, because the backend
 * reuses notes.status = 'uploaded' for both "graded" and "locked", and the QPS
 * portal disables grading once a note is 'uploaded'. So grading must happen
 * while the note is still 'submitted'.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PREREQUISITES (the suite checks these in beforeAll and fails fast if missing):
 *   1. Frontend dev server running at  E2E_BASE_URL  (default http://localhost:5173)
 *        cd anot-frontend-main/anot-frontend-main && npm run dev
 *   2. Backend API running at          E2E_API_URL   (default http://127.0.0.1:5000)
 *        cd anot-backend-main/anot-backend-main && npm run dev
 *   3. Dev users seeded (clinician/scribe/qps@dev.anot.local) + the super-admin
 *      account (atiqur@anot.health):
 *        cd anot-backend-main/anot-backend-main && ALLOW_DEV_SEED=true node scripts/seed-dev-users.js
 *   4. Credentials present in  playwright/.env  (git-ignored).
 *
 * The suite itself wires up the one piece of state the seed doesn't:
 * it assigns the dev scribe to the dev clinician (via the admin API) so the
 * scribe can see the clinician's visit in Test 3.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THE TESTS MAP TO THE REAL UI (a few labels differ from the spec wording):
 *   • "+ Add Patient" opens a "Schedule New Patient" modal that creates the
 *     patient AND the visit together — so Tests 1 & 2 share that one modal and
 *     Test 2 focuses on the recording itself.
 *   • Start recording  = the green "Record Encounter" button on a visit row.
 *     Stop recording    = the red "■ End" button in the live-recording banner.
 *   • Scribe "Submit to clinician" = the "Upload to EMR" button (it saves the
 *     draft then submits); success toast = "Note submitted to clinician.".
 *   • The QPS rubric uses 0–100 sliders (not 1–5); "5/5 = excellent" is encoded
 *     as a 100 on each slider.
 *   • There is no delete-patient API endpoint, so cleanup (Test 6) removes the
 *     VISIT via the clinician API (best-effort) — the patient row is left in place.
 *
 * These tests run SERIALLY (workers: 1) because each role acts on state the
 * previous role created — a real workflow can't be parallelized.
 */

const { test, expect, request: pwRequest } = require('@playwright/test')
const { settleBetweenSpecFiles } = require('./support/settle')

// Pause ~2s before this suite's setup so back-to-back suites don't overload the
// dev backend (a source of ECONNRESET). See tests/e2e/support/settle.js.
settleBetweenSpecFiles()

// ── Config / credentials (from playwright/.env via playwright.config.js) ──────
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')

const CREDS = {
  clinician: { email: process.env.CLINICIAN_EMAIL, password: process.env.CLINICIAN_PASSWORD },
  scribe: { email: process.env.SCRIBE_EMAIL, password: process.env.SCRIBE_PASSWORD },
  qps: { email: process.env.QPS_EMAIL, password: process.env.QPS_PASSWORD },
  admin: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
}

// Unique-per-run identity so reruns don't collide and the audit search is precise.
const RUN_ID = Date.now().toString().slice(-6)
const PATIENT_NAME = `E2E Test Patient ${RUN_ID}`
const PATIENT_DOB = '1990-01-15'
const PATIENT_MRN = `E2E${RUN_ID}`
const VISIT_TIME = '09:00' // 9:00 AM
const TRANSCRIPT_TEXT = 'Patient reports headache for 2 days'
const FINAL_NOTE =
  'Patient presents with 2-day headache. Assessment: Tension headache. Plan: Ibuprofen 400mg.'

// State shared across the serial tests.
const shared = {
  clinicianContext: /** @type {import('@playwright/test').BrowserContext|null} */ (null),
  clinicianPage: /** @type {import('@playwright/test').Page|null} */ (null),
  clinicianToken: /** @type {string|null} */ (null),
  visitId: /** @type {string|number|null} */ (null),
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Direct API login — returns { token, user }. Used for setup/cleanup. */
async function apiLogin(api, email, password) {
  const res = await api.post(`${API_URL}/api/auth/login`, { data: { email, password } })
  if (!res.ok()) throw new Error(`API login failed for ${email}: ${res.status()} ${await res.text()}`)
  return res.json()
}

/**
 * Inject fake getUserMedia + MediaRecorder BEFORE any page script runs so the
 * clinician recording flow works headlessly without a real microphone.
 * addInitScript (not page.evaluate) is required: the app reads these APIs at
 * record time, which can be before any evaluate() we run post-load.
 */
async function installAudioMocks(context) {
  await context.addInitScript(() => {
    const makeStream = () => {
      const track = { kind: 'audio', stop() {}, addEventListener() {}, removeEventListener() {} }
      return { getTracks: () => [track], getAudioTracks: () => [track], addTrack() {}, removeTrack() {} }
    }
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    }
    navigator.mediaDevices.getUserMedia = async () => makeStream()

    class MockMediaRecorder {
      constructor(stream, opts) {
        this.stream = stream
        this.state = 'inactive'
        this.mimeType = (opts && opts.mimeType) || 'audio/webm'
        this.ondataavailable = null
        this.onstop = null
        this.onerror = null
        this._timer = null
      }
      _emit() {
        if (typeof this.ondataavailable === 'function') {
          this.ondataavailable({ data: new Blob(['mock audio data'], { type: this.mimeType }) })
        }
      }
      start() {
        this.state = 'recording'
        // Emit a chunk every second, mirroring rec.start(1000) timeslice usage.
        this._timer = setInterval(() => this._emit(), 1000)
      }
      pause() { this.state = 'paused' }
      resume() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        if (this._timer) clearInterval(this._timer)
        this._emit()
        if (typeof this.onstop === 'function') this.onstop()
      }
      requestData() { this._emit() }
      static isTypeSupported() { return true }
    }
    // @ts-ignore
    window.MediaRecorder = MockMediaRecorder
  })
}

/** UI login. Lands on the role's portal and resolves once routed there. */
async function loginAs(page, role) {
  const { email, password } = CREDS[role]
  await page.goto('/login')
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await Promise.all([
    page.waitForURL(new RegExp(`/${role}(\\b|/|$)`), { timeout: 20_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ])
}

// ── Global setup: health checks + scribe⇄clinician assignment ────────────────
test.beforeAll(async ({ browser }) => {
  for (const [role, c] of Object.entries(CREDS)) {
    if (!c.email || !c.password) {
      throw new Error(
        `Missing ${role} credentials. Create playwright/.env (see repo) with ${role.toUpperCase()}_EMAIL / _PASSWORD.`,
      )
    }
  }

  const api = await pwRequest.newContext()
  try {
    // 1. Servers up?
    const fe = await api.get(BASE_URL).catch(() => null)
    if (!fe || !fe.ok()) {
      throw new Error(`Frontend not reachable at ${BASE_URL}. Start: npm run dev (frontend).`)
    }
    const be = await api.get(`${API_URL}/api/auth/login`).catch(() => null)
    // login is POST-only, so a GET returning 404/405 still proves the server is up.
    if (!be) throw new Error(`Backend not reachable at ${API_URL}. Start: npm run dev (backend).`)

    // 2. Cache a clinician token for cleanup later.
    const clin = await apiLogin(api, CREDS.clinician.email, CREDS.clinician.password)
    shared.clinicianToken = clin.token

    // 3. Ensure the dev scribe is assigned to the dev clinician (admin-only).
    //    The seed doesn't create assignments, but the scribe can only see a
    //    clinician's visits when one exists. Tolerant of "already assigned".
    try {
      const admin = await apiLogin(api, CREDS.admin.email, CREDS.admin.password)
      const usersRes = await api.get(`${API_URL}/api/users`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      })
      if (usersRes.ok()) {
        const body = await usersRes.json()
        const users = Array.isArray(body) ? body : body.users || []
        const clinUser = users.find((u) => u.email === CREDS.clinician.email)
        const scribeUser = users.find((u) => u.email === CREDS.scribe.email)
        if (clinUser && scribeUser) {
          const assignRes = await api.post(`${API_URL}/api/assignments`, {
            headers: { Authorization: `Bearer ${admin.token}` },
            data: { clinician_id: clinUser.id, scribe_id: scribeUser.id },
          })
          if (!assignRes.ok() && assignRes.status() !== 409) {
            // Most likely a unique-constraint hit from a prior run — fine, the
            // assignment already exists and new visits inherit the scribe.
            console.warn(`[setup] assignment create returned ${assignRes.status()} (continuing).`)
          }
        }
      }
    } catch (e) {
      console.warn('[setup] could not ensure scribe assignment:', e.message)
    }
  } finally {
    await api.dispose()
  }

  // 4. Long-lived clinician browser session (used by Tests 1, 2 and 4), with
  //    mocked audio + mic permission granted.
  shared.clinicianContext = await browser.newContext({ permissions: ['microphone'] })
  await installAudioMocks(shared.clinicianContext)
  shared.clinicianPage = await shared.clinicianContext.newPage()
})

test.afterAll(async () => {
  // Best-effort cleanup: there is no delete-patient endpoint, so we delete the
  // visit (which the clinician owns). Tolerant of FK constraints once graded.
  if (shared.visitId && shared.clinicianToken) {
    const api = await pwRequest.newContext()
    try {
      const res = await api.delete(`${API_URL}/api/visits/${shared.visitId}`, {
        headers: { Authorization: `Bearer ${shared.clinicianToken}` },
      })
      if (!res.ok()) console.warn(`[cleanup] visit delete returned ${res.status()}.`)
    } catch (e) {
      console.warn('[cleanup] visit delete failed:', e.message)
    } finally {
      await api.dispose()
    }
  }
  await shared.clinicianContext?.close()
})

// The workflow is sequential by nature — run in order, stop on first hard break.
test.describe.configure({ mode: 'serial' })

test.describe('Anot Health — full workflow', () => {
  // ── Test 1: Clinician login & schedule the E2E patient ────────────────────
  test('1. Clinician logs in and adds a patient', async () => {
    const page = shared.clinicianPage
    await loginAs(page, 'clinician')
    await expect(page).toHaveURL(/\/clinician/)

    await page.getByRole('button', { name: /\+\s*Add Patient/i }).first().click()

    // "Schedule New Patient" modal — fields are id'd pt-name / pt-mrn / pt-dob / pt-time.
    await expect(page.getByText(/Schedule New Patient/i)).toBeVisible()
    await page.fill('#pt-name', PATIENT_NAME)
    await page.fill('#pt-mrn', PATIENT_MRN)
    await page.fill('#pt-dob', PATIENT_DOB)
    await page.fill('#pt-time', VISIT_TIME)

    const [visitRes] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/visits$/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      page.getByRole('button', { name: /Schedule Patient/i }).click(),
    ])
    expect(visitRes.ok()).toBeTruthy()
    const created = await visitRes.json().catch(() => ({}))
    shared.visitId = created?.visit?.id ?? null

    // Patient now appears on the schedule.
    await expect(page.getByText(PATIENT_NAME).first()).toBeVisible()
  })

  // ── Test 2: Record mock audio for the visit ───────────────────────────────
  test('2. Clinician records mock audio and sends it to the scribe', async () => {
    const page = shared.clinicianPage

    // Scope to the patient's schedule row so we hit the right "Record Encounter".
    const row = page
      .locator('[class*="cl-schedule-row"]')
      .filter({ hasText: PATIENT_NAME })
      .filter({ has: page.getByRole('button', { name: /Record Encounter/i }) })
    await expect(row.first()).toBeVisible()
    await row.first().getByRole('button', { name: /Record Encounter/i }).click()

    // Live recording banner with the red End button.
    const endBtn = page.getByRole('button', { name: /■?\s*End/i })
    await expect(endBtn).toBeVisible()

    await page.waitForTimeout(3000) // record ~3s of mock audio

    // Slow the end/upload response slightly so the "Uploading audio..." indicator
    // is reliably observable instead of flashing past.
    await page.route('**/api/visits/*/end', async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })

    const endResponse = page.waitForResponse(
      (r) => /\/api\/visits\/.*\/end/.test(r.url()) && r.request().method() === 'PUT',
      { timeout: 20_000 },
    )
    await endBtn.click()

    await expect(page.getByText(/Uploading audio/i)).toBeVisible({ timeout: 5_000 })
    const res = await endResponse
    expect(res.ok()).toBeTruthy()
    await page.unroute('**/api/visits/*/end')

    // Visit row flips to the "With Scribe" status.
    const updatedRow = page.locator('[class*="cl-schedule-row"]').filter({ hasText: PATIENT_NAME })
    await expect(updatedRow.getByText(/With Scribe/i).first()).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 3: Scribe drafts & submits the note ──────────────────────────────
  test('3. Scribe views the visit, writes the note, and submits it', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await loginAs(page, 'scribe')

      // Scribe nav: provider → date → recordings.
      await page.getByText('Dev Clinician').first().click()
      await page.getByRole('button', { name: /View Recordings/i }).click()

      // Open this patient's recording ("Start Note").
      const recRow = page.locator('.sf-row, [class*="row"]').filter({ hasText: PATIENT_NAME })
      await expect(recRow.first()).toBeVisible({ timeout: 15_000 })
      await recRow.first().getByRole('button', { name: /Start Note|View Note/i }).click()

      // Transcription panel is present; type the mock transcript into it.
      const transcript = page.getByPlaceholder(/Transcript for this recording/i)
      await expect(transcript).toBeVisible({ timeout: 15_000 })
      await transcript.fill(TRANSCRIPT_TEXT)

      // Write the final clinical note.
      await page.getByPlaceholder(/Write the final clinical note/i).fill(FINAL_NOTE)

      // Save draft.
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/notes\/draft/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 20_000 },
        ),
        page.getByRole('button', { name: /Save Draft/i }).click(),
      ])

      // Submit to clinician ("Upload to EMR" saves + submits the note).
      const submit = page.waitForResponse(
        (r) => /\/api\/notes\/.*\/submit/.test(r.url()) && r.request().method() === 'PUT',
        { timeout: 20_000 },
      )
      await page.getByRole('button', { name: /Upload to EMR/i }).click()
      expect((await submit).ok()).toBeTruthy()

      await expect(page.getByText(/Note submitted to clinician/i)).toBeVisible({
        timeout: 15_000,
      })
    } finally {
      await context.close()
    }
  })

  // ── Test 4: QPS grades the note ───────────────────────────────────────────
  // NOTE on ordering: the backend overloads notes.status = 'uploaded' for BOTH
  // "QPS graded" and "clinician locked", and the QPS portal treats an 'uploaded'
  // note as already-graded (grading is disabled). So QPS must grade the note
  // while it is still 'submitted' — i.e. BEFORE the clinician locks it (Test 5).
  test('4. QPS reviews and grades the note', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await loginAs(page, 'qps')

      // QPS flow: clicking a provider card jumps straight to that clinician's
      // review queue — there's no separate "View Recordings" step like the scribe.
      await page
        .locator('.sf-provider-card')
        .filter({ hasText: 'Dev Clinician' })
        .first()
        .click()

      // Open this patient's pending note for grading ("Review Note" on the row).
      const noteRow = page.locator('.qps-note-card, .sf-row').filter({ hasText: PATIENT_NAME })
      await expect(noteRow.first()).toBeVisible({ timeout: 15_000 })
      await noteRow.first().getByRole('button', { name: /Review Note/i }).click()

      // Rubric uses four 0–100 sliders (Accuracy, Completeness, Terminology,
      // Formatting). Encode "5/5 excellent" as a max score on each.
      const sliders = page.locator('input[type="range"]')
      await expect(sliders.first()).toBeVisible({ timeout: 15_000 })
      const count = await sliders.count()
      for (let i = 0; i < count; i++) {
        await sliders.nth(i).fill('100')
      }

      // Required comment.
      await page.getByPlaceholder(/Write feedback or comments/i).fill('Excellent note')

      // Submit grade.
      const grade = page.waitForResponse(
        (r) => /\/api\/notes\/grade/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      )
      await page.getByRole('button', { name: /Submit Grade/i }).click()
      expect((await grade).ok()).toBeTruthy()

      // Success toast confirms the grade was saved.
      await expect(page.getByText(/Grade submitted successfully/i)).toBeVisible({ timeout: 15_000 })
    } finally {
      await context.close()
    }
  })

  // ── Test 5: Clinician reviews & locks the note ────────────────────────────
  test('5. Clinician reviews and locks the note', async () => {
    const page = shared.clinicianPage

    // Open the Notes tab and reload so the freshly-graded note shows up.
    // The sidebar nav item is a div.sf-nav-item whose text is "📝Notes" (icon +
    // label + optional badge), so we target its exact "Notes" text span.
    await page.reload()
    await page
      .locator('.sf-nav-item')
      .filter({ has: page.getByText('Notes', { exact: true }) })
      .first()
      .click()

    // Open the patient's note for review (notes render as .cl-pending-card cards).
    const card = page.locator('.cl-pending-card, .sf-row').filter({ hasText: PATIENT_NAME })
    await expect(card.first()).toBeVisible({ timeout: 15_000 })
    const reviewBtn = card.first().getByRole('button', { name: /Review/i })
    if (await reviewBtn.count()) {
      await reviewBtn.first().click()
    } else {
      await card.first().click()
    }

    // Note content is shown.
    await expect(page.getByText(/Tension headache/i).first()).toBeVisible({ timeout: 15_000 })

    // Lock it (confirmation modal → confirm). The note is gradeable/uploaded but
    // not yet locked (locked_at is null), so the Lock Note action is available.
    await page.getByRole('button', { name: /Lock Note/i }).click()
    await expect(page.getByText(/Lock this note\?/i)).toBeVisible()
    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/visits\/.*\/lock-note/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      // Confirm button inside the modal (not the trigger we already clicked).
      page.locator('.cl-lock-confirm-modal').getByRole('button', { name: /Lock/i }).click(),
    ])

    // Locked: padlock indicator shows and the editable "Lock Note" action is gone.
    await expect(page.getByText(/Note locked|🔒/).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /Lock Note/i })).toHaveCount(0)
  })

  // ── Test 6: Cleanup ───────────────────────────────────────────────────────
  test('6. Cleanup removes the E2E visit', async () => {
    // No delete-patient endpoint exists; remove the visit the clinician created.
    // (Once a note is graded, FK constraints may block this — treated as soft.)
    test.skip(!shared.visitId || !shared.clinicianToken, 'No visit id / token captured to clean up.')

    const api = await pwRequest.newContext()
    try {
      const del = await api.delete(`${API_URL}/api/visits/${shared.visitId}`, {
        headers: { Authorization: `Bearer ${shared.clinicianToken}` },
      })
      // 200 = deleted; 4xx is acceptable if the graded note's FK blocks deletion.
      console.log(`[cleanup] DELETE /api/visits/${shared.visitId} -> ${del.status()}`)

      if (del.ok()) {
        // Verify it's gone from the clinician's visit list.
        const list = await api.get(`${API_URL}/api/visits`, {
          headers: { Authorization: `Bearer ${shared.clinicianToken}` },
        })
        if (list.ok()) {
          const body = await list.json()
          const visits = Array.isArray(body) ? body : body.visits || []
          expect(visits.some((v) => String(v.id) === String(shared.visitId))).toBeFalsy()
          shared.visitId = null // already cleaned; skip afterAll re-delete
        }
      }
    } finally {
      await api.dispose()
    }
  })
})
