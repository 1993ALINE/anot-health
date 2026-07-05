#!/usr/bin/env node
'use strict'
/** Verify Day 1: 40 patients × 2 recordings, transcription, Claude notes */
const fs = require('fs')
const path = require('path')
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const DAY1_DATE = process.env.DAY1_DATE || '2026-07-03'
const API_BASE = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
const EMAIL = process.env.LOAD_TEST_EMAIL || 'nahid@anot.health'
const PASSWORD = process.env.LOAD_TEST_PASSWORD || '#1Knowtex2026'
const OUT_DIR = path.join(__dirname, '..', 'test-fixtures', 'load-test', 'day1')

function hasAudio(v) {
  const af = v.audio_file ?? v.audio_path
  if (!af) return false
  const s = String(af).trim()
  return s !== '' && s !== '[]' && s !== 'null'
}

function audioFileCount(v) {
  if (!hasAudio(v)) return 0
  return String(v.audio_file).split(',').map((f) => f.trim()).filter(Boolean).length
}

async function login() {
  const jar = createCookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...jar.headers() },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  jar.store(res)
  const data = await res.json()
  if (!res.ok || data.requireMfa) throw new Error(data.error || 'Login failed')
  await fetchCsrfToken(API_BASE, jar)
  return jar
}

async function main() {
  const jar = await login()
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const dayVisits = (all.visits || [])
    .filter((v) => String(v.visit_date || '').slice(0, 10) === DAY1_DATE)
    .sort((a, b) => a.id - b.id)

  const byPatient = new Map()
  for (const v of dayVisits) {
    if (!byPatient.has(v.patient_id)) byPatient.set(v.patient_id, [])
    byPatient.get(v.patient_id).push(v)
  }

  const details = []
  let visit1WithAudio = 0
  let visit2WithAudio = 0
  let visit1TxCompleted = 0
  let visit2TxCompleted = 0
  let claudeNotesGenerated = 0
  let transcriptionFailed = 0

  for (const [patientId, visits] of [...byPatient.entries()].sort((a, b) => a[0] - b[0])) {
    visits.sort((a, b) => a.id - b.id)
    const v1 = visits[0]
    const v2 = visits[1] || null

    if (hasAudio(v1)) visit1WithAudio++
    if (v2 && hasAudio(v2)) visit2WithAudio++
    if (v1.transcription_status === 'completed') visit1TxCompleted++
    if (v2?.transcription_status === 'completed') visit2TxCompleted++
    if (['failed', 'processing_error'].includes(v1.transcription_status)) transcriptionFailed++
    if (v2 && ['failed', 'processing_error'].includes(v2.transcription_status)) transcriptionFailed++

    let d1 = false
    let d2 = false
    try {
      const n1 = await apiFetch(API_BASE, `/notes/visit/${v1.id}`, { jar })
      d1 = !!(n1.note?.ai_draft && String(n1.note.ai_draft).trim())
    } catch { /* no note */ }
    if (v2) {
      try {
        const n2 = await apiFetch(API_BASE, `/notes/visit/${v2.id}`, { jar })
        d2 = !!(n2.note?.ai_draft && String(n2.note.ai_draft).trim())
      } catch { /* no note */ }
    }
    if (d1) claudeNotesGenerated++
    if (d2) claudeNotesGenerated++
    await sleep(30)

    details.push({
      patient_id: patientId,
      name: v1.patient_name,
      visit1: v1.id,
      visit2: v2?.id || null,
      v1tx: v1.transcription_status,
      v2tx: v2?.transcription_status || 'missing',
      v1audio: audioFileCount(v1),
      v2audio: v2 ? audioFileCount(v2) : 0,
      d1,
      d2,
    })
  }

  const totalPatients = byPatient.size
  const allComplete =
    totalPatients === 40 &&
    visit1WithAudio === 40 &&
    visit2WithAudio === 40 &&
    visit1TxCompleted === 40 &&
    visit2TxCompleted === 40 &&
    claudeNotesGenerated === 80 &&
    transcriptionFailed === 0

  const report = {
    verifiedAt: new Date().toISOString(),
    day: DAY1_DATE,
    totalPatients,
    totalVisits: dayVisits.length,
    visit1WithAudio,
    visit2WithAudio,
    visit1TxCompleted,
    visit2TxCompleted,
    claudeNotesGenerated,
    transcriptionFailed,
    allComplete,
    estimatedCostTotal: Number(((80 * 10 * 0.004) + (80 * 0.004)).toFixed(2)),
    readyForDays2to5: allComplete,
  }

  const out = { report, details }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, 'report-2nd-recording-final.json')
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))

  console.log('=== DAY 1 — 2ND RECORDING FINAL REPORT ===')
  console.log(`2nd recordings uploaded:     ${visit2WithAudio}/40`)
  console.log(`2nd transcriptions:          ${visit2TxCompleted}/40`)
  console.log(`2nd Claude notes:            ${details.filter((d) => d.d2).length}/40`)
  console.log(`Visit 1 recordings:          ${visit1WithAudio}/40`)
  console.log(`Visit 1 transcriptions:      ${visit1TxCompleted}/40`)
  console.log(`Total Claude notes:          ${claudeNotesGenerated}/80`)
  console.log(`Day 1 total recordings:      ${visit1WithAudio + visit2WithAudio}/80`)
  console.log(`Transcription failures:      ${transcriptionFailed}`)
  console.log(`All complete:                ${allComplete ? 'YES' : 'NO'}`)
  console.log(`Report saved:                ${outPath}`)
  if (allComplete) console.log('\nDONE')
  process.exit(allComplete ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
