#!/usr/bin/env node
'use strict'

/**
 * Day 1 Load Test — fetch visits, ensure 80, generate audio, upload, monitor.
 *
 * Usage:
 *   node scripts/day1-load-test.js --confirm
 *   node scripts/day1-load-test.js --confirm --day=2026-07-03 --skip-create-visits
 *   node scripts/day1-load-test.js --confirm --upload-only --skip-audio-gen
 */

const fs = require('fs')
const path = require('path')
const {
  sleep,
  createCookieJar,
  fetchCsrfToken,
  apiFetch,
  apiMutate,
} = require('./lib/apiTestHelpers')

const DAY1_DATE = '2026-07-03'
const API_BASE = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
const EMAIL = process.env.LOAD_TEST_EMAIL || 'nahid@anot.health'
const PASSWORD = process.env.LOAD_TEST_PASSWORD || '#1Knowtex2026'
const AUDIO_DIR = path.join(__dirname, '..', 'test-fixtures', 'load-test', 'day1')
const UPLOAD_INTERVAL_MS = 750 // ~80/min
const POLL_INTERVAL_MS = 30000
const MAX_POLL_MINUTES = 180

function parseArgs(argv) {
  const opts = {
    confirm: false,
    day: DAY1_DATE,
    skipCreateVisits: false,
    skipAudioGen: false,
    uploadOnly: false,
    targetCount: 80,
  }
  for (const arg of argv) {
    if (arg === '--confirm') opts.confirm = true
    else if (arg === '--skip-create-visits') opts.skipCreateVisits = true
    else if (arg === '--skip-audio-gen') opts.skipAudioGen = true
    else if (arg === '--upload-only') opts.uploadOnly = true
    else if (arg.startsWith('--day=')) opts.day = arg.slice(6)
    else if (arg.startsWith('--target=')) opts.targetCount = parseInt(arg.slice(9), 10) || 80
  }
  return opts
}

async function login(apiBase, email, password) {
  const jar = createCookieJar()
  const csrf = await fetchCsrfToken(apiBase, jar)
  const res = await fetch(`${apiBase}/auth/login`, {
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
  if (!res.ok || data.requireMfa || data.enrollmentRequired) {
    throw new Error(data.error || `Login blocked: ${JSON.stringify(data)}`)
  }
  if (!data.user) throw new Error('Login failed — no user in response')
  await fetchCsrfToken(apiBase, jar)
  return { jar, user: data.user, token: data.token || null }
}

function visitDateStr(v) {
  return String(v.visit_date || '').slice(0, 10)
}

async function fetchDay1Visits(apiBase, jar, day) {
  const all = await apiFetch(apiBase, '/visits', { jar })
  const dayVisits = (all.visits || [])
    .filter((v) => visitDateStr(v) === day)
    .sort((a, b) => a.id - b.id)
  return dayVisits
}

async function createFollowUpVisits(apiBase, jar, dayVisits, day) {
  const csrf = await fetchCsrfToken(apiBase, jar)
  const created = []
  const times = ['09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00']
  for (let i = 0; i < dayVisits.length; i++) {
    const v = dayVisits[i]
    const body = {
      patient_id: v.patient_id,
      visit_date: day,
      visit_time: times[i % times.length],
      visit_type: 'Follow-up',
    }
    const res = await apiMutate(apiBase, 'POST', '/visits', { jar, csrf, body })
    created.push(res.visit)
    process.stdout.write(`\r  Created follow-up visit ${i + 1}/${dayVisits.length} (id=${res.visit.id})`)
    await sleep(100)
  }
  console.log('')
  return created
}

async function recordConsent(apiBase, jar, visitIds) {
  const csrf = await fetchCsrfToken(apiBase, jar)
  for (let i = 0; i < visitIds.length; i++) {
    const visitId = visitIds[i]
    try {
      await apiMutate(apiBase, 'POST', '/consent/recording', {
        jar,
        csrf,
        body: { visitId },
      })
    } catch (err) {
      if (!/already|recorded/i.test(err.message)) throw err
    }
    if ((i + 1) % 10 === 0) process.stdout.write(`\r  Consent recorded: ${i + 1}/${visitIds.length}`)
    await sleep(50)
  }
  console.log(`\r  Consent recorded: ${visitIds.length}/${visitIds.length}`)
}

async function uploadAudio(apiBase, jar, visitId, filePath, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const form = new FormData()
      const buf = fs.readFileSync(filePath)
      const blob = new Blob([buf], { type: 'audio/wav' })
      form.append('audio', blob, path.basename(filePath))
      const csrf = await fetchCsrfToken(apiBase, jar)
      const res = await fetch(`${apiBase}/audio/${visitId}`, {
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
        const backoff = attempt * 5000
        console.warn(`\n  429 visit ${visitId} — backoff ${backoff}ms (attempt ${attempt})`)
        await sleep(backoff)
        continue
      }
      if (!res.ok) {
        throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, payload: data })
      }
      return data
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(attempt * 2000)
    }
  }
}

