#!/usr/bin/env node
'use strict'

/**
 * Day 2 Complete Workflow — 5 patients, 5 visits, 2 recordings per visit (same visit).
 * Date: 2026-07-04
 *
 * Usage: node scripts/day2-workflow.js --confirm
 *        node scripts/day2-workflow.js --confirm --skip-audio-gen
 *        node scripts/day2-workflow.js --confirm --resume-from=scribe
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  sleep,
  createCookieJar,
  fetchCsrfToken,
  apiFetch,
  apiMutate,
} = require('./lib/apiTestHelpers')

const DAY2_DATE = '2026-07-04'
const API_BASE = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
const AUDIO_DIR = path.join(__dirname, '..', 'test-fixtures', 'load-test', 'day2')
const STATE_PATH = path.join(AUDIO_DIR, 'workflow-state.json')
const UPLOAD_INTERVAL_MS = 6000 // ~10/min

const CREDS = {
  clinician: { email: 'nahid@anot.health', password: '#1Knowtex2026' },
  scribe: { email: 'shahib@anot.health', password: '#1Knowtex2026' },
  qps: { email: 'farhan@anot.health', password: '#1Knowtex2026' },
}

const PATIENTS = [
  { name: 'Robert Chen', mrn: 'DAY2-20260704-001', dob: '1978-03-12', complaint: 'hypertension follow-up' },
  { name: 'Maria Santos', mrn: 'DAY2-20260704-002', dob: '1965-11-08', complaint: 'type 2 diabetes management' },
  { name: 'James Wilson', mrn: 'DAY2-20260704-003', dob: '1982-07-22', complaint: 'chronic lower back pain' },
  { name: 'Linda Park', mrn: 'DAY2-20260704-004', dob: '1970-01-30', complaint: 'persistent cough and wheezing' },
  { name: 'David Okonkwo', mrn: 'DAY2-20260704-005', dob: '1990-09-14', complaint: 'migraine headaches' },
]

const VISIT_TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00']
const GRADE_SCORES = [
  { accuracy: 92, completeness: 88, terminology: 90, formatting: 87 },
  { accuracy: 89, completeness: 91, terminology: 86, formatting: 90 },
  { accuracy: 94, completeness: 87, terminology: 93, formatting: 88 },
  { accuracy: 85, completeness: 92, terminology: 88, formatting: 91 },
  { accuracy: 91, completeness: 89, terminology: 87, formatting: 93 },
]

function parseArgs(argv) {
  const opts = { confirm: false, skipAudioGen: false, resumeFrom: null }
  for (const arg of argv) {
    if (arg === '--confirm') opts.confirm = true
    else if (arg === '--skip-audio-gen') opts.skipAudioGen = true
    else if (arg.startsWith('--resume-from=')) opts.resumeFrom = arg.slice(14)
  }
  return opts
}

function saveState(state) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return null
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
}

async function login(email, password) {
  const jar = createCookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...jar.headers(),
    },
    body: JSON.stringify({ email, password }),
  })
  jar.store(res)
  const data = await res.json()
  if (!res.ok || data.requireMfa || data.enrollmentRequired || data.requirePhiTraining) {
    throw new Error(data.error || `Login blocked for ${email}: ${JSON.stringify(data)}`)
  }
  if (!data.user) throw new Error(`Login failed for ${email}`)
  await fetchCsrfToken(API_BASE, jar)
  return { jar, user: data.user }
}

async function createPatientsAndVisits(jar) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const created = []

  for (let i = 0; i < PATIENTS.length; i++) {
    const p = PATIENTS[i]
    let patientId
    try {
      const res = await apiMutate(API_BASE, 'POST', '/patients', {
        jar,
        csrf,
        body: { name: p.name, mrn: p.mrn, date_of_birth: p.dob },
      })
      patientId = res.patient.id
      console.log(`  Patient ${i + 1}/5: ${p.name} (id=${patientId})`)
    } catch (err) {
      if (err.status === 409) {
        const all = await apiFetch(API_BASE, '/patients', { jar })
        const existing = (all.patients || []).find((x) => x.mrn === p.mrn.toUpperCase())
        if (!existing) throw err
        patientId = existing.id
        console.log(`  Patient ${i + 1}/5: ${p.name} already exists (id=${patientId})`)
      } else {
        throw err
      }
    }

    const visitRes = await apiMutate(API_BASE, 'POST', '/visits', {
      jar,
      csrf,
      body: {
        patient_id: patientId,
        visit_date: DAY2_DATE,
        visit_time: VISIT_TIMES[i],
        visit_type: 'Follow-up',
      },
    })
    const visitId = visitRes.visit.id
    console.log(`  Visit ${i + 1}/5: id=${visitId} for ${p.name}`)
    created.push({
      patientId,
      visitId,
      name: p.name,
      mrn: p.mrn,
      complaint: p.complaint,
    })
    await sleep(100)
  }
  return created
}

function generateAudioFiles() {
  execSync(
    `node "${path.join(__dirname, 'generate-load-test-audio.js')}" --count=10 --duration=660 --out="${AUDIO_DIR}"`,
    { stdio: 'inherit', cwd: path.join(__dirname, '..') },
  )
}

async function recordConsent(jar, visitIds) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  for (const visitId of visitIds) {
    try {
      await apiMutate(API_BASE, 'POST', '/consent/recording', {
        jar,
        csrf,
        body: { visitId },
      })
    } catch (err) {
      if (!/already|recorded/i.test(err.message)) throw err
    }
  }
}

async function uploadAudio(jar, visitId, filePath, append = false, retries = 5) {
  const endpoint = append ? `/audio/${visitId}/append` : `/audio/${visitId}`
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const form = new FormData()
      const buf = fs.readFileSync(filePath)
      const blob = new Blob([buf], { type: 'audio/wav' })
      form.append('audio', blob, path.basename(filePath))
      const csrf = await fetchCsrfToken(API_BASE, jar)
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf, ...jar.headers() },
        body: form,
      })
      jar.store(res)
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
      if (res.status === 429) {
        await sleep(attempt * 5000)
        continue
      }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return data
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(attempt * 2000)
    }
  }
}

async function endVisit(jar, visitId, durationSeconds) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  await apiMutate(API_BASE, 'PUT', `/visits/${visitId}/end`, {
    jar,
    csrf,
    body: { duration_seconds: durationSeconds },
  }).catch(() => {})
}

function audioFileForVisit(index, recNum) {
  // recNum: 0 = first recording, 1 = second → files 001–010 (2 per visit)
  const fileIndex = index * 2 + recNum + 1
  return path.join(AUDIO_DIR, `visit-audio-${String(fileIndex).padStart(3, '0')}.wav`)
}

async function uploadAllRecordings(jar, visits) {
  await recordConsent(jar, visits.map((v) => v.visitId))
  let uploaded = 0
  const uploadStart = Date.now()

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i]
    const rec1 = audioFileForVisit(i, 0)
    const rec2 = audioFileForVisit(i, 1)
    for (const [recNum, filePath, append] of [[1, rec1, false], [2, rec2, true]]) {
      if (!fs.existsSync(filePath)) throw new Error(`Missing audio: ${filePath}`)
      await uploadAudio(jar, v.visitId, filePath, append)
      uploaded++
      console.log(`  Uploaded ${uploaded}/10: visit ${v.visitId} recording ${recNum}`)
      if (uploaded < 10) await sleep(UPLOAD_INTERVAL_MS)
    }
    await endVisit(jar, v.visitId, 1320)
  }

  return { uploaded, uploadMinutes: Math.round((Date.now() - uploadStart) / 60000) }
}

function audioCount(visit) {
  if (!visit.audio_file) return 0
  return String(visit.audio_file).split(',').map((f) => f.trim()).filter(Boolean).length
}

async function waitForTranscriptions(jar, visitIds, maxWaitMin = 45) {
  const deadline = Date.now() + maxWaitMin * 60 * 1000
  let pollNum = 0

  while (Date.now() < deadline) {
    pollNum++
    const all = await apiFetch(API_BASE, '/visits', { jar })
    const byId = new Map((all.visits || []).map((v) => [v.id, v]))
    let completed = 0
    let failed = 0
    let drafts = 0

    for (const id of visitIds) {
      const v = byId.get(id)
      if (!v) continue
      const tx = v.transcription_status || 'pending'
      if (tx === 'completed') completed++
      else if (tx === 'failed') failed++
      try {
        const note = await apiFetch(API_BASE, `/notes/visit/${id}`, { jar })
        if (note.note?.ai_draft && String(note.note.ai_draft).trim()) drafts++
      } catch { /* no note yet */ }
    }

    const elapsed = Math.round((Date.now() - pollNum * 30000) / 60000)
    console.log(
      `[poll ${pollNum}] tx=${completed}/${visitIds.length} failed=${failed} ai_drafts=${drafts}/${visitIds.length}`,
    )

    if (completed === visitIds.length && drafts === visitIds.length) {
      return { completed, failed, drafts }
    }
    if (failed > 0 && completed + failed === visitIds.length) {
      return { completed, failed, drafts }
    }
    await sleep(30000)
  }
  throw new Error(`Transcription timed out after ${maxWaitMin} minutes`)
}

