// @ts-check
/**
 * Anot Health — Clinician Daily Workflow (end-to-end).
 *
 * Exercises everything a clinician does in a normal day, driven entirely
 * through the real Clinician portal UI (src/pages/Clinician/index.jsx):
 *
 *   1. Dashboard loads (Today's Visits, stat cards, date nav, + Add Patient)
 *   2. Schedule a new patient + visit
 *   3. Record mock audio for that visit and send it to the scribe
 *   4. Browse the schedule by date (tomorrow ↔ today)
 *   5. Review notes (open a ready note if one exists)
 *   6. Edit an unlocked note (if one exists)
 *   7. Contact support
 *   8. Open the account menu / profile (without signing out)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PREREQUISITES (checked in beforeAll, fails fast if missing):
 *   1. Frontend dev server at  E2E_BASE_URL  (default http://localhost:5173)
 *        npm run dev:frontend
 *   2. Backend API at          E2E_API_URL   (default http://127.0.0.1:5000)
 *        npm run dev:backend
 *   3. Dev users seeded (clinician@dev.anot.local, …):
 *        npm run seed:dev
 *   4. Credentials present in  playwright/.env  (git-ignored).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THE SPEC MAPS TO THE REAL DOM (a few labels differ from the brief):
 *   • "+ Add Patient" opens the inline "Schedule New Patient" form whose fields
 *     are id'd  #pt-name / #pt-mrn / #pt-dob / #pt-time  and is saved with the
 *     "Schedule Patient" button — it creates the patient AND the visit together.
 *   • Start recording = the green "Record Encounter" button on an upcoming visit
 *     row (.cl-schedule-row); the live banner (.sf-rec-banner) shows
 *     "Recording live…" and stops via the red "■ End" button. Upload shows the
 *     "⏳ Uploading audio…" banner, then the row flips to the "With Scribe" badge.
 *   • Sidebar nav items (.sf-nav-item) are Schedule / Notes / Contact Us.
 *   • The note review screen exposes "✏️ Edit Note", "🔒 Lock Note" and
 *     "↩️ Request Edit from Scribe"; saving an edit shows the toast
 *     "Note updated successfully".
 *   • Contact Us (ContactScreen) fields are #cl-contact-name / #cl-contact-subject
 *     / #cl-contact-message; success text: "Your message has been sent…".
 *   • The profile/account menu is the topbar avatar (.sf-account-menu__trigger);
 *     its panel shows the account head + a "Sign Out" item.
 *
 * Tests 5 & 6 depend on a scribe having drafted a note, which this clinician-only
 * run does not create — so they degrade gracefully (skip) when no reviewable /
 * editable note exists, instead of failing.
 *
 * Runs SERIALLY against one logged-in clinician session: Setup logs in once,
 * each test re-navigates to the screen it needs (so it doesn't rely on the
 * previous test's view), and Teardown cleans up the created visit + signs out.
 */

const { test, expect, request: pwRequest } = require('@playwright/test')
const { settleBetweenSpecFiles } = require('./support/settle')

// Pause ~2s before this suite's setup so back-to-back suites don't overload the
// dev backend (a source of ECONNRESET). See tests/e2e/support/settle.js.
settleBetweenSpecFiles()

// ── Config / credentials (from playwright/.env via playwright.config.js) ──────
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')

const CLINICIAN = {
  email: process.env.CLINICIAN_EMAIL,
  password: process.env.CLINICIAN_PASSWORD,
}
// Used only by the beforeAll seeding so Test 6 always has an editable note.
const SCRIBE = { email: process.env.SCRIBE_EMAIL, password: process.env.SCRIBE_PASSWORD }
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }

// Unique-per-run identity so reruns never collide on the schedule and the
// row/card selectors stay unambiguous.
const RUN_ID = Date.now().toString().slice(-6)
const PATIENT_NAME = `Workflow Test Patient ${RUN_ID}`
const PATIENT_MRN = `WF${RUN_ID}`
const PATIENT_DOB = '1985-03-20'
const VISIT_TIME = '10:00' // 10:00 AM today

