#!/usr/bin/env node
'use strict'
/** Identify Day 1 patients needing 2nd recording */
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const DAY1_DATE = '2026-07-03'
const API_BASE = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
const EMAIL = process.env.LOAD_TEST_EMAIL || 'nahid@anot.health'
const PASSWORD = process.env.LOAD_TEST_PASSWORD || '#1Knowtex2026'

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

function visitDateStr(v) {
  return String(v.visit_date || '').slice(0, 10)
}

function hasAudio(v) {
  const af = v.audio_file ?? v.audio_path
  if (!af) return false
  if (Array.isArray(af)) return af.length > 0
  const s = String(af).trim()
  return s !== '' && s !== '[]' && s !== 'null'
}

async function main() {
  const jar = await login()
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const dayVisits = (all.visits || [])
    .filter((v) => visitDateStr(v) === DAY1_DATE)
    .sort((a, b) => a.id - b.id)

  // Group by patient
  const byPatient = new Map()
  for (const v of dayVisits) {
    const pid = v.patient_id
    if (!byPatient.has(pid)) byPatient.set(pid, [])
    byPatient.get(pid).push(v)
  }

  const patients = []
  for (const [patientId, visits] of byPatient) {
    visits.sort((a, b) => a.id - b.id)
    const withAudio = visits.filter(hasAudio)
    const withoutAudio = visits.filter((v) => !hasAudio(v))
    patients.push({
      patient_id: patientId,
      patient_name: visits[0].patient_name,
      total_visits: visits.length,
      visits_with_audio: withAudio.length,
      visits_without_audio: withoutAudio.length,
      first_visit: visits[0],
      second_visit: visits[1] || null,
      all_visits: visits.map((v) => ({
        id: v.id,
        type: v.visit_type,
        has_audio: hasAudio(v),
        tx: v.transcription_status,
        status: v.status,
      })),
    })
  }

  patients.sort((a, b) => a.patient_id - b.patient_id)

  const readyFor2nd = patients.filter(
    (p) => p.visits_with_audio >= 1 && (p.second_visit ? !hasAudio(p.second_visit) : true),
  )
  const need2ndVisit = patients.filter((p) => p.total_visits < 2)
  const alreadyComplete = patients.filter(
    (p) => p.total_visits >= 2 && p.visits_with_audio >= 2,
  )

  console.log('=== DAY 1 — 2ND RECORDING IDENTIFICATION ===')
  console.log(`Day: ${DAY1_DATE}`)
  console.log(`Total Day 1 visits: ${dayVisits.length}`)
  console.log(`Unique patients: ${patients.length}`)
  console.log(`Patients with 1st recording, need 2nd: ${readyFor2nd.length}`)
  console.log(`Patients needing 2nd visit created: ${need2ndVisit.length}`)
  console.log(`Patients with both recordings: ${alreadyComplete.length}`)
  console.log('')

  if (readyFor2nd.length) {
    console.log('Patients ready for 2nd recording:')
    for (const p of readyFor2nd) {
      const v1 = p.all_visits.find((v) => v.has_audio)
      const v2 = p.second_visit
      console.log(
        `  patient=${p.patient_id} (${p.patient_name}) visit1=${v1?.id} tx=${v1?.tx} visit2=${v2?.id || 'MISSING'} has_audio2=${v2 ? hasAudio(v2) : false}`,
      )
    }
  }

  // Output JSON for downstream script
  const out = {
    day: DAY1_DATE,
    patientCount: patients.length,
    readyFor2ndCount: readyFor2nd.length,
    need2ndVisitCount: need2ndVisit.length,
    patients: readyFor2nd.map((p, i) => ({
      index: i + 1,
      patient_id: p.patient_id,
      patient_name: p.patient_name,
      first_visit_id: p.all_visits.find((v) => v.has_audio)?.id,
      second_visit_id: p.second_visit?.id || null,
      needs_visit_creation: p.total_visits < 2,
    })),
  }
  console.log('\n--- JSON ---')
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