async function scribeWorkflow(jar, visits) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const results = []

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i]
    const note = await apiFetch(API_BASE, `/notes/visit/${v.visitId}`, { jar })
    if (!note.note) throw new Error(`No note for visit ${v.visitId}`)
    if (!note.note.ai_draft) throw new Error(`No AI draft for visit ${v.visitId}`)

    const draftText = note.note.ai_draft
    const noteId = note.note.id

    await apiMutate(API_BASE, 'POST', '/notes/draft', {
      jar,
      csrf,
      body: {
        visit_id: v.visitId,
        final_note: draftText,
        transcription: note.note.transcription,
        ai_draft: note.note.ai_draft,
      },
    })

    const submitted = await apiMutate(API_BASE, 'PUT', `/notes/${noteId}/submit`, { jar, csrf })
    results.push({ visitId: v.visitId, noteId, status: submitted.note?.status })
    console.log(`  Scribe submitted note ${i + 1}/5: visit ${v.visitId} status=${submitted.note?.status}`)
    await sleep(200)
  }
  return results
}

async function qpsGrade(jar, visits) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const grades = []

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i]
    const note = await apiFetch(API_BASE, `/notes/visit/${v.visitId}`, { jar })
    const noteId = note.note?.id
    if (!noteId) throw new Error(`No note to grade for visit ${v.visitId}`)

    const scores = GRADE_SCORES[i]
    const grade = await apiMutate(API_BASE, 'POST', '/notes/grade', {
      jar,
      csrf,
      body: {
        note_id: noteId,
        ...scores,
        comment: `Day 2 quality review - ${v.complaint}`,
      },
    })
    grades.push(grade.grade)
    console.log(
      `  QPS graded note ${i + 1}/5: visit ${v.visitId} overall=${grade.grade.overall_score}/100`,
    )
    await sleep(200)
  }
  return grades
}

