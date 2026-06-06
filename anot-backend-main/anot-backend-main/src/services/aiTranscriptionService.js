const fs = require('fs')
const { loadAiSettings, useDeepgram } = require('./aiSettings')
const { isReachableWebhookUrl } = require('../utils/webhookReachability')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function extractDeepgramText(result) {
  if (!result) return null
  try {
    const ch = result?.results?.channels?.[0]
    const alt = ch?.alternatives?.[0]
    if (alt?.transcript != null) {
      const t = String(alt.transcript).trim()
      if (t) return t
    }
    const paras = alt?.paragraphs?.transcript
    if (paras) {
      const t = String(paras).trim()
      if (t) return t
    }
    const utt = result?.results?.utterances
    if (Array.isArray(utt) && utt.length) {
      const t = utt
        .map((u) => String(u?.transcript || u?.speech || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim()
      if (t) return t
    }
  } catch { /* */ }
  if (result?.err_msg != null) {
    console.warn('[aiTranscription] Deepgram err_msg:', String(result.err_msg).slice(0, 400))
  }
  return null
}

async function transcribeWithDeepgram(absPath, settings, visitId) {
  const { createClient } = require('@deepgram/sdk')
  const { appendDeepgramVisitQuery } = require('../utils/webhookSignature')
  const apiKey = settings.deepgram_api_key
  if (!apiKey) return null
  const client = createClient(apiKey)
  const opts = {
    model: 'nova-2-medical',
    smart_format: true,
    punctuate: true,
    diarize: true,
    utterances: true,
    language: 'en-US',
    filler_words: false,
    numerals: true,
  }
  const stream = fs.createReadStream(absPath)
  const baseCallback = String(settings.deepgram_webhook_url || '').trim()
  const id = parseInt(String(visitId), 10)
  if (baseCallback && Number.isInteger(id) && isReachableWebhookUrl(baseCallback)) {
    const callbackUrl = appendDeepgramVisitQuery(baseCallback, id)
    if (callbackUrl) {
      const callbackObj = { toString: () => callbackUrl }
      const { result, error } = await client.listen.prerecorded.transcribeFileCallback(stream, callbackObj, opts)
      if (error) {
        const msg = error.message || error.err_msg || JSON.stringify(error)
        throw new Error(String(msg).slice(0, 500))
      }
      const immediate = extractDeepgramText(result)
      if (immediate) return immediate
      return '__DEFERRED__'
    }
  }
  const { result, error } = await client.listen.prerecorded.transcribeFile(stream, opts)
  if (error) {
    const msg = error.message || error.err_msg || JSON.stringify(error)
    throw new Error(String(msg).slice(0, 500))
  }
  return extractDeepgramText(result)
}

/**
 * Transcribe a local file using Deepgram.
 * HIPAA-compliant: Only uses Deepgram (BAA-covered service).
 * @param {string} absPath
 * @param {object} [settingsOverride]
 * @param {number} [visitId] when set with Deepgram webhook URL, uses async callback for that visit
 */
async function transcribeFile(absPath, settingsOverride, visitId) {
  const settings = settingsOverride || (await loadAiSettings())
  if (useDeepgram(settings)) {
    const text = await transcribeWithDeepgram(absPath, settings, visitId)
    if (text) return text
    console.warn('[Transcription] Deepgram returned no text - manual transcription required')
    return null
  }
  console.warn('[aiTranscription] Deepgram not configured - manual transcription required')
  return null
}

async function transcribeFileWithRetries(absPath, settingsOverride, maxAttempts = 3, visitId) {
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await transcribeFile(absPath, settingsOverride, visitId)
      if (text === '__DEFERRED__') return '__DEFERRED__'
      if (text) return text
      lastErr = new Error('empty transcript')
    } catch (e) {
      lastErr = e
      console.warn(`[aiTranscription] attempt ${attempt}/${maxAttempts} failed:`, e.message)
    }
    if (attempt < maxAttempts) await sleep(400 * attempt * attempt)
  }
  if (lastErr) console.error('[aiTranscription] giving up:', lastErr.message)
  return null
}

module.exports = {
  transcribeFile,
  transcribeFileWithRetries,
  useDeepgram,
}
