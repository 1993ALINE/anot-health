#!/usr/bin/env node
'use strict'
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const VISIT_IDS = [122,123,124,125,126,132,138,144,150,156,162,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402]
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
  if (!res.ok) throw new Error('Login failed')
  return jar
}

async function status(jar) {
  const all = await apiFetch(API_BASE, '/visits', { jar })
  const byId = new Map(all.visits.map((v) => [v.id, v]))
  let completed = 0, processing = 0, failed = 0, drafts = 0
  const pending = []
  for (const id of VISIT_IDS) {
    const v = byId.get(id)
    const tx = v?.transcription_status || 'unknown'
    if (tx === 'completed') completed++
    else if (tx === 'failed') { failed++; pending.push(id) }
    else { processing++; pending.push(id) }
    try {
      const note = await apiFetch(API_BASE, `/notes/visit/${id}`, { jar })
      if (note.note?.ai_draft?.trim()) drafts++
    } catch { /* no note yet */ }
  }
  return { completed, processing, failed, drafts, pending }
}

async function main() {
  const start = Date.now()
  let jar = await login()
  let poll = 0
  while (Date.now() - start < 120 * 60 * 1000) {
    poll++
    try {
      const s = await status(jar)
      const mins = Math.round((Date.now() - start) / 60000)
      console.log(`[poll ${poll}] completed=${s.completed}/80 failed=${s.failed} processing=${s.processing} drafts=${s.drafts} (${mins}m)`)
      if (s.completed === 80 && s.drafts === 80) {
        console.log('ALL DONE')
        process.exit(0)
      }
      if (s.failed > 0) console.log('Failed IDs:', s.pending.filter((id) => {
        return true
      }))
    } catch (err) {
      if (/token|authorized|401|403/i.test(err.message)) {
        console.log('Session expired — re-login')
        jar = await login()
      } else {
        console.warn('Poll error:', err.message)
      }
    }
    await sleep(30000)
  }
  console.error('Timeout waiting for transcriptions')
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