// Dedicated, isolated patient/visit/note seeded via API for the "edit a note"
// test, kept separate from the UI-created patient above so it never collides
// with the recording flow in Test 3.
const SEED_PATIENT_NAME = `Seed Note Patient ${RUN_ID}`
const SEED_PATIENT_MRN = `SEED${RUN_ID}`
const SEED_NOTE_TEXT = [
  'SUBJECTIVE: Patient seeded for clinician edit-note E2E coverage.',
  'OBJECTIVE: Vitals stable.',
  'ASSESSMENT: Routine follow-up.',
  'PLAN: Continue current management.',
].join('\n')

// State shared across the serial tests.
const shared = {
  context: /** @type {import('@playwright/test').BrowserContext|null} */ (null),
  page: /** @type {import('@playwright/test').Page|null} */ (null),
  token: /** @type {string|null} */ (null),
  clinicianId: /** @type {string|number|null} */ (null),
  visitId: /** @type {string|number|null} */ (null),
  // Seeded (submitted, unlocked) note for Test 6.
  seedVisitId: /** @type {string|number|null} */ (null),
  seedNoteId: /** @type {string|number|null} */ (null),
  seedPatientName: /** @type {string|null} */ (null),
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

/**
 * Inject fake getUserMedia + MediaRecorder BEFORE any page script runs so the
 * recording flow works headlessly without a real microphone. addInitScript (not
 * page.evaluate) is required: the app reads these APIs at record time.
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

/** UI login as the clinician — resolves once routed to /clinician. */
async function loginAsClinician(page) {
  await page.goto('/login')
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.fill('#login-email', CLINICIAN.email)
  await page.fill('#login-password', CLINICIAN.password)
  await Promise.all([
    page.waitForURL(/\/clinician(\b|\/|$)/, { timeout: 20_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ])
}

/**
 * Click a sidebar nav item (Schedule / Notes / Contact Us). At desktop width the
 * sidebar is always on-screen, so a direct click is enough. We scope to the exact
 * label text to avoid matching badges/icons in the same item.
 */
async function gotoScreen(page, label) {
  await page
    .locator('.sf-nav-item')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .click()
}

/** Re-enter the Schedule screen on today and wait for the dashboard to render. */
async function gotoTodaySchedule(page) {
  await gotoScreen(page, 'Schedule')
  await expect(page.locator('.cl-stat-cards')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/TODAY'S VISITS/i)).toBeVisible({ timeout: 15_000 })
}

/** The schedule row for our test patient. */
function patientRow(page) {
  return page.locator('.cl-schedule-row').filter({ hasText: PATIENT_NAME })
}

/** Authorization header for a bearer token. */
const auth = (token) => ({ Authorization: `Bearer ${token}` })

/**
 * Seed a submitted, unlocked note so Test 6 (Edit a note) always has something
 * editable to work with, independent of any pre-existing data:
 *   1. Log in as the scribe (and admin) via API.
 *   2. Ensure the scribe is assigned to the clinician (so the scribe is
 *      authorized to draft on the clinician's visits, and new visits inherit it).
 *   3. Create a dedicated seed patient + visit owned by the clinician.
 *   4. Save a draft note (scribe) then submit it (scribe) → status 'submitted',
 *      not locked → the clinician's review screen shows the "Edit Note" action.
 * Stores ids on `shared` for Test 6 + teardown. Best-effort: on failure it warns
 * and leaves shared.seedNoteId null (Test 6 then falls back / skips).
 */
async function seedSubmittedNote(api, clinicianId) {
  if (!SCRIBE.email || !SCRIBE.password) {
    console.warn('[seed] missing scribe credentials — skipping note seed.')
    return
  }

  const scribe = await apiLogin(api, SCRIBE.email, SCRIBE.password)

  // Ensure scribe⇄clinician assignment (admin-only). Tolerant of "already
  // assigned" (409) and of admin being unavailable.
  if (ADMIN.email && ADMIN.password) {
    try {
      const admin = await apiLogin(api, ADMIN.email, ADMIN.password)
      const assignRes = await api.post(`${API_URL}/api/assignments`, {
        headers: auth(admin.token),
        data: { clinician_id: clinicianId, scribe_id: scribe.user.id },
      })
      if (!assignRes.ok() && assignRes.status() !== 409) {
        console.warn(`[seed] assignment create returned ${assignRes.status()} (continuing).`)
      }
    } catch (e) {
      console.warn('[seed] could not ensure scribe assignment:', e.message)
    }
  }

  // Create the seed patient (clinician). A 409 means it already exists from a
  // prior run — reuse the returned patient.
  let patientId
  const patientRes = await api.post(`${API_URL}/api/patients`, {
    headers: auth(shared.token),
    data: { name: SEED_PATIENT_NAME, mrn: SEED_PATIENT_MRN, date_of_birth: PATIENT_DOB },
  })
  if (patientRes.ok()) {
    patientId = (await patientRes.json()).patient.id
  } else if (patientRes.status() === 409) {
    patientId = (await patientRes.json()).patient.id
  } else {
    throw new Error(`seed patient create failed: ${patientRes.status()} ${await patientRes.text()}`)
  }

  // Create the seed visit (clinician). Because the assignment now exists, the
  // visit inherits scribe_id, so the scribe is authorized to draft on it.
  const visitRes = await api.post(`${API_URL}/api/visits`, {
    headers: auth(shared.token),
    data: { patient_id: patientId, visit_date: localToday(), visit_time: '08:30', visit_type: 'Follow-up' },
  })
  if (!visitRes.ok()) {
    throw new Error(`seed visit create failed: ${visitRes.status()} ${await visitRes.text()}`)
  }
  shared.seedVisitId = (await visitRes.json()).visit.id

  // Save a draft note (scribe).
  const draftRes = await api.post(`${API_URL}/api/notes/draft`, {
    headers: auth(scribe.token),
    data: {
      visit_id: shared.seedVisitId,
      transcription: 'Seed transcript for the clinician edit-note test.',
      final_note: SEED_NOTE_TEXT,
    },
  })
  if (!draftRes.ok()) {
    throw new Error(`seed draft create failed: ${draftRes.status()} ${await draftRes.text()}`)
  }
  shared.seedNoteId = (await draftRes.json()).note.id

  // Submit the note (scribe) → 'submitted' + visit 'note-ready', unlocked.
  const submitRes = await api.put(`${API_URL}/api/notes/${shared.seedNoteId}/submit`, {
    headers: auth(scribe.token),
  })
  if (!submitRes.ok()) {
    throw new Error(`seed note submit failed: ${submitRes.status()} ${await submitRes.text()}`)
  }

  shared.seedPatientName = SEED_PATIENT_NAME
  console.log(`[seed] submitted note ${shared.seedNoteId} on visit ${shared.seedVisitId} for "${SEED_PATIENT_NAME}".`)
}

/** Today's date as YYYY-MM-DD in local time (matches what the portal sends). */
function localToday() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── Global setup ──────────────────────────────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  if (!CLINICIAN.email || !CLINICIAN.password) {
    throw new Error(
      'Missing clinician credentials. Create playwright/.env with CLINICIAN_EMAIL / CLINICIAN_PASSWORD.',
    )
  }

  // Health checks + cache a token for cleanup.
  const api = await pwRequest.newContext()
  try {
    const fe = await api.get(BASE_URL).catch(() => null)
    if (!fe || !fe.ok()) {
      throw new Error(`Frontend not reachable at ${BASE_URL}. Start it with: npm run dev:frontend`)
    }
    const be = await api.get(`${API_URL}/api/auth/login`).catch(() => null)
    if (!be) throw new Error(`Backend not reachable at ${API_URL}. Start it with: npm run dev:backend`)

    const clin = await apiLogin(api, CLINICIAN.email, CLINICIAN.password)
    shared.token = clin.token
    shared.clinicianId = clin.user?.id ?? null

    // Seed a submitted/unlocked note so Test 6 always has an editable note.
    // Best-effort: don't fail the whole suite if seeding hits an issue.
    try {
      await seedSubmittedNote(api, shared.clinicianId)
    } catch (e) {
      console.warn('[seed] could not seed an editable note:', e.message)
    }
  } finally {
    await api.dispose()
  }

  // One long-lived clinician session with mocked audio + mic permission.
  shared.context = await browser.newContext({ permissions: ['microphone'] })
  await installAudioMocks(shared.context)
  shared.page = await shared.context.newPage()

  // ── Setup: login + verify the clinician portal loads ──
  await loginAsClinician(shared.page)
  await expect(shared.page).toHaveURL(/\/clinician/)
  await expect(shared.page.locator('.cl-clinician-shell, .cl-portal')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  // ── Teardown: remove the test + seeded visits via API (no delete-patient
  // endpoint), then sign out. Deleting a visit also deletes its note, so this
  // cleans up the seeded note too. ──
  if (shared.token) {
    const api = await pwRequest.newContext()
    try {
      for (const id of [shared.visitId, shared.seedVisitId]) {
        if (!id) continue
        const res = await api.delete(`${API_URL}/api/visits/${id}`, {
          headers: auth(shared.token),
        })
        if (!res.ok()) console.warn(`[cleanup] DELETE /api/visits/${id} -> ${res.status()}`)
      }
    } catch (e) {
      console.warn('[cleanup] visit delete failed:', e.message)
    } finally {
      await api.dispose()
    }
  }

  // Best-effort UI sign out so the session doesn't linger.
  const page = shared.page
  if (page && !page.isClosed()) {
    try {
      await page.locator('.sf-account-menu__trigger').first().click()
      const signOut = page.getByRole('menuitem', { name: /sign out|log out/i })
      if (await signOut.count()) {
        await signOut.first().click()
        await page.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => {})
      }
    } catch {
      /* ignore — teardown is best-effort */
    }
  }

  await shared.context?.close()
})

// The daily workflow is sequential (Test 3 records the patient Test 2 created),
// so we run in declaration order on a single shared session.
test.describe.configure({ mode: 'serial' })

test.describe('Clinician Daily Workflow', () => {
  // ── Test 1: Dashboard loads correctly ──────────────────────────────────────
  test('1. Dashboard loads correctly', async () => {
    const page = shared.page
    await gotoTodaySchedule(page)

    // "Today's Visits" section.
    await expect(page.getByText(/TODAY'S VISITS/i)).toBeVisible()

    // Four stat cards with their labels.
    const stats = page.locator('.cl-stat-cards')
    for (const label of ['Total Visits', 'With Scribe', 'Ready for Review', 'Completed']) {
      await expect(stats.locator('.cl-stat-card').filter({ hasText: label })).toBeVisible()
    }
    await expect(stats.locator('.cl-stat-card')).toHaveCount(4)

    // Date navigation: forward then back, confirming the section heading tracks the day.
    await page.getByRole('button', { name: /Next day/i }).click()
    await expect(page.getByText(/VISITS FOR/i)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /Previous day/i }).click()
    await expect(page.getByText(/TODAY'S VISITS/i)).toBeVisible({ timeout: 10_000 })

    // "+ Add Patient" is available.
    await expect(page.getByRole('button', { name: /\+\s*Add Patient/i }).first()).toBeVisible()
  })

  // ── Test 2: Add a new patient ───────────────────────────────────────────────
  test('2. Add a new patient', async () => {
    const page = shared.page
    await gotoTodaySchedule(page)

    await page.getByRole('button', { name: /\+\s*Add Patient/i }).first().click()

    // "Schedule New Patient" form (creates patient + visit together).
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
      page.getByRole('button', { name: /^Schedule Patient$/i }).click(),
    ])
    expect(visitRes.ok()).toBeTruthy()
    const created = await visitRes.json().catch(() => ({}))
    shared.visitId = created?.visit?.id ?? null

    // Patient appears in the schedule.
    await expect(patientRow(page).first()).toBeVisible({ timeout: 15_000 })
    await expect(patientRow(page).first()).toContainText(PATIENT_MRN)
  })

  // ── Test 3: Record audio for a visit ────────────────────────────────────────
  test('3. Record audio for a visit', async () => {
    const page = shared.page
    await gotoTodaySchedule(page)

    // Find our patient's upcoming row and start recording.
    const row = patientRow(page)
      .filter({ has: page.getByRole('button', { name: /Record Encounter/i }) })
    await expect(row.first()).toBeVisible({ timeout: 15_000 })
    await row.first().getByRole('button', { name: /Record Encounter/i }).click()

    // Live recording banner with the red End button + a "Recording…" indicator.
    const recBanner = page.locator('.sf-rec-banner')
    await expect(recBanner).toBeVisible({ timeout: 10_000 })
    await expect(recBanner.getByText(/Recording/i)).toBeVisible()
    const endBtn = recBanner.getByRole('button', { name: /End/i })
    await expect(endBtn).toBeVisible()

    // Record ~5s of mock audio.
    await page.waitForTimeout(5000)

    // Slow the end/upload response a touch so the "Uploading audio…" banner is
    // reliably observable instead of flashing past.
    await page.route('**/api/visits/*/end', async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })

    const endResponse = page.waitForResponse(
      (r) => /\/api\/visits\/.*\/end/.test(r.url()) && r.request().method() === 'PUT',
      { timeout: 20_000 },
    )
    await endBtn.click()

    // "Uploading audio…" indicator.
    await expect(page.getByText(/Uploading audio/i)).toBeVisible({ timeout: 5_000 })
    expect((await endResponse).ok()).toBeTruthy()
    await page.unroute('**/api/visits/*/end')

    // Status changes — the row flips to the "With Scribe" badge.
    await expect(patientRow(page).getByText(/With Scribe/i).first()).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 4: View patient schedule by date ───────────────────────────────────
  test('4. View patient schedule by date', async () => {
    const page = shared.page
    await gotoTodaySchedule(page)

    // Navigate to tomorrow.
    await page.getByRole('button', { name: /Next day/i }).click()
    await expect(page.getByText(/VISITS FOR/i)).toBeVisible({ timeout: 10_000 })

    // Tomorrow's schedule is either empty or shows its own visits — but NOT
    // today's test patient (the visit was scheduled for today).
    await expect(patientRow(page)).toHaveCount(0)

    // Navigate back to today via the "Go to today" shortcut.
    await page.getByRole('button', { name: /Go to today/i }).click()
    await expect(page.getByText(/TODAY'S VISITS/i)).toBeVisible({ timeout: 10_000 })

    // Today's visit (our patient) still shows.
    await expect(patientRow(page).first()).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 5: Review notes ────────────────────────────────────────────────────
  test('5. Review notes', async () => {
    const page = shared.page
    await gotoScreen(page, 'Notes')

    // Notes list loads (filter tabs render even when empty).
    await expect(page.locator('.cl-notes-tabs')).toBeVisible({ timeout: 15_000 })

    // Wait for the loading state to settle.
    await expect(page.getByText(/^Loading…$/)).toHaveCount(0, { timeout: 15_000 })

    // Open a reviewable note if one exists; otherwise this clinician-only run has
    // nothing ready to review (a scribe must draft + submit first), so skip.
    const reviewBtn = page.locator('.cl-notes-btn-open', { hasText: /Review/i })
    if ((await reviewBtn.count()) === 0) {
      test.skip(true, 'No notes ready for review (requires a scribe-submitted note).')
      return
    }

    await reviewBtn.first().click()

    // Note content displays in the detail view.
    await expect(page.locator('.cl-note-detail-back')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sf-note-card')).toBeVisible()

    // If the note is unlocked, its action buttons are present.
    const editBtn = page.getByRole('button', { name: /Edit Note/i })
    if (await editBtn.count()) {
      await expect(editBtn).toBeVisible()
      await expect(page.getByRole('button', { name: /Lock Note/i })).toBeVisible()
      await expect(page.getByRole('button', { name: /Request Edit/i })).toBeVisible()
    }

    // Return to the list so the test leaves the UI in a clean state.
    await page.locator('.cl-note-detail-back').click()
  })

  // ── Test 6: Edit a note ─────────────────────────────────────────────────────
  // Uses the submitted/unlocked note seeded in beforeAll so this always runs.
  test('6. Edit a note', async () => {
    const page = shared.page
    expect(
      shared.seedNoteId,
      'beforeAll did not seed an editable note — check scribe/admin credentials and the seed logs.',
    ).toBeTruthy()

    await gotoScreen(page, 'Notes')
    await expect(page.locator('.cl-notes-tabs')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/^Loading…$/)).toHaveCount(0, { timeout: 15_000 })

    // Narrow the list to the seeded patient, then open that specific note.
    await page.getByPlaceholder(/Search by name or MRN/i).fill(shared.seedPatientName)
    const seedCard = page.locator('.cl-pending-card').filter({ hasText: shared.seedPatientName })
    await expect(seedCard.first()).toBeVisible({ timeout: 15_000 })
    await seedCard.first().getByRole('button', { name: /^Review$/i }).click()

    // Detail view for the seeded note, with the editable action present.
    await expect(page.locator('.cl-note-detail-back')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sf-note-pre')).toContainText('SUBJECTIVE')

    const editBtn = page.getByRole('button', { name: /Edit Note/i })
    await expect(editBtn).toBeVisible({ timeout: 10_000 })

    // Enter edit mode, modify the content, and save.
    await editBtn.click()
    const editor = page.locator('textarea.sf-textarea')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    const original = await editor.inputValue()
    const appended = `${original}\n\n[E2E edit ${RUN_ID}] Reviewed and amended by clinician.`
    await editor.fill(appended)

    const [updateRes] = await Promise.all([
      page
        .waitForResponse(
          (r) => /\/api\/notes\//.test(r.url()) && r.request().method() === 'PUT',
          { timeout: 20_000 },
        )
        .catch(() => null),
      page.getByRole('button', { name: /Save Changes/i }).click(),
    ])
    if (updateRes) expect(updateRes.ok()).toBeTruthy()

    // Success toast + the edited content persists in the rendered note.
    await expect(page.getByText(/Note updated successfully/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sf-note-pre')).toContainText(`[E2E edit ${RUN_ID}]`)

    await page.locator('.cl-note-detail-back').click()
  })

  // ── Test 7: Contact support ─────────────────────────────────────────────────
  test('7. Contact support', async () => {
    const page = shared.page
    await gotoScreen(page, 'Contact Us')

    // Contact form loads.
    await expect(page.locator('#cl-contact-message')).toBeVisible({ timeout: 15_000 })

    // Fill in a test message and submit.
    await page.fill('#cl-contact-name', `Workflow Tester ${RUN_ID}`)
    await page.selectOption('#cl-contact-subject', { label: 'Technical Issue' })
    await page.fill(
      '#cl-contact-message',
      `Automated clinician-workflow E2E message (${RUN_ID}). Please ignore.`,
    )
    await page.getByRole('button', { name: /^Send$/i }).click()

    // Success confirmation.
    await expect(page.getByText(/Your message has been sent/i)).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 8: Profile and account ─────────────────────────────────────────────
  test('8. Profile and account', async () => {
    const page = shared.page
    await gotoTodaySchedule(page)

    // Open the topbar account menu (profile avatar/button).
    await page.locator('.sf-account-menu__trigger').first().click()

    // Account info shows in the dropdown panel.
    const panel = page.locator('.sf-account-menu__panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel.locator('.sf-account-menu__head-name')).toBeVisible()

    // "Sign out" is visible — but do NOT click it.
    await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeVisible()

    // Close the menu without signing out.
    await page.keyboard.press('Escape')
  })
})
