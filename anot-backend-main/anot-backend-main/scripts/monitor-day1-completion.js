#!/usr/bin/env node
'use strict'
/** Monitor Day 1 transcription + Claude draft completion until 80/80 */
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const DAY1_IDS = [122,123,124,125,126,132,138,144,150,156,162,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402]

const RECOVERED_IDS = [191,383,384,385,386,387,388,389,390,391,392,393,394,395]
const API_BASE = 'https://app.anot.health/api'
const MAX_MINUTES = 90
const POLL_SEC = 30

async function login() {
  const jar = createCookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...jar.headers() },
    body: JSON.stringify({ email: 'nahid@anot.health', password: '#1Knowtex2026' }),
  })
  jar.store(res)
  if (!res.ok) throw new Error('Login failed')
  return jar
}

async function snapshot(jar) {
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const byId = new Map(all.visits.map((v) => [v.id, v]))

  let txCompleted = 0
  let txProcessing = 0
  let txFailed = 0
  let txOther = 0
  let drafts = 0
  const pending = []
  const failed = []
  const recovered = { completed: 0, processing: 0, failed: 0, drafts: 0 }

  for (const id of DAY1_IDS) {
    const v = byId.get(id)
    const tx = v?.transcription_status || 'missing'
    if (tx === 'completed') txCompleted++
    else if (tx === 'processing') { txProcessing++; pending.push(id) }
    else if (tx === 'failed' || tx === 'processing_error') { txFailed++; failed.push(id); pending.push(id) }
    else txOther++

    if (RECOVERED_IDS.includes(id)) {
      if (tx === 'completed') recovered.completed++
      else if (tx === 'processing') recovered.processing++
      else if (tx === 'failed' || tx === 'processing_error') recovered.failed++
    }

    try {
      const note = await apiFetch(API_BASE, `/notes/visit/${id}`, { jar })
      if (note.note?.ai_draft?.trim()) {
        drafts++
        if (RECOVERED_IDS.includes(id)) recovered.drafts++
      }
    } catch { /* no note */ }
    await sleep(30)
  }

  return { txCompleted, txProcessing, txFailed, txOther, drafts, pending, failed, recovered }
}

async function main() {
  let jar = await login()
  const start = Date.now()
  let poll = 0

  console.log('Monitoring Day 1 visits until 80/80 transcription + Claude drafts...')
  console.log('Re-queued recovery set:', RECOVERED_IDS.join(','))

  while (Date.now() - start < MAX_MINUTES * 60 * 1000) {
    poll++
    try {
      const s = await snapshot(jar)
      const mins = Math.round((Date.now() - start) / 60000)
      console.log(`[poll ${poll} @ ${mins}m] tx=${s.txCompleted}/80 processing=${s.txProcessing} failed=${s.txFailed} drafts=${s.drafts}/80`)
      console.log(`  recovered: tx=${s.recovered.completed}/14 processing=${s.recovered.processing} failed=${s.recovered.failed} drafts=${s.recovered.drafts}/14`)

      if (s.txFailed > 0) console.log('  FAILED IDs:', s.failed.join(','))
      if (s.txProcessing > 0 && s.txProcessing <= 20) console.log('  PROCESSING IDs:', s.pending.filter((id) => !s.failed.includes(id)).join(','))

      if (s.txCompleted === 80 && s.drafts === 80) {
        console.log('\n=== ALL 80/80 COMPLETE ===')
        console.log('Transcription: 80/80')
        console.log('Claude drafts: 80/80')
        console.log('Recovered visits:', s.recovered.completed + '/14 transcription,', s.recovered.drafts + '/14 drafts')
        process.exit(0)
      }
    } catch (err) {
      if (/token|authorized|401|403/i.test(err.message)) {
        console.log('Session expired — re-login')
        jar = await login()
      } else {
        console.warn('Poll error:', err.message)
      }
    }
    await sleep(POLL_SEC * 1000)
  }

  console.error('Timeout after', MAX_MINUTES, 'minutes')
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
