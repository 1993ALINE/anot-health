#!/usr/bin/env node
'use strict'
/** Reset + re-queue remaining Day 1 stuck visits via production API */
const { createCookieJar, fetchCsrfToken, apiFetch, sleep } = require('./lib/apiTestHelpers')

const REMAINING_IDS = [191, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395]
const BATCH_SIZE = 7
const BATCH_DELAY_MS = 30000
const ITEM_DELAY_MS = 2000
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

async function transcribeVisit(id, jar) {
  const csrf = await fetchCsrfToken(API_BASE, jar)
  const res = await fetch(`${API_BASE}/visits/${id}/transcribe`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...jar.headers(),
    },
    body: JSON.stringify({}),
  })
  jar.store(res)
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function main() {
  const jar = await login()
  const batches = []
  for (let i = 0; i < REMAINING_IDS.length; i += BATCH_SIZE) {
    batches.push(REMAINING_IDS.slice(i, i + BATCH_SIZE))
  }

  console.log('=== BATCH RE-QUEUE ===')
  console.log('Visits to re-queue:', REMAINING_IDS.length)
  console.log('Batches:', batches.length, '(size', BATCH_SIZE + ')')

  let queued = 0
  let errors = 0

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    console.log(`\n--- Batch ${b + 1}/${batches.length}: ${batch.join(',')} ---`)

    for (const id of batch) {
      try {
        const result = await transcribeVisit(id, jar)
        const tx = result.data?.transcription_status || result.data?.message || JSON.stringify(result.data)
        console.log(`  visit ${id}: HTTP ${result.status} → ${tx}`)
        if (result.status === 202 || result.status === 200) queued++
        else if (result.status === 429) {
          console.log('  Rate limited — waiting 60s...')
          await sleep(60000)
          const retry = await transcribeVisit(id, jar)
          console.log(`  retry visit ${id}: HTTP ${retry.status}`)
          if (retry.status === 202 || retry.status === 200) queued++
          else errors++
        } else {
          errors++
        }
      } catch (err) {
        console.error(`  visit ${id} ERROR:`, err.message)
        errors++
      }
      await sleep(ITEM_DELAY_MS)
    }

    if (b < batches.length - 1) {
      console.log(`Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`)
      await sleep(BATCH_DELAY_MS)
    }
  }

  console.log('\n=== RE-QUEUE SUMMARY ===')
  console.log('Queued/accepted:', queued, '/', REMAINING_IDS.length)
  console.log('Errors:', errors)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
