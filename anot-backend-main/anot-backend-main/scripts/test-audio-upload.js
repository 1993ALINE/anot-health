#!/usr/bin/env node
'use strict'

/**
 * Simulate Clinician portal audio upload + transcription pipeline.
 *
 * Usage:
 *   node scripts/test-audio-upload.js
 *   node scripts/test-audio-upload.js --duration=600 --confirm
 *
 * Env:
 *   API_BASE=http://localhost:5000/api  (default)
 *   TEST_EMAIL=clinician@dev.anot.local
 *   TEST_PASSWORD=DevClinician!2026
 *   TEST_VISIT_ID=123   (optional — creates a visit if unset)
 */

require('dotenv').config()

const { sleep, createCookieJar, apiLogin, apiMutate, apiFetch, fetchCsrfToken } = require('./lib/apiTestHelpers')

function parseArgs(argv) {
  const opts = {
    duration: 30,
    confirm: false,
    visitId: process.env.TEST_VISIT_ID ? parseInt(process.env.TEST_VISIT_ID, 10) : null,
  }
  for (const arg of argv) {
    if (arg === '--confirm') opts.confirm = true
    else if (arg.startsWith('--duration=')) {
      opts.duration = Math.max(1, parseInt(arg.slice(11), 10) || 30)
    } else if (arg.startsWith('--visit=')) {
      opts.visitId = parseInt(arg.slice(8), 10)
    }
  }
  return opts
}

function buildSilentWav(durationSeconds, sampleRate = 16000) {
  const numSamples = Math.floor(sampleRate * durationSeconds)
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

async function ensureVisit(apiBase, token, jar, visitId) {
  if (visitId) return visitId

  const patients = await apiFetch(apiBase, '/patients', { token, jar }).catch(() => null)
  let patientId = patients?.patients?.[0]?.id

  if (!patientId) {
    const created = await apiMutate(apiBase, 'POST', '/patients', {
      token,
      jar,
      body: {
        name: 'Upload Test Patient',
        mrn: `TEST${Date.now().toString().slice(-6)}`,
      },
    })
    patientId = created.patient.id
  }

  const today = new Date().toISOString().slice(0, 10)
  const visit = await apiMutate(apiBase, 'POST', '/visits', {
    token,
    jar,
    body: {
      patient_id: patientId,
      visit_date: today,
      visit_time: '09:00',
      visit_type: 'Follow-up',
    },
  })
  return visit.visit.id
}

async function pollTranscription(apiBase, token, jar, visitId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const noteRes = await fetch(`${apiBase}/notes/visit/${visitId}`, {
      headers: { Authorization: `Bearer ${token}`, ...jar.headers() },
    })
    if (noteRes.ok) {
      const data = await noteRes.json()
      const note = data.note
      const txSt = note?.transcription_status
      const hasTx = note?.transcription && note.transcription !== 'null'
      const hasDraft = note?.ai_draft && String(note.ai_draft).trim().length > 0
      console.log(`  poll: transcription_status=${txSt || 'unknown'} tx=${hasTx ? 'yes' : 'no'} draft=${hasDraft ? 'yes' : 'no'}`)
      if (txSt === 'completed' && hasTx) {
        return { ok: true, note, hasDraft }
      }
      if (txSt === 'failed') {
        return { ok: false, note, error: 'transcription_status=failed' }
      }
    }
    await sleep(3000)
  }
  return { ok: false, error: 'timeout waiting for transcription' }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const apiBase = (process.env.API_BASE || 'http://localhost:5000/api').replace(/\/+$/, '')
  const email = process.env.TEST_EMAIL || 'clinician@dev.anot.local'
  const password = process.env.TEST_PASSWORD || 'DevClinician!2026'
  const isProd = /anot\.health/i.test(apiBase)

  if (isProd && !opts.confirm) {
    console.error('Production API blocked: pass --confirm to run against app.anot.health')
    process.exit(1)
  }

  console.log(`=== Audio upload test (${opts.duration}s WAV) ===`)
  console.log(`API: ${apiBase}`)

  const jar = createCookieJar()
  const { token } = await apiLogin(apiBase, email, password, jar)
  console.log(`Logged in as ${email}`)

  const visitId = await ensureVisit(apiBase, token, jar, opts.visitId)
  console.log(`Visit ID: ${visitId}`)

  const wav = buildSilentWav(opts.duration)
  console.log(`Generated mock audio: ${Math.round(wav.length / (1024 * 1024))} MB`)

  const form = new FormData()
  const blob = new Blob([wav], { type: 'audio/wav' })
  form.append('audio', blob, `test_visit_${visitId}_${Date.now()}.wav`)

  console.log('Uploading audio…')
  const upload = await apiMutate(apiBase, 'POST', `/audio/${visitId}`, { token, jar, body: form })
  console.log(`Upload OK (${upload.size} bytes, transcription_queued=${upload.transcription_queued})`)

  if (!upload.transcription_queued) {
    console.log('Triggering transcription via POST /visits/:id/transcribe …')
    const csrf = await fetchCsrfToken(apiBase, jar)
    await apiMutate(apiBase, 'POST', `/visits/${visitId}/transcribe`, { token, jar, csrf, body: {} })
  }

  const timeoutMs = Math.max(60000, opts.duration * 1000 + 30000)
  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)}s for transcription…`)
  const result = await pollTranscription(apiBase, token, jar, visitId, timeoutMs)

  const sections = {
    transcription: !!(result.note?.transcription && result.note.transcription !== 'null'),
    aiDraft: !!(result.note?.ai_draft && String(result.note.ai_draft).trim()),
    finalNote: !!(result.note?.final_note && String(result.note.final_note).trim()),
  }

  console.log('\nNote sections:')
  console.log(`  Transcription: ${sections.transcription ? '✓' : '✗'}`)
  console.log(`  AI Draft:      ${sections.aiDraft ? '✓' : '✗'}`)
  console.log(`  Final Note:    ${sections.finalNote ? '(empty — expected until scribe edits)' : '(empty — expected until scribe edits)'}`)

  if (result.ok && sections.transcription && sections.aiDraft) {
    console.log('\n✅ Upload successful, transcription completed, AI draft generated')
    process.exit(0)
  }

  console.error(`\n❌ Test failed: ${result.error || 'missing transcription or AI draft'}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('Test failed:', err.message)
  if (err.status) console.error('HTTP status:', err.status)
  if (err.payload) console.error('Payload:', JSON.stringify(err.payload).slice(0, 300))
  process.exit(1)
})
