#!/usr/bin/env node
'use strict'

/**
 * List and re-queue transcription for visits with transcription_status = 'failed'.
 *
 * Two modes:
 *   db  (default) — query PostgreSQL and run runAIPipeline directly (needs DATABASE_URL)
 *   api           — call POST /api/visits/:id/transcribe (needs network + credentials)
 *
 * Usage:
 *   node scripts/retranscribe-failed.js --list
 *   node scripts/retranscribe-failed.js --list --mode=api
 *   node scripts/retranscribe-failed.js --run --dry-run
 *   node scripts/retranscribe-failed.js --run --confirm
 *   node scripts/retranscribe-failed.js --run --ids=81,80 --confirm
 *   node scripts/retranscribe-failed.js --run --mode=api --confirm
 *
 * API mode env:
 *   API_BASE=https://app.anot.health/api
 *   RETRANSCRIBE_EMAIL=shahib@anot.health
 *   RETRANSCRIBE_PASSWORD=...
 *
 * Options:
 *   --delay=8000     ms between visits (default 8000)
 *   --timeout=120000 ms to wait per visit in api mode (default 120000)
 */

const path = require('path')

function parseArgs(argv) {
  const opts = {
    list: false,
    run: false,
    dryRun: false,
    confirm: false,
    mode: 'db',
    ids: null,
    delay: 8000,
    timeout: 120000,
  }
  for (const arg of argv) {
    if (arg === '--list') opts.list = true
    else if (arg === '--run') opts.run = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--confirm') opts.confirm = true
    else if (arg === '--mode=api') opts.mode = 'api'
    else if (arg === '--mode=db') opts.mode = 'db'
    else if (arg.startsWith('--ids=')) {
      opts.ids = arg.slice(6).split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger)
    } else if (arg.startsWith('--delay=')) {
      opts.delay = Math.max(0, parseInt(arg.slice(8), 10) || 8000)
    } else if (arg.startsWith('--timeout=')) {
      opts.timeout = Math.max(1000, parseInt(arg.slice(10), 10) || 120000)
    }
  }
  if (!opts.list && !opts.run) opts.list = true
  return opts
}

function assertProductionAllowed(opts) {
  const isProd = process.env.NODE_ENV === 'production' || process.env.USE_SSM === 'true'
  if ((opts.run && !opts.dryRun) && isProd && !opts.confirm) {
    console.error('Production run blocked: pass --confirm to re-transcribe failed visits.')
    process.exit(1)
  }
}

function formatVisitRow(row) {
  return {
    id: row.id,
    clinician_id: row.clinician_id,
    audio_file: row.audio_file,
    status: row.status,
    transcription_status: row.transcription_status,
    created_at: row.created_at,
  }
}

async function listFailedFromDb(ids) {
  const pool = require('../src/config/db')
  const params = []
  let where = `transcription_status = 'failed'`
  if (ids?.length) {
    params.push(ids)
    where += ` AND id = ANY($${params.length}::int[])`
  }
  const { rows } = await pool.query(
    `SELECT id, clinician_id, audio_file, status, transcription_status, created_at
       FROM visits
      WHERE ${where}
        AND audio_file IS NOT NULL
        AND TRIM(audio_file) <> ''
      ORDER BY created_at DESC`,
    params,
  )
  return rows.map(formatVisitRow)
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchCsrfToken(apiBase, cookieJar) {
  const res = await fetch(`${apiBase}/csrf-token`, {
    credentials: 'include',
    headers: cookieJar.headers(),
  })
  if (!res.ok) throw new Error(`CSRF fetch failed: ${res.status}`)
  const data = await res.json()
  cookieJar.store(res)
  return data.csrfToken
}

async function apiLogin(apiBase, email, password, cookieJar) {
  const csrf = await fetchCsrfToken(apiBase, cookieJar)
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...cookieJar.headers(),
    },
    body: JSON.stringify({ email, password }),
  })
  cookieJar.store(res)
  const data = await res.json()
  if (!res.ok || !data.token) {
    throw new Error(data.error || `Login failed (${res.status})`)
  }
  return { token: data.token, csrf: await fetchCsrfToken(apiBase, cookieJar) }
}

