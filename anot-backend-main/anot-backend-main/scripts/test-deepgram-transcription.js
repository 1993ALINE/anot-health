#!/usr/bin/env node
/**
 * Manual Deepgram transcription smoke test.
 * Usage: DEEPGRAM_API_KEY=... USE_DEEPGRAM=true node scripts/test-deepgram-transcription.js
 */
require('dotenv').config()
const path = require('path')
const { transcribeLocalFile } = require('../src/services/deepgramService')

async function main() {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    console.error('DEEPGRAM_API_KEY is required for this test.')
    process.exit(1)
  }

  const fixture = path.join(__dirname, '..', 'test-fixtures', 'deepgram', 'test-probe.wav')
  const settings = {
    transcribe_enabled: true,
    transcribe_language: 'en-US',
    deepgram_model: process.env.DEEPGRAM_MODEL || 'nova-3-medical',
    deepgram_api_key: apiKey,
    transcribe_show_speaker_labels: true,
    transcribe_timeout_ms: 120000,
  }

  console.log('[test] Transcribing', fixture)
  const text = await transcribeLocalFile(fixture, settings, 0, 0)
  if (!text || !String(text).trim()) {
    console.error('[test] FAILED — empty transcript')
    process.exit(1)
  }
  console.log('[test] SUCCESS — transcript length:', text.length)
  console.log('[test] Preview:', String(text).slice(0, 200))
  process.exit(0)
}

main().catch((err) => {
  console.error('[test] FAILED —', err.message)
  process.exit(1)
})
