const fs = require('fs')
const path = require('path')
const { loadAiSettings, useDeepgram } = require('./aiSettings')
const { isReachableWebhookUrl } = require('../utils/webhookReachability')

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
  }
  return mimeTypes[ext] || null
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
  const { appendDeepgramVisitQuery } = require('../utils/webhookSignature')

  const apiKey = settings.deepgram_api_key
  if (!apiKey) return null

  const mimetype = getMimeTypeFromPath(absPath) || 'audio/webm'
  const model = settings.deepgram_model || 'nova-2-medical'
  const language = settings.deepgram_language || 'en-US'

  const queryParams = new URLSearchParams({
    model,
    language,
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
    filler_words: 'false',
    numerals: 'true',
  })

  // Async callback mode: Deepgram POSTs the result to our webhook for this visit
  const baseCallback = String(settings.deepgram_webhook_url || '').trim()
  const id = parseInt(String(visitId), 10)

  if (baseCallback && Number.isInteger(id) && isReachableWebhookUrl(baseCallback)) {
    const callbackUrl = appendDeepgramVisitQuery(baseCallback, id)
    if (callbackUrl) {
      queryParams.set('callback', callbackUrl)
    }
  }

  const url = `https://api.deepgram.com/v1/listen?${queryParams.toString()}`

  try {
    const audioBuffer = await fs.promises.readFile(absPath)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': mimetype,
      },
      body: audioBuffer,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      if (response.status === 401) {
        console.error('[aiTranscription] Deepgram auth failed - invalid/expired API key')
        console.error('[aiTranscription] FIX: Update API key in app.anot.health/settings')
      } else if (response.status === 429) {
        console.error('[aiTranscription] Deepgram rate limit - quota exceeded')
      } else {
        console.error('[aiTranscription] Deepgram API error:', response.status, response.statusText)
        console.error('[aiTranscription] Response:', errorText.slice(0, 500))
      }
      return null
    }

    const result = await response.json()

    // Callback mode returns a request_id; transcript arrives later via webhook
    if (result.request_id && queryParams.has('callback')) {
      const immediate = extractDeepgramText(result)
      if (immediate) return immediate
      return '__DEFERRED__'
    }

    return extractDeepgramText(result)
  } catch (error) {
    console.error('[aiTranscription] Network error:', error.message)
    return null
  }
}

/**
 * Transcribe a local file with Deepgram (primary and only transcription service).
 * @param {string} absPath
 * @param {object} [settingsOverride]
 * @param {number} [visitId] when set with Deepgram webhook URL, uses async callback for that visit
 * @returns {Promise<string|null>} transcript text, '__DEFERRED__' for webhook mode, or null
 */
async function transcribeFile(absPath, settingsOverride, visitId) {
  const settings = settingsOverride || (await loadAiSettings())

  // ONLY PATH: Deepgram (primary and only service)
  if (useDeepgram(settings)) {
    console.log('[aiTranscription] Starting transcription with Deepgram')
    try {
      const text = await transcribeWithDeepgram(absPath, settings, visitId)
      if (text === '__DEFERRED__') {
        console.log('[aiTranscription] Deepgram webhook callback pending')
        return text
      }
      if (text) {
        console.log('[aiTranscription] Transcription successful')
        return text
      }
      console.warn('[aiTranscription] Deepgram returned empty text')
      return null
    } catch (error) {
      console.error('[aiTranscription] Deepgram failed:', error.message)
      return null
    }
  }

  // No Deepgram configured - manual transcription required
  console.error('[aiTranscription] CRITICAL: Deepgram not configured')
  console.error('[aiTranscription] ACTION: Configure Deepgram API key in app.anot.health/settings')
  return null
}

module.exports = {
  transcribeFile,
  useDeepgram,
}
