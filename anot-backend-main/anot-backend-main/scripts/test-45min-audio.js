#!/usr/bin/env node
'use strict'

/**
 * Test 45-minute audio upload + Deepgram transcription end-to-end.
 *
 * Usage:
 *   node scripts/generate-deepgram-test-audio.js   # includes test-45min.wav
 *   node scripts/test-45min-audio.js [--api=URL] [--file=path] [--skip-upload]
 *
 * Env:
 *   API_BASE — default https://app.anot.health/api
 *   CLINICIAN_EMAIL / CLINICIAN_PASSWORD — login (defaults from final-e2e)
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  sleep,
  createCookieJar,
  fetchCsrfToken,
  apiMutate,
} = require('./lib/apiTestHelpers')
const { calculateTranscribeTimeout, resolveTranscribeTimeoutMs } = require('../src/services/deepgramService')

const API_BASE = (process.env.API_BASE || 'https://app.anot.health/api').replace(/\/+$/, '')
const DEFAULT_AUDIO = path.join(__dirname, '..', 'test-fixtures', 'deepgram', 'test-45min.wav')
const REPORT_PATH = path.join(__dirname, '..', 'test-fixtures', 'deepgram', 'test-45min-results.txt')

const CREDS = {
  email: process.env.CLINICIAN_EMAIL || 'nahid@anot.health',
  password: process.env.CLINICIAN_PASSWORD || '#1Knowtex2026',
}

function parseArgs(argv) {
  const opts = { file: DEFAULT_AUDIO, skipUpload: false, api: API_BASE }
  for (const arg of argv) {
    if (arg.startsWith('--file=')) opts.file = arg.slice(7)
    else if (arg.startsWith('--api=')) opts.api = arg.slice(6).replace(/\/+$/, '')
    else if (arg === '--skip-upload') opts.skipUpload = true
  }
  return opts
}

function formatBytes(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

function memSnapshot() {
  const u = process.memoryUsage()
  return {
    rss_mb: (u.rss / (1024 * 1024)).toFixed(1),
    heap_mb: (u.heapUsed / (1024 * 1024)).toFixed(1),
  }
}

function appendReport(lines) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.appendFileSync(REPORT_PATH, lines.join('\n') + '\n')
}

async function login(apiBase, email, password) {
  const jar = createCookieJar()
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const csrf = await fetchCsrfToken(apiBase, jar)
      const res = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...jar.headers() },
        body: JSON.stringify({ email, password }),
      })
      jar.store(res)
      const data = await res.json()

      if (data.requirePhiTraining && data.temporaryToken) {
        const csrf2 = await fetchCsrfToken(apiBase, jar)
        const ack = await fetch(`${apiBase}/auth/acknowledge-phi-training`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf2, ...jar.headers() },
          body: JSON.stringify({ temporaryToken: data.temporaryToken }),
        })
        jar.store(ack)
        const ackData = await ack.json()
        if (!ack.ok || !ackData.user) throw new Error(ackData.error || 'PHI training ack failed')
        await fetchCsrfToken(apiBase, jar)
        return { jar, user: ackData.user }
      }

      if (!data.user) throw new Error(data.error || `Login failed (${res.status})`)
      await fetchCsrfToken(apiBase, jar)
      return { jar, user: data.user }
    } catch (err) {
      if (/429|rate/i.test(err.message) && attempt < 6) {
        await sleep(12 * attempt * 1000)
        continue
      }
      throw err
    }
  }
}

async function createTestVisit(apiBase, jar) {
  const today = new Date().toISOString().slice(0, 10)
  const nowTime = new Date().toTimeString().slice(0, 5)
  const csrf = await fetchCsrfToken(apiBase, jar)
  const patientBody = {
    name: '45-Min Audio Test',
    mrn: `45MIN-${Date.now().toString(36).slice(-6).toUpperCase()}`,
    date_of_birth: '1985-06-15',
  }
  let patientId
  try {
    const pRes = await apiMutate(apiBase, 'POST', '/patients', { jar, csrf, body: patientBody })
    patientId = pRes.patient?.id || pRes.id
  } catch (err) {
    if (err.status !== 409) throw err
    const all = await fetch(`${apiBase}/patients`, { headers: jar.headers() })
    jar.store(all)
    const data = await all.json()
    const existing = (data.patients || []).find((x) => x.mrn === patientBody.mrn.toUpperCase())
    if (!existing) throw err
    patientId = existing.id
  }

  const visitRes = await apiMutate(apiBase, 'POST', '/visits', {
    jar,
    csrf: await fetchCsrfToken(apiBase, jar),
    body: {
      patient_id: patientId,
      visit_date: today,
      visit_time: nowTime,
      visit_type: 'Follow-up',
    },
  })
  const visitId = visitRes.visit?.id || visitRes.id
  try {
    await apiMutate(apiBase, 'POST', '/consent/recording', {
      jar,
      csrf: await fetchCsrfToken(apiBase, jar),
      body: { visitId },
    })
  } catch (e) {
    if (!/already|recorded/i.test(e.message)) throw e
  }
  return { visitId, patientId }
}

async function uploadAudio(apiBase, jar, visitId, filePath) {
  const stat = fs.statSync(filePath)
  const form = new FormData()
  const blob = new Blob([fs.readFileSync(filePath)], { type: 'audio/wav' })
  form.append('audio', blob, path.basename(filePath))

  const csrf = await fetchCsrfToken(apiBase, jar)
  const memBefore = memSnapshot()
  const t0 = Date.now()

  const res = await fetch(`${apiBase}/audio/${visitId}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-CSRF-Token': csrf, ...jar.headers() },
    body: form,
  })
  jar.store(res)
  const elapsed = Date.now() - t0
  const memAfter = memSnapshot()
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }

  return {
    ok: res.ok,
    status: res.status,
    data,
    elapsedMs: elapsed,
    uploadSpeedMbps: ((stat.size * 8) / (elapsed / 1000) / 1e6).toFixed(2),
    memBefore,
    memAfter,
    fileSize: stat.size,
  }
}

async function pollTranscription(apiBase, jar, visitId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs
  const interval = 10000
  let lastStatus = 'unknown'

  while (Date.now() < deadline) {
    const res = await fetch(`${apiBase}/visits`, { headers: jar.headers() })
    jar.store(res)
    const data = await res.json().catch(() => ({}))
    const visit = (data.visits || []).find((v) => v.id === visitId)
    lastStatus = visit?.transcription_status || 'unknown'
    const elapsed = formatDuration((Date.now() - (deadline - maxWaitMs)) / 1000)
    process.stdout.write(`\r  status=${lastStatus} audio=${visit?.audio_file ? 'yes' : 'no'} elapsed=${elapsed}`)

    if (lastStatus === 'completed') {
      const noteRes = await fetch(`${apiBase}/notes/visit/${visitId}`, { headers: jar.headers() })
      jar.store(noteRes)
      const noteData = await noteRes.json().catch(() => ({}))
      const note = noteData?.note ?? noteData
      return { status: 'completed', visit, note }
    }
    if (lastStatus === 'failed') {
      return { status: 'failed', visit, error: 'transcription_status=failed' }
    }
    await sleep(interval)
  }

  return { status: 'timeout', lastStatus }
}

async function probeDeepgramDirect(filePath) {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) return { skipped: true, reason: 'DEEPGRAM_API_KEY not set' }

  const stat = fs.statSync(filePath)
  const sizeMb = stat.size / (1024 * 1024)
  const timeoutSec = Math.ceil(calculateTranscribeTimeout(sizeMb) / 1000)

  const t0 = Date.now()
  try {
    const buffer = fs.readFileSync(filePath)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (timeoutSec + 60) * 1000)

    const res = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3-medical&language=en-US&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: buffer,
        signal: controller.signal,
      },
    )
    clearTimeout(timer)
    const body = await res.json().catch(() => ({}))
    const transcript = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
    return {
      skipped: false,
      httpStatus: res.status,
      elapsedSec: ((Date.now() - t0) / 1000).toFixed(1),
      timeoutSec,
      transcriptLen: transcript.length,
      error: body?.err_msg || body?.message || null,
    }
  } catch (err) {
    return {
      skipped: false,
      error: err.message,
      elapsedSec: ((Date.now() - t0) / 1000).toFixed(1),
      timeoutSec,
    }
  }
}

function documentSystemLimits(fileStat) {
  const sizeMb = fileStat.size / (1024 * 1024)
  const durationSec = 45 * 60
  const lines = [
    '',
    '=== SYSTEM LIMITS AUDIT ===',
    `Node.js heap (this process): ${memSnapshot().heap_mb} MB used / ${(os.totalmem() / 1e9).toFixed(1)} GB system RAM`,
    `Backend REQUEST_TIMEOUT (upload socket): ${process.env.REQUEST_TIMEOUT || '600000 (default 10 min)'} ms`,
    `Backend DEEPGRAM_TIMEOUT_MS: ${process.env.DEEPGRAM_TIMEOUT_MS || '1800000 (default 30 min)'} ms`,
    `Backend TRANSCRIPTION_STUCK_MS: ${process.env.TRANSCRIPTION_STUCK_MS || '1800000 (default 30 min)'} ms`,
    `Backend FFMPEG_MAX_UPLOAD_MB: ${process.env.FFMPEG_MAX_UPLOAD_MB || '500 (default)'}`,
    `Frontend MAX_AUDIO_UPLOAD_BYTES: 500 MB (audioUpload.js)`,
    `Frontend MAX_POLL_WAIT_MS: 1800000 (30 min default)`,
    `Nginx client_max_body_size: 500m`,
    `Calculated transcribe timeout for ${sizeMb.toFixed(1)} MB: ${calculateTranscribeTimeout(sizeMb)} ms (${formatDuration(calculateTranscribeTimeout(sizeMb) / 1000)})`,
    `resolveTranscribeTimeoutMs (empty settings): ${resolveTranscribeTimeoutMs({}, fileStat.size)} ms`,
    `Estimated Deepgram cost (45 min @ $0.004/min): $${(45 * 0.004).toFixed(2)}`,
    `Test file: ${formatBytes(fileStat.size)}, ~${durationSec / 60} min`,
  ]
  return lines
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const apiBase = opts.api

  if (!fs.existsSync(opts.file)) {
    console.error('Missing audio file:', opts.file)
    console.error('Run: node scripts/generate-deepgram-test-audio.js')
    process.exit(1)
  }

  const stat = fs.statSync(opts.file)
  const report = []
  const log = (msg) => {
    console.log(msg)
    report.push(`[${new Date().toISOString()}] ${msg}`)
  }

  fs.writeFileSync(REPORT_PATH, `# 45-Minute Audio Test Report\nStarted: ${new Date().toISOString()}\nAPI: ${apiBase}\nFile: ${opts.file}\n`)

  log('=== PART 1: DEEPGRAM LIMITS (documented) ===')
  log('Max file size: 2048 MB (2 GB)')
  log('Max duration: No hard limit (processing timeout ~10 min for Nova models per Deepgram docs)')
  log('Max concurrent jobs: 100 per project (Nova/Base/Enhanced)')
  log('Client timeout: Recommend file_length_seconds + 300s buffer')
  log('Cost: $0.004/min (Nova-3 Medical estimate)')
  log(`45-min file: ${formatBytes(stat.size)}, cost ~$${(45 * 0.004).toFixed(2)}`)

  log('')
  log('=== PART 2: SYSTEM LIMITS ===')
  for (const line of documentSystemLimits(stat)) log(line)

  log('')
  log('=== PART 3: DIRECT DEEPGRAM PROBE (optional) ===')
  const dgProbe = await probeDeepgramDirect(opts.file)
  log(JSON.stringify(dgProbe, null, 2))

  if (opts.skipUpload) {
    log('Skipping upload (--skip-upload)')
    appendReport(report)
    return
  }

  log('')
  log('=== PART 3b: PRODUCTION UPLOAD TEST ===')
  log(`Logging in as ${CREDS.email}...`)
  const { jar, user } = await login(apiBase, CREDS.email, CREDS.password)
  log(`Logged in: ${user.name} (${user.role})`)

  log('Creating test visit...')
  const { visitId } = await createTestVisit(apiBase, jar)
  if (!visitId) throw new Error('Visit creation failed')
  log(`Visit created: id=${visitId}`)

  log(`Uploading ${path.basename(opts.file)} (${formatBytes(stat.size)})...`)
  const upload = await uploadAudio(apiBase, jar, visitId, opts.file)
  log(`Upload result: HTTP ${upload.status} in ${formatDuration(upload.elapsedMs / 1000)} (${upload.uploadSpeedMbps} Mbps)`)
  log(`Memory: before rss=${upload.memBefore.rss_mb}MB heap=${upload.memBefore.heap_mb}MB → after rss=${upload.memAfter.rss_mb}MB heap=${upload.memAfter.heap_mb}MB`)
  if (!upload.ok) {
    log(`Upload FAILED: ${JSON.stringify(upload.data)}`)
    appendReport(report)
    process.exit(1)
  }
  log(`S3 path: ${upload.data?.audio_file || '(see response)'}`)

  log('')
  log('=== PART 4: TRANSCRIPTION POLL ===')
  const maxWait = resolveTranscribeTimeoutMs({}, stat.size)
  log(`Polling up to ${formatDuration(maxWait / 1000)}...`)
  const tx = await pollTranscription(apiBase, jar, visitId, maxWait)
  console.log('')
  log(`Transcription result: ${tx.status}`)
  if (tx.note?.transcription) {
    log(`Transcript preview: ${tx.note.transcription.slice(0, 200)}...`)
    log(`Transcript length: ${tx.note.transcription.length} chars`)
  }
  if (tx.error) log(`Error: ${tx.error}`)

  log('')
  log('=== PART 6: SUMMARY ===')
  const passed = upload.ok && (tx.status === 'completed' || tx.status === 'processing')
  log(`Upload: ${upload.ok ? 'PASS' : 'FAIL'}`)
  log(`Transcription: ${tx.status}`)
  log(`Overall: ${passed ? 'PASS (or in-progress)' : 'NEEDS FIX'}`)
  log(`Visit ID for manual check: ${visitId}`)

  appendReport(report)
  console.log(`\nReport written to ${REPORT_PATH}`)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  appendReport([`FATAL: ${err.message}`])
  process.exit(1)
})