async function clinicianLock(jar, visits) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const locked = []

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i]
    const res = await apiMutate(API_BASE, 'POST', `/visits/${v.visitId}/lock-note`, { jar, csrf })
    const noteLocked = !!res.visit?.locked_at
    locked.push({ visitId: v.visitId, locked: noteLocked })
    console.log(`  Locked note ${i + 1}/5: visit ${v.visitId} locked=${noteLocked}`)
    await sleep(200)
  }
  return locked
}

async function verifyFinal(jar, visits) {
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const byId = new Map((all.visits || []).map((v) => [v.id, v]))
  const report = {
    patientsCreated: visits.length,
    visitsCreated: visits.length,
    recordingsUploaded: 0,
    transcriptionsCompleted: 0,
    claudeNotesGenerated: 0,
    notesSubmitted: 0,
    notesGraded: 0,
    notesLocked: 0,
    visitDetails: [],
  }

  for (const v of visits) {
    const visit = byId.get(v.visitId) || {}
    const recCount = audioCount(visit)
    report.recordingsUploaded += recCount
    if (visit.transcription_status === 'completed') report.transcriptionsCompleted++

    let noteDetail = {}
    try {
      const note = await apiFetch(API_BASE, `/notes/visit/${v.visitId}`, { jar })
      const n = note.note || {}
      if (n.ai_draft) report.claudeNotesGenerated++
      if (['submitted', 'uploaded'].includes(n.status)) report.notesSubmitted++
      if (n.locked_at) report.notesLocked++
      noteDetail = { status: n.status, locked: !!n.locked_at, hasDraft: !!n.ai_draft }
    } catch { /* no note */ }

    report.visitDetails.push({
      visitId: v.visitId,
      patient: v.name,
      recordings: recCount,
      tx: visit.transcription_status,
      ...noteDetail,
    })
  }

  const qpsJar = (await login(CREDS.qps.email, CREDS.qps.password)).jar
  const allNotes = await apiFetch(API_BASE, '/notes?status=uploaded', { jar: qpsJar })
  const day2NoteIds = new Set()
  for (const v of visits) {
    try {
      const note = await apiFetch(API_BASE, `/notes/visit/${v.visitId}`, { jar: qpsJar })
      if (note.note?.id) day2NoteIds.add(note.note.id)
    } catch { /* skip */ }
  }
  report.notesGraded = [...day2NoteIds].filter((id) =>
    (allNotes.notes || []).some((n) => n.id === id && n.status === 'uploaded'),
  ).length

  return report
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.confirm) {
    console.error('Blocked. Pass --confirm to run against production.')
    process.exit(1)
  }

  const wallStart = Date.now()
  let state = loadState() || { day: DAY2_DATE, visits: [], phase: 'create' }

  console.log('=== DAY 2 COMPLETE WORKFLOW ===')
  console.log(`Date: ${DAY2_DATE}`)
  console.log(`API: ${API_BASE}`)

  // PART 1: Create patients & visits
  if (!opts.resumeFrom && state.phase === 'create') {
    console.log('\n--- PART 1: CREATE 5 PATIENTS & 5 VISITS ---')
    const { jar } = await login(CREDS.clinician.email, CREDS.clinician.password)
    state.visits = await createPatientsAndVisits(jar)
    state.phase = 'audio'
    saveState(state)
    console.log(`Created ${state.visits.length} patients and ${state.visits.length} visits`)
  }

  if (!state.visits.length) {
    throw new Error('No visits in state. Run without --resume-from first.')
  }

  const visitIds = state.visits.map((v) => v.visitId)

  // PART 2: Generate audio
  if (!opts.skipAudioGen && (!opts.resumeFrom || opts.resumeFrom === 'audio') && state.phase === 'audio') {
    console.log('\n--- PART 2: GENERATE 10 RECORDINGS (10+ min each) ---')
    generateAudioFiles()
    state.phase = 'upload'
    saveState(state)
    console.log('Generated 10 audio files (~11 min each)')
  }

  // PART 3: Upload recordings
  if ((!opts.resumeFrom || ['upload', 'audio'].includes(opts.resumeFrom)) && state.phase === 'upload') {
    console.log('\n--- PART 3: UPLOAD 10 RECORDINGS (2 per visit) ---')
    const { jar } = await login(CREDS.clinician.email, CREDS.clinician.password)
    const uploadResult = await uploadAllRecordings(jar, state.visits)
    state.upload = uploadResult
    state.phase = 'transcribe'
    saveState(state)
    console.log(`Uploaded ${uploadResult.uploaded}/10 in ~${uploadResult.uploadMinutes} min`)
  }

  // PART 4: Scribe — wait for transcription + submit notes
  if (!opts.resumeFrom || ['transcribe', 'scribe', 'upload'].includes(opts.resumeFrom)) {
    if (state.phase === 'transcribe' || state.phase === 'upload') {
      console.log('\n--- PART 4: WAIT FOR TRANSCRIPTION (Deepgram + Claude) ---')
      const { jar: scribeJar } = await login(CREDS.scribe.email, CREDS.scribe.password)
      const txResult = await waitForTranscriptions(scribeJar, visitIds, 60)
      state.transcription = txResult
      console.log(`Transcription: ${txResult.completed}/${visitIds.length}, drafts: ${txResult.drafts}`)
      if (txResult.failed > 0) throw new Error(`${txResult.failed} transcriptions failed`)

      console.log('\n--- PART 4b: SCRIBE SUBMIT NOTES (Upload to EMR) ---')
      state.scribeResults = await scribeWorkflow(scribeJar, state.visits)
      state.phase = 'qps'
      saveState(state)
    }
  }

  // PART 5: QPS grade
  if (state.phase === 'qps' || opts.resumeFrom === 'qps') {
    console.log('\n--- PART 5: QPS GRADE 5 NOTES ---')
    const { jar: qpsJar } = await login(CREDS.qps.email, CREDS.qps.password)
    state.grades = await qpsGrade(qpsJar, state.visits)
    state.phase = 'lock'
    saveState(state)
  }

  // PART 6: Clinician lock
  if (state.phase === 'lock' || opts.resumeFrom === 'lock') {
    console.log('\n--- PART 6: CLINICIAN LOCK 5 NOTES ---')
    const { jar: clinJar } = await login(CREDS.clinician.email, CREDS.clinician.password)
    state.locked = await clinicianLock(clinJar, state.visits)
    state.phase = 'done'
    saveState(state)
  }

  // Final verification & report
  console.log('\n--- FINAL VERIFICATION ---')
  const { jar: verifyJar } = await login(CREDS.clinician.email, CREDS.clinician.password)
  const final = await verifyFinal(verifyJar, state.visits)

  const avgGrade = state.grades?.length
    ? Math.round(state.grades.reduce((s, g) => s + g.overall_score, 0) / state.grades.length)
    : null
  const totalAudioMin = 100
  const deepgramCost = (totalAudioMin * 0.004).toFixed(2)
  const claudeCost = (5 * 0.004).toFixed(2)
  const totalCost = (parseFloat(deepgramCost) + parseFloat(claudeCost)).toFixed(2)

  const report = {
    day: DAY2_DATE,
    patientsCreated: `${final.patientsCreated}/5`,
    visitsCreated: `${final.visitsCreated}/5`,
    recordingsUploaded: `${final.recordingsUploaded}/10`,
    transcriptionsCompleted: `${final.transcriptionsCompleted}/5`,
    claudeNotesGenerated: `${final.claudeNotesGenerated}/5`,
    notesUploadedToEMR: `${final.notesSubmitted}/5`,
    qpsGradesSubmitted: `${state.grades?.length || 0}/5`,
    averageGrade: avgGrade ? `${avgGrade}/100` : 'N/A',
    notesLocked: `${final.notesLocked}/5`,
    totalCost: `~$${totalCost}`,
    wallMinutes: Math.round((Date.now() - wallStart) / 60000),
    visitDetails: final.visitDetails,
    grades: state.grades,
  }

  const reportPath = path.join(AUDIO_DIR, `report-${DAY2_DATE}.json`)
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log('\n=== DAY 2 WORKFLOW REPORT ===')
  console.log(`Patients created:        ${report.patientsCreated}`)
  console.log(`Visits created:          ${report.visitsCreated}`)
  console.log(`Recordings uploaded:     ${report.recordingsUploaded}`)
  console.log(`Transcriptions completed:${report.transcriptionsCompleted}`)
  console.log(`Claude notes generated:  ${report.claudeNotesGenerated}`)
  console.log(`Notes uploaded to EMR:   ${report.notesUploadedToEMR}`)
  console.log(`QPS grades submitted:    ${report.qpsGradesSubmitted}`)
  console.log(`Average grade:           ${report.averageGrade}`)
  console.log(`Notes locked:            ${report.notesLocked}`)
  console.log(`Total cost:              ${report.totalCost}`)
  console.log(`Wall time:               ${report.wallMinutes} minutes`)
  console.log(`Report saved:            ${reportPath}`)

  const success =
    final.recordingsUploaded === 10 &&
    final.transcriptionsCompleted === 5 &&
    final.claudeNotesGenerated === 5 &&
    final.notesSubmitted === 5 &&
    (state.grades?.length || 0) === 5 &&
    final.notesLocked === 5

  if (success) {
    console.log('\nDONE')
    process.exit(0)
  }
  console.log('\nINCOMPLETE — see report for details')
  process.exit(1)
}

main().catch((err) => {
  console.error('Day 2 workflow failed:', err.message)
  process.exit(1)
})
