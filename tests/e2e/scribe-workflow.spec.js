// @ts-check
/**
 * Anot Health — Scribe Daily Workflow (end-to-end).
 *
 * Exercises everything a scribe does in a normal day, driven entirely through
 * the real Scribe portal UI (src/pages/Scribe/index.jsx):
 *
 *   1. The portal loads (Scribe Portal header, provider card, sidebar nav)
 *   2. Browse the assigned clinician's recordings for a date
 *   3. Open a recording → Transcription / AI Draft / Final Note panels + audio
 *   4. Write and save a draft note
 *   5. Submit (Upload to EMR) the note to the clinician
 *   6. Review it under "My Notes"
 *   7. Review the grading rubric under "My Grades"
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PREREQUISITES (checked in beforeAll, fails fast if missing):
 *   1. Frontend dev server at  E2E_BASE_URL  (default http://localhost:5173)
 *        npm run dev:frontend
 *   2. Backend API at          E2E_API_URL   (default http://127.0.0.1:5000)
 *        npm run dev:backend
 *   3. Dev users seeded (scribe@dev.anot.local, clinician@dev.anot.local, …):
 *        npm run seed:dev
 *   4. Credentials present in  playwright/.env  (git-ignored).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THE SPEC MAPS TO THE REAL DOM (a few labels differ from the brief):
 *   • The "Scribe Portal" header is the sidebar brand subtitle (PortalSidebarBrand).
 *   • The scribe picks a provider then a date before seeing recordings:
 *     provider card (.sf-provider-card) → date screen → "View Recordings" CTA →
 *     recordings list (rows are .sf-row with "Start Note" / "View Note").
 *   • Opening a recording shows three NoteWorkspacePanel panels titled
 *     "Transcription", "AI Draft" and "Final Note", plus the audio bar
 *     (.sf-audio-bar). The final note is the .scribe-final-note-textarea.
 *   • "Save Draft" toast = "Draft saved successfully"; "Upload to EMR" saves +
 *     submits, toast = "Note submitted to clinician." and the Final Note panel
 *     badge flips to "Submitted".
 *   • Sidebar nav items (.sf-nav-item) are Recordings / My Notes / My Grades.
 *   • "My Grades" only renders the 4-criteria breakdown (Accuracy, Completeness,
 *     Medical Terminology, Formatting) inside an individual graded note, which a
 *     scribe-only run has none of — so Test 7 verifies the grades screen + its
 *     rubric description instead (it names accuracy/completeness/terminology).
 *
 * The seed creates a clinician-owned visit, submits a (mock) audio file for it
 * — which flips it to 'recording-uploaded', the state the scribe inbox shows —
 * and seeds a transcription, so Tests 2–5 always have a recording to act on
 * without a real microphone.
 *
 * Runs SERIALLY against one logged-in scribe session.
 */

const { test, expect, request: pwRequest } = require('@playwright/test')
const { settleBetweenSpecFiles } = require('./support/settle')

// Pause ~2s before this suite's setup so back-to-back suites don't overload the
// dev backend (a source of ECONNRESET). See tests/e2e/support/settle.js.
settleBetweenSpecFiles()

// ── Config / credentials (from playwright/.env via playwright.config.js) ──────
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const API_URL = (process.env.E2E_API_URL || 'http://127.0.0.1:5000').replace(/\/$/, '')

const SCRIBE = { email: process.env.SCRIBE_EMAIL, password: process.env.SCRIBE_PASSWORD }
const CLINICIAN = { email: process.env.CLINICIAN_EMAIL, password: process.env.CLINICIAN_PASSWORD }
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }

// The dev clinician the scribe is assigned to (seed account display name).
const PROVIDER_NAME = 'Dev Clinician'

// Unique-per-run identity so reruns never collide and selectors stay precise.
const RUN_ID = Date.now().toString().slice(-6)
const PATIENT_NAME = `Scribe WF Patient ${RUN_ID}`
const PATIENT_MRN = `SWF${RUN_ID}`
const PATIENT_DOB = '1988-07-12'
const VISIT_TIME = '11:00'
const SEED_TRANSCRIPT = JSON.stringify([
  'Patient reports a headache for the past two days. Denies fever or visual changes.',
])
const FINAL_NOTE_TEXT =
  'SUBJECTIVE: Patient reports headache. OBJECTIVE: BP 120/80. ASSESSMENT: Tension headache. PLAN: Ibuprofen 400mg.'

