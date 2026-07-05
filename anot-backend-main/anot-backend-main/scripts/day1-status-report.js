#!/usr/bin/env node
'use strict'
/** Step 1: Identify stuck Day 1 visits via production API */
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const DAY1_IDS = [122,123,124,125,126,132,138,144,150,156,162,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402]

const STUCK_EXPECTED = [189,190,191,193,363,365,366,368,373,374,376,378,379,383,384,385,386,387,388,389,390,391,392,393,394,395]

const API_BASE = 'https://app.anot.health/api'

async function login() {
  const jar = createCookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...jar.headers() },
    body: JSON.stringify({ email: 'nahid@anot.health', password: '#1Knowtex2026' }),
  })
  jar.store(res)
  if (!res.ok) throw new Error('Login failed: ' + res.status)
  return jar
}

async function main() {
  const jar = await login()
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const byId = new Map(all.visits.map((v) => [v.id, v]))

  const day1 = DAY1_IDS.map((id) => {
    const v = byId.get(id)
    return {
      id,
      transcription_status: v?.transcription_status || 'missing',
      status: v?.status || 'missing',
    }
  })

  const processing = day1.filter((v) => v.transcription_status === 'processing')
  const completed = day1.filter((v) => v.transcription_status === 'completed')
  const failed = day1.filter((v) => ['failed', 'processing_error'].includes(v.transcription_status))
  const idle = day1.filter((v) => v.transcription_status === 'idle')
  const other = day1.filter((v) => !['processing', 'completed', 'failed', 'processing_error', 'idle'].includes(v.transcription_status))

  let drafts = 0
  for (const id of DAY1_IDS) {
    try {
      const note = await apiFetch(API_BASE, `/notes/visit/${id}`, { jar })
      if (note.note?.ai_draft?.trim()) drafts++
    } catch { /* no note */ }
    await sleep(50)
  }

  console.log('=== DAY 1 STATUS REPORT ===')
  console.log('Total Day 1 visits:', DAY1_IDS.length)
  console.log('Completed transcription:', completed.length)
  console.log('Processing (stuck):', processing.length)
  console.log('Failed/error:', failed.length)
  console.log('Idle:', idle.length)
  console.log('Other:', other.length, other.map((v) => `${v.id}=${v.transcription_status}`).join(', ') || 'none')
  console.log('Claude drafts:', drafts)
  console.log('')
  console.log('Stuck processing IDs:', processing.map((v) => v.id).join(','))
  console.log('Expected stuck IDs:', STUCK_EXPECTED.join(','))
  console.log('Match expected:', processing.map((v) => v.id).sort((a,b)=>a-b).join(',') === STUCK_EXPECTED.sort((a,b)=>a-b).join(','))
}

main().catch((e) => { console.error(e); process.exit(1) })