async function endVisit(apiBase, jar, visitId, durationSeconds) {
  const csrf = await fetchCsrfToken(apiBase, jar)
  await apiMutate(apiBase, 'PUT', `/visits/${visitId}/end`, {
    jar,
    csrf,
    body: { duration_seconds: durationSeconds },
  }).catch(() => {})
}

function generateAudioFiles(count) {
  const { execSync } = require('child_process')
  execSync(`node "${path.join(__dirname, 'generate-load-test-audio.js')}" --count=${count}`, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  })
}

async function pollTranscriptions(apiBase, jar, visitIds, startMs) {
  const deadline = Date.now() + MAX_POLL_MINUTES * 60 * 1000
  const status = new Map(visitIds.map((id) => [id, { tx: 'pending', draft: false, error: null }]))
  let pollNum = 0

  while (Date.now() < deadline) {
    pollNum++
    const all = await apiFetch(apiBase, '/visits', { jar })
    const byId = new Map((all.visits || []).map((v) => [v.id, v]))

    for (const id of visitIds) {
      const v = byId.get(id)
      if (!v) continue
      const tx = v.transcription_status || v.status || 'pending'
      let draft = false
      try {
        const note = await apiFetch(apiBase, `/notes/visit/${id}`, { jar })
        draft = !!(note.note?.ai_draft && String(note.note.ai_draft).trim())
        if (note.note?.transcription_status) {
          status.get(id).tx = note.note.transcription_status
        }
      } catch {
        /* note may not exist yet */
      }
      if (tx === 'completed' || tx === 'failed') status.get(id).tx = tx
      status.get(id).draft = draft
    }

    const completed = [...status.values()].filter((s) => s.tx === 'completed').length
    const failed = [...status.values()].filter((s) => s.tx === 'failed').length
    const pending = visitIds.length - completed - failed
    const drafts = [...status.values()].filter((s) => s.draft).length
    const elapsed = Math.round((Date.now() - startMs) / 60000)
    console.log(
      `[poll ${pollNum}] completed=${completed}/${visitIds.length} failed=${failed} pending=${pending} ai_drafts=${drafts} (${elapsed}m elapsed)`,
    )

    if (completed === visitIds.length) break
    if (failed > 0 && completed + failed === visitIds.length) break
    await sleep(POLL_INTERVAL_MS)
  }

  return status
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.confirm) {
    console.error('Production load test blocked. Pass --confirm to run against app.anot.health')
    process.exit(1)
  }

  const report = {
    day: opts.day,
    targetVisits: opts.targetCount,
    visitIds: [],
    uploadSuccess: 0,
    uploadFailed: 0,
    uploadErrors: [],
    uploadMinutes: 0,
    audioFilesGenerated: 0,
    transcriptionCompleted: 0,
    transcriptionPending: 0,
    transcriptionFailed: 0,
    claudeNotesGenerated: 0,
    errors: [],
  }

  console.log('=== DAY 1 LOAD TEST ===')
  console.log(`API: ${API_BASE}`)
  console.log(`Day: ${opts.day}`)
  console.log(`User: ${EMAIL}`)

  const loginStart = Date.now()
  const { jar, user } = await login(API_BASE, EMAIL, PASSWORD)
  console.log(`Logged in as ${user.name} (${user.email}) id=${user.id}`)

  // Step 1: Fetch Day 1 visits
  console.log('\n--- STEP 1: FETCH DAY 1 VISITS ---')
  let dayVisits = await fetchDay1Visits(API_BASE, jar, opts.day)
  console.log(`Found ${dayVisits.length} visits on ${opts.day}`)

  if (dayVisits.length < opts.targetCount && !opts.skipCreateVisits) {
    const need = opts.targetCount - dayVisits.length
    console.log(`Creating ${need} follow-up visits to reach ${opts.targetCount}...`)
    const created = await createFollowUpVisits(API_BASE, jar, dayVisits, opts.day)
    dayVisits = [...dayVisits, ...created].sort((a, b) => a.id - b.id)
  }

  dayVisits = dayVisits.slice(0, opts.targetCount)
  report.visitIds = dayVisits.map((v) => v.id)
  console.log(`Using ${report.visitIds.length} visits`)
  console.log('Visit IDs:', report.visitIds.join(', '))
  console.log('Patients:', dayVisits.map((v) => `${v.id}:${v.patient_name}`).join('; '))

  if (opts.uploadOnly && opts.skipAudioGen) {
    console.log('Nothing to do.')
    return
  }

  // Step 2: Generate audio
  if (!opts.skipAudioGen) {
    console.log('\n--- STEP 2: GENERATE AUDIO FILES ---')
    generateAudioFiles(report.visitIds.length)
    report.audioFilesGenerated = report.visitIds.length
  }

  const manifestPath = path.join(AUDIO_DIR, 'manifest.json')
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : []

  // Consent before upload
  console.log('\n--- STEP 3: RECORD CONSENT ---')
  await recordConsent(API_BASE, jar, report.visitIds)

  // Step 3: Upload
  console.log('\n--- STEP 4: UPLOAD AUDIO ---')
  const uploadStart = Date.now()
  for (let i = 0; i < report.visitIds.length; i++) {
    const visitId = report.visitIds[i]
    const audioFile = path.join(AUDIO_DIR, `visit-audio-${String(i + 1).padStart(3, '0')}.wav`)
    if (!fs.existsSync(audioFile)) {
      report.uploadFailed++
      report.uploadErrors.push({ visitId, error: `Missing audio: ${audioFile}` })
      continue
    }
    try {
      const result = await uploadAudio(API_BASE, jar, visitId, audioFile)
      await endVisit(API_BASE, jar, visitId, manifest[i]?.durationSec || 600)
      report.uploadSuccess++
      process.stdout.write(
        `\r  Uploaded ${report.uploadSuccess}/${report.visitIds.length} (visit ${visitId}, queued=${result?.transcription_queued ?? '?'})`,
      )
    } catch (err) {
      report.uploadFailed++
      report.uploadErrors.push({ visitId, error: err.message })
      console.warn(`\n  FAIL visit ${visitId}: ${err.message}`)
    }
    if (i < report.visitIds.length - 1) await sleep(UPLOAD_INTERVAL_MS)
  }
  console.log('')
  report.uploadMinutes = Math.round((Date.now() - uploadStart) / 60000)

  // Step 4: Poll transcription
  console.log('\n--- STEP 5: MONITOR TRANSCRIPTION ---')
  const txStart = Date.now()
  const txStatus = await pollTranscriptions(API_BASE, jar, report.visitIds, txStart)

  for (const [, s] of txStatus) {
    if (s.tx === 'completed') report.transcriptionCompleted++
    else if (s.tx === 'failed') report.transcriptionFailed++
    else report.transcriptionPending++
    if (s.draft) report.claudeNotesGenerated++
  }

  const totalAudioMin = report.audioFilesGenerated * 10
  const txMinutes = Math.round((Date.now() - txStart) / 60000)
  const deepgramCost = (totalAudioMin * 0.004).toFixed(2)
  const claudeCost = (report.claudeNotesGenerated * 0.004).toFixed(2)
  const totalCost = (parseFloat(deepgramCost) + parseFloat(claudeCost)).toFixed(2)

  console.log('\n=== DAY 1 LOAD TEST REPORT ===')
  console.log(`Total visits:              ${report.visitIds.length}`)
  console.log(`Total audio files:         ${report.audioFilesGenerated}`)
  console.log(`Total audio duration:      ${totalAudioMin} minutes (${report.audioFilesGenerated} × 10 min)`)
  console.log(`Upload success rate:       ${report.uploadSuccess}/${report.visitIds.length}`)
  console.log(`Upload time:               ${report.uploadMinutes} minutes`)
  console.log(`Transcription completed:   ${report.transcriptionCompleted}/${report.visitIds.length}`)
  console.log(`Transcription pending:     ${report.transcriptionPending}/${report.visitIds.length}`)
  console.log(`Transcription failed:      ${report.transcriptionFailed}/${report.visitIds.length}`)
  console.log(`Total transcription time:  ${txMinutes} minutes`)
  console.log(`Claude notes generated:    ${report.claudeNotesGenerated}/${report.visitIds.length}`)
  console.log(`Estimated cost:            ~$${totalCost} (Deepgram ~$${deepgramCost} + Claude ~$${claudeCost})`)
  console.log(`Errors:                    ${report.uploadErrors.length + report.errors.length}`)
  if (report.uploadErrors.length) {
    console.log('Upload errors:', JSON.stringify(report.uploadErrors.slice(0, 10), null, 2))
  }
  const stable =
    report.uploadSuccess === report.visitIds.length &&
    report.transcriptionFailed === 0 &&
    report.transcriptionPending === 0
  console.log(`System stable?             ${stable ? 'YES' : 'NO'}`)
  console.log(
    `Ready for Days 2-5?        ${stable && report.claudeNotesGenerated === report.visitIds.length ? 'YES' : 'NO'}`,
  )
  console.log(`Total wall time:           ${Math.round((Date.now() - loginStart) / 60000)} minutes`)

  const outPath = path.join(AUDIO_DIR, `report-${opts.day}.json`)
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ ...report, txMinutes, totalCost, stable }, null, 2))
  console.log(`Report saved: ${outPath}`)

  const allDone =
    report.uploadSuccess === report.visitIds.length &&
    report.transcriptionCompleted === report.visitIds.length &&
    report.claudeNotesGenerated === report.visitIds.length

  if (allDone) {
    console.log('\nDONE')
    process.exit(0)
  }
  process.exit(1)
}

main().catch((err) => {
  console.error('Load test failed:', err.message)
  if (err.payload) console.error(JSON.stringify(err.payload).slice(0, 500))
  process.exit(1)
})