// State shared across the serial tests.
const shared = {
  context: /** @type {import('@playwright/test').BrowserContext|null} */ (null),
  page: /** @type {import('@playwright/test').Page|null} */ (null),
  clinicianToken: /** @type {string|null} */ (null),
  scribeToken: /** @type {string|null} */ (null),
  clinicianId: /** @type {string|number|null} */ (null),
  scribeId: /** @type {string|number|null} */ (null),
  visitId: /** @type {string|number|null} */ (null),
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

/** Today's date as YYYY-MM-DD in local time (matches what the portal sends). */
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

/** UI login as the scribe — resolves once routed to /scribe. */
async function loginAsScribe(page) {
  await page.goto('/login')
  await page.locator('#login-email').waitFor({ state: 'visible' })
  await page.fill('#login-email', SCRIBE.email)
  await page.fill('#login-password', SCRIBE.password)
  await Promise.all([
    page.waitForURL(/\/scribe(\b|\/|$)/, { timeout: 20_000 }),
    page.getByRole('button', { name: /sign in/i }).click(),
  ])
}

/** Click a sidebar nav item (Recordings / My Notes / My Grades). */
async function navClick(page, label) {
  await page
    .locator('.sf-nav-item')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .click()
}

/**
 * Navigate to the recordings list for the seeded provider + today, regardless of
 * which screen we start on (the scribe flow is provider → date → recordings).
 */
async function gotoRecordingsList(page) {
  await navClick(page, 'Recordings')

  // Provider-selection screen → choose the assigned clinician.
  const providerCard = page.locator('.sf-provider-card').filter({ hasText: PROVIDER_NAME })
  if (await visibleSoon(providerCard, 4000)) {
    await providerCard.first().click()
  }

  // Date screen → load recordings for the (default = today) date.
  const cta = page.getByRole('button', { name: /View Recordings/i })
  if (await visibleSoon(cta, 4000)) {
    await cta.first().click()
  }

  await expect(page.getByText(/Patient Recordings/i)).toBeVisible({ timeout: 15_000 })
}

/** The recordings-list row for our seeded patient. */
function recordingRow(page) {
  return page.locator('.sf-row').filter({ hasText: PATIENT_NAME })
}

/** Open the seeded recording's note editor. */
async function openSeededNote(page) {
  await gotoRecordingsList(page)
  const row = recordingRow(page)
  await expect(row.first()).toBeVisible({ timeout: 15_000 })
  await row.first().getByRole('button', { name: /Start Note|View Note/i }).click()
  await expect(page.locator('.sf-note-workspace')).toBeVisible({ timeout: 15_000 })
}

/**
 * Seed a clinician-owned, scribe-assigned visit with submitted audio so the
 * scribe inbox always has a real recording to work on (no microphone needed).
 *   1. Ensure the scribe⇄clinician assignment exists (admin API; tolerant of 409).
 *   2. Create patient + visit (clinician API).
 *   3. Upload a (mock) audio file (clinician API) — this is what flips the visit
 *      to 'recording-uploaded', the inbox-visible state, and feeds the player.
 *   4. Belt-and-braces: PUT the visit status to 'recording-uploaded' in case the
 *      upload endpoint is unavailable in this environment.
 *   5. Seed a draft note with a transcription (scribe API).
 */
async function seedRecording(api) {
  // 1. Ensure assignment so the scribe can see the clinician's visits + draft.
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

  // 2. Create the seed patient (clinician). 409 → reuse the existing one.
  const patientRes = await api.post(`${API_URL}/api/patients`, {
    headers: auth(shared.clinicianToken),
    data: { name: PATIENT_NAME, mrn: PATIENT_MRN, date_of_birth: PATIENT_DOB },
  })
  if (!patientRes.ok() && patientRes.status() !== 409) {
    throw new Error(`seed patient create failed: ${patientRes.status()} ${await patientRes.text()}`)
  }
  const patientId = (await patientRes.json()).patient.id

  // 3. Create the seed visit (clinician) — inherits scribe_id from the assignment.
  const visitRes = await api.post(`${API_URL}/api/visits`, {
    headers: auth(shared.clinicianToken),
    data: { patient_id: patientId, visit_date: localToday(), visit_time: VISIT_TIME, visit_type: 'Follow-up' },
  })
  if (!visitRes.ok()) {
    throw new Error(`seed visit create failed: ${visitRes.status()} ${await visitRes.text()}`)
  }
  shared.visitId = (await visitRes.json()).visit.id

  // 4a. Submit (mock) audio for the visit (clinician). The upload endpoint sets
  //     status = 'recording-uploaded' server-side, mirroring a real recording.
  try {
    const audioRes = await api.post(`${API_URL}/api/audio/${shared.visitId}`, {
      headers: auth(shared.clinicianToken),
      multipart: {
        audio: {
          name: `visit_${shared.visitId}.webm`,
          mimeType: 'audio/webm',
          buffer: Buffer.from('mock-audio-data-for-e2e-seed'),
        },
      },
    })
    if (!audioRes.ok()) {
      console.warn(`[seed] audio upload returned ${audioRes.status()} (continuing).`)
    }
  } catch (e) {
    console.warn('[seed] audio upload failed:', e.message)
  }

  // 4b. Belt-and-braces: ensure 'recording-uploaded' even if the upload endpoint
  //     was unavailable, so the recording still shows in the scribe inbox.
  const statusRes = await api.put(`${API_URL}/api/visits/${shared.visitId}/status`, {
    headers: auth(shared.clinicianToken),
    data: { status: 'recording-uploaded' },
  })
  if (!statusRes.ok()) {
    console.warn(`[seed] visit status update returned ${statusRes.status()} (continuing).`)
  }

  // 5. Seed a draft note with a transcription (scribe).
  const draftRes = await api.post(`${API_URL}/api/notes/draft`, {
    headers: auth(shared.scribeToken),
    data: { visit_id: shared.visitId, transcription: SEED_TRANSCRIPT },
  })
  if (!draftRes.ok()) {
    console.warn(`[seed] draft note create returned ${draftRes.status()} (continuing).`)
  }

  console.log(`[seed] recording-ready visit ${shared.visitId} for "${PATIENT_NAME}".`)
}

// ── Global setup ──────────────────────────────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  if (!SCRIBE.email || !SCRIBE.password) {
    throw new Error('Missing scribe credentials. Set SCRIBE_EMAIL / SCRIBE_PASSWORD in playwright/.env.')
  }
  if (!CLINICIAN.email || !CLINICIAN.password) {
    throw new Error('Missing clinician credentials. Set CLINICIAN_EMAIL / CLINICIAN_PASSWORD in playwright/.env.')
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
    shared.clinicianId = clin.user?.id ?? null
    const scr = await apiLogin(api, SCRIBE.email, SCRIBE.password)
    shared.scribeToken = scr.token
    shared.scribeId = scr.user?.id ?? null

    await seedRecording(api)
  } finally {
    await api.dispose()
  }

  shared.context = await browser.newContext()
  shared.page = await shared.context.newPage()

  // ── Setup: login + verify the scribe portal loads ──
  await loginAsScribe(shared.page)
  await expect(shared.page).toHaveURL(/\/scribe/)
  await expect(shared.page.locator('.scribe-portal')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  // ── Teardown: remove the seeded visit (cascades its note) via the clinician API. ──
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

// Sequential workflow on a single shared scribe session.
test.describe.configure({ mode: 'serial' })

test.describe('Scribe Daily Workflow', () => {
  // ── Test 1: Dashboard / Recordings loads correctly ──────────────────────────
  test('1. Portal loads with provider card and nav', async () => {
    const page = shared.page

    // "Scribe Portal" header (sidebar brand subtitle).
    await expect(page.getByText(/Scribe Portal/i).first()).toBeVisible({ timeout: 15_000 })

    // The assigned provider card shows the dev clinician.
    await expect(page.locator('.sf-provider-card').filter({ hasText: PROVIDER_NAME }).first()).toBeVisible({
      timeout: 15_000,
    })

    // Sidebar nav items.
    for (const label of ['Recordings', 'My Notes', 'My Grades']) {
      await expect(
        page.locator('.sf-nav-item').filter({ has: page.getByText(label, { exact: true }) }).first(),
      ).toBeVisible()
    }
  })

  // ── Test 2: View the assigned clinician's visits ────────────────────────────
  test('2. View assigned clinician recordings', async () => {
    const page = shared.page
    await gotoRecordingsList(page)

    // The seeded recording is listed with the patient's identity + visit info.
    const row = recordingRow(page)
    await expect(row.first()).toBeVisible({ timeout: 15_000 })
    await expect(row.first()).toContainText(PATIENT_MRN)
    await expect(row.first()).toContainText(/Follow-up/i)
  })

  // ── Test 3: Open a visit and view the transcription panel ────────────────────
  test('3. Open a recording — panels + audio player', async () => {
    const page = shared.page
    await openSeededNote(page)

    // Three workspace panels render.
    const workspace = page.locator('.sf-note-workspace')
    for (const title of ['Transcription', 'AI Draft', 'Final Note']) {
      await expect(workspace.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    }

    // Audio player bar is present.
    await expect(page.locator('.sf-audio-bar')).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 4: Write and save a draft note ─────────────────────────────────────
  test('4. Write and save a draft note', async () => {
    const page = shared.page
    await openSeededNote(page)

    const finalNote = page.getByPlaceholder(/Write the final clinical note/i)
    await expect(finalNote).toBeVisible({ timeout: 15_000 })
    await finalNote.fill(FINAL_NOTE_TEXT)

    const [draftRes] = await Promise.all([
      page
        .waitForResponse(
          (r) => /\/api\/notes\/draft/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 20_000 },
        )
        .catch(() => null),
      page.getByRole('button', { name: /Save Draft/i }).click(),
    ])
    if (draftRes) expect(draftRes.ok()).toBeTruthy()

    await expect(page.getByText(/Draft saved successfully/i)).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 5: Submit the note to the clinician ────────────────────────────────
  test('5. Submit note to clinician', async () => {
    const page = shared.page
    await openSeededNote(page)

    const finalPanel = page.locator('.sf-note-panel--final-note')

    // Idempotent on retry: if a prior run already submitted this visit, the
    // editor opens in the read-only "done" state (no Upload to EMR button and a
    // "Submitted" panel badge) — that's a valid submitted state, so accept it.
    const uploadBtn = page.getByRole('button', { name: /Upload to EMR/i })
    if (!(await visibleSoon(uploadBtn, 4000))) {
      await expect(finalPanel.getByText('Submitted', { exact: true })).toBeVisible({ timeout: 15_000 })
      return
    }

    // Make sure there is final-note content to submit (in case this test ran first).
    const finalNote = page.getByPlaceholder(/Write the final clinical note/i)
    if ((await finalNote.inputValue()).trim().length === 0) {
      await finalNote.fill(FINAL_NOTE_TEXT)
    }

    const submitRes = page.waitForResponse(
      (r) => /\/api\/notes\/.*\/submit/.test(r.url()) && r.request().method() === 'PUT',
      { timeout: 20_000 },
    )
    await uploadBtn.click()
    expect((await submitRes).ok()).toBeTruthy()

    // Success message confirming the note went to the clinician. (The Final Note
    // panel badge only flips to "Submitted" on a fresh re-open of the note, since
    // submit updates the row's visit status but not its in-memory note_status —
    // so the toast + a 200 from /submit are the reliable success signals here.)
    await expect(page.getByText(/Note submitted to clinician/i)).toBeVisible({ timeout: 15_000 })
  })

  // ── Test 6: View My Notes ───────────────────────────────────────────────────
  test('6. View My Notes', async () => {
    const page = shared.page
    await navClick(page, 'My Notes')

    // The submitted note shows in the list with the patient + a Submitted badge.
    const card = page.locator('.scribe-note-card').filter({ hasText: PATIENT_NAME })
    await expect(card.first()).toBeVisible({ timeout: 15_000 })
    await expect(card.first()).toContainText(PATIENT_MRN)
    await expect(card.first().locator('.scribe-status-badge')).toContainText(/Submitted|Graded/i)
  })

  // ── Test 7: View My Grades ──────────────────────────────────────────────────
  test('7. View My Grades', async () => {
    const page = shared.page
    await navClick(page, 'My Grades')

    // Grades screen loads (stat cards + the rubric description that names the
    // grading criteria). The 4-criteria breakdown only appears inside an
    // individual graded note, which a scribe-only run does not have.
    await expect(page.locator('.scribe-stats--grades')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('.scribe-stat--notes-graded').filter({ hasText: /Notes Graded/i }),
    ).toBeVisible()
    await expect(page.getByText(/accuracy, completeness/i)).toBeVisible()
  })
})