function createCookieJar() {
  const cookies = new Map()
  return {
    store(res) {
      const raw = res.headers.getSetCookie?.() || []
      for (const line of raw) {
        const part = line.split(';')[0]
        const eq = part.indexOf('=')
        if (eq > 0) cookies.set(part.slice(0, eq), part.slice(eq + 1))
      }
    },
    headers() {
      if (cookies.size === 0) return {}
      return { Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
    },
  }
}

async function listFailedFromApi(ids) {
  const apiBase = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
  const email = process.env.RETRANSCRIBE_EMAIL || process.env.SCRIBE_EMAIL
  const password = process.env.RETRANSCRIBE_PASSWORD || process.env.SCRIBE_PASSWORD
  if (!email || !password) {
    throw new Error('Set RETRANSCRIBE_EMAIL and RETRANSCRIBE_PASSWORD (or SCRIBE_EMAIL / SCRIBE_PASSWORD) for API mode.')
  }

  const jar = createCookieJar()
  const { token } = await apiLogin(apiBase, email, password, jar)
  const res = await fetch(`${apiBase}/visits`, {
    headers: { Authorization: `Bearer ${token}`, ...jar.headers() },
  })
  if (!res.ok) throw new Error(`GET /visits failed: ${res.status}`)
  const data = await res.json()
  let failed = (data.visits || []).filter((v) => v.transcription_status === 'failed' && v.audio_file)
  if (ids?.length) failed = failed.filter((v) => ids.includes(v.id))
  failed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  return failed.map((v) => formatVisitRow({
    id: v.id,
    clinician_id: v.clinician_id,
    audio_file: v.audio_file,
    status: v.status,
    transcription_status: v.transcription_status,
    created_at: v.created_at,
  }))
}

function printVisitList(rows) {
  console.log(`\nFailed transcriptions: ${rows.length}\n`)
  console.log('id\tclinician_id\tstatus\t\t\taudio_file')
  console.log('─'.repeat(100))
  for (const v of rows) {
    const audio = String(v.audio_file || '').replace(/\n/g, ' ')
    const preview = audio.length > 70 ? `${audio.slice(0, 67)}...` : audio
    console.log(`${v.id}\t${v.clinician_id}\t${v.status || ''}\t${preview}`)
  }
  console.log('')
}

async function runPipelineForVisit(visitId) {
  const { runAIPipeline } = require('../src/utils/aiPipeline')
  const pool = require('../src/config/db')
  const { setVisitTranscriptionStatus } = require('../src/utils/visitSchemaCompat')

  await setVisitTranscriptionStatus(visitId, 'idle')
  await runAIPipeline(visitId, {
    user: { id: 0, name: 'retranscribe-failed script', role: 'admin' },
    completionMessage: 'Re-transcription via retranscribe-failed script',
  })

  const { rows } = await pool.query(
    'SELECT transcription_status, status FROM visits WHERE id = $1',
    [visitId],
  )
  return rows[0] || {}
}

async function runViaDb(rows, opts) {
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]
    console.log(`[${i + 1}/${rows.length}] Visit ${v.id} — queuing pipeline...`)
    if (opts.dryRun) continue

    const result = await runPipelineForVisit(v.id)
    console.log(`  → transcription_status=${result.transcription_status} visit_status=${result.status}`)

    if (i < rows.length - 1 && opts.delay > 0) {
      await sleep(opts.delay)
    }
  }
}

async function transcribeViaApi(visitId, apiBase, auth, jar) {
  const csrf = await fetchCsrfToken(apiBase, jar)
  const res = await fetch(`${apiBase}/visits/${visitId}/transcribe`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'X-CSRF-Token': csrf,
      ...jar.headers(),
    },
    body: '{}',
  })
  if (!res.ok && res.status !== 202) {
    const body = await res.text()
    throw new Error(`POST /visits/${visitId}/transcribe → ${res.status}: ${body.slice(0, 200)}`)
  }
}

async function pollVisitStatus(visitId, apiBase, auth, jar, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${apiBase}/visits`, {
      headers: { Authorization: `Bearer ${auth.token}`, ...jar.headers() },
    })
    if (res.ok) {
      const data = await res.json()
      const visit = (data.visits || []).find((v) => v.id === visitId)
      if (visit && visit.transcription_status !== 'processing') {
        return visit
      }
    }
    await sleep(3000)
  }
  return { transcription_status: 'timeout' }
}

async function runViaApi(rows, opts) {
  const apiBase = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
  const email = process.env.RETRANSCRIBE_EMAIL || process.env.SCRIBE_EMAIL
  const password = process.env.RETRANSCRIBE_PASSWORD || process.env.SCRIBE_PASSWORD
  const jar = createCookieJar()
  const auth = await apiLogin(apiBase, email, password, jar)

  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]
    console.log(`[${i + 1}/${rows.length}] Visit ${v.id} — POST /transcribe...`)
    if (opts.dryRun) continue

    await transcribeViaApi(v.id, apiBase, auth, jar)
    const updated = await pollVisitStatus(v.id, apiBase, auth, jar, opts.timeout)
    console.log(`  → transcription_status=${updated.transcription_status} visit_status=${updated.status || ''}`)

    if (i < rows.length - 1 && opts.delay > 0) {
      await sleep(opts.delay)
    }
  }
}

async function bootstrapDb() {
  const loadSecrets = require('../src/config/loadSecrets')
  await loadSecrets()
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  assertProductionAllowed(opts)

  if (opts.mode === 'db') {
    await bootstrapDb()
  }

  const listFn = opts.mode === 'api' ? listFailedFromApi : listFailedFromDb
  const rows = await listFn(opts.ids)

  printVisitList(rows)

  if (!opts.run) {
    console.log('List only. Pass --run --confirm to re-transcribe.')
    process.exit(0)
  }

  if (rows.length === 0) {
    console.log('No failed visits to process.')
    process.exit(0)
  }

  if (opts.dryRun) {
    console.log(`Dry run: would re-transcribe ${rows.length} visit(s) via ${opts.mode} mode.`)
    process.exit(0)
  }

  console.log(`Re-transcribing ${rows.length} visit(s) via ${opts.mode} mode (delay ${opts.delay}ms)...\n`)

  if (opts.mode === 'api') {
    await runViaApi(rows, opts)
  } else {
    await runViaDb(rows, opts)
  }

  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
