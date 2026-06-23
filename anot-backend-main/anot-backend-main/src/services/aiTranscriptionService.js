const fs = require('fs')
const path = require('path')
const { loadAiSettings, useDeepgram } = require('./aiSettings')
const { isReachableWebhookUrl } = require('../utils/webhookReachability')

// Bound every Deepgram HTTP call so a stalled connection can't hang the
// transcription pipeline (and block the clinician) indefinitely. 30s is ample
// for callback/async mode (Deepgram returns a request_id almost immediately);
// override with settings.deepgram_timeout_ms for long sync transcriptions.
const DEEPGRAM_TIMEOUT_MS = 30000

// Retry transient failures (HTTP 429 rate limits, 5xx, timeouts/network blips)
// with exponential backoff. Non-transient failures (401 auth, 400 bad request)
// are never retried.
const DEEPGRAM_MAX_ATTEMPTS = 3
const DEEPGRAM_BACKOFF_BASE_MS = 500
const DEEPGRAM_BACKOFF_MAX_MS = 8000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** fetch() with an AbortController timeout. Rejects with a tagged error on timeout. */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`Deepgram request timed out after ${timeoutMs}ms`)
      e.isTimeout = true
      throw e
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Backoff delay before the next retry. Honors a Retry-After header (seconds or
 * HTTP-date) when present, otherwise uses exponential backoff with jitter.
 * @param {number} attempt 1-based attempt number that just failed
 * @param {Response|null} response the failed response (for Retry-After)
 */
function backoffDelayMs(attempt, response) {
  const retryAfter = response?.headers?.get?.('retry-after')
  if (retryAfter != null && retryAfter !== '') {
    const asSeconds = Number(retryAfter)
    if (Number.isFinite(asSeconds)) {
      return Math.min(Math.max(asSeconds, 0) * 1000, DEEPGRAM_BACKOFF_MAX_MS)
    }
    const asDate = Date.parse(retryAfter)
    if (Number.isFinite(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), DEEPGRAM_BACKOFF_MAX_MS)
    }
  }
  const exponential = DEEPGRAM_BACKOFF_BASE_MS * 2 ** (attempt - 1)
  const jitter = Math.floor(Math.random() * DEEPGRAM_BACKOFF_BASE_MS)
  return Math.min(exponential + jitter, DEEPGRAM_BACKOFF_MAX_MS)
}

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

/**
 * Build Deepgram query parameters including optional webhook callback
 */
function buildDeepgramQueryParams(settings, visitId) {
  const { appendDeepgramVisitQuery } = require('../utils/webhookSignature')

  const queryParams = new URLSearchParams({
    model: settings.deepgram_model || 'nova-2-medical',
    language: settings.deepgram_language || 'en-US',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    utterances: 'true',
    filler_words: 'false',
    numerals: 'true',
  })

  const baseCallback = String(settings.deepgram_webhook_url || '').trim()
  const id = parseInt(String(visitId), 10)
  if (baseCallback && Number.isInteger(id) && isReachableWebhookUrl(baseCallback)) {
    const callbackUrl = appendDeepgramVisitQuery(baseCallback, id)
    if (callbackUrl) queryParams.set('callback', callbackUrl)
  }

  return queryParams
}

/**
 * Load audio file into buffer for transcription
 */
async function loadAudioBufferForTranscription(absPath) {
  try {
    return await fs.promises.readFile(absPath)
  } catch (error) {
    console.error('[aiTranscription] Failed to read audio file:', error.message)
    return null
  }
}

/**
 * Build fetch options for Deepgram API
 */
function buildDeepgramFetchOptions(apiKey, mimetype, audioBuffer) {
  return {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': mimetype,
    },
    body: audioBuffer,
  }
}

/**
 * Resolve Deepgram HTTP timeout from settings
 */
function resolveDeepgramTimeoutMs(settings) {
  return Number(settings.deepgram_timeout_ms) > 0
    ? Number(settings.deepgram_timeout_ms)
    : DEEPGRAM_TIMEOUT_MS
}

/**
 * Handle non-OK Deepgram response with retry logic
 */
async function handleDeepgramErrorResponse(response, attempt, errorText) {
  if (response.status === 401) {
    console.error('[aiTranscription] Deepgram auth failed - invalid/expired API key')
    console.error('[aiTranscription] FIX: Update API key in app.anot.health/settings')
    return { action: 'abort' }
  }

  const transient = response.status === 429 || response.status >= 500
  if (transient && attempt < DEEPGRAM_MAX_ATTEMPTS) {
    const delay = backoffDelayMs(attempt, response)
    const reason = response.status === 429 ? 'rate limit (429)' : `server error (${response.status})`
    console.warn(`[aiTranscription] Deepgram ${reason} - retrying in ${delay}ms (attempt ${attempt}/${DEEPGRAM_MAX_ATTEMPTS})`)
    await sleep(delay)
    return { action: 'retry' }
  }

  if (response.status === 429) {
    console.error('[aiTranscription] Deepgram rate limit - quota exceeded (retries exhausted)')
  } else {
    console.error('[aiTranscription] Deepgram API error:', response.status, response.statusText)
    console.error('[aiTranscription] Response:', errorText.slice(0, 500))
  }
  return { action: 'abort' }
}

/**
 * Parse Deepgram JSON result (sync or deferred callback mode)
 */
function parseDeepgramApiResult(result, queryParams) {
  if (result.request_id && queryParams.has('callback')) {
    const immediate = extractDeepgramText(result)
    if (immediate) return immediate
    return '__DEFERRED__'
  }
  return extractDeepgramText(result)
}

/**
 * Call Deepgram API with retries
 */
async function callDeepgramWithRetries(url, fetchOptions, queryParams, timeoutMs) {
  for (let attempt = 1; attempt <= DEEPGRAM_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(url, fetchOptions, timeoutMs)
      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        const outcome = await handleDeepgramErrorResponse(response, attempt, errorText)
        if (outcome.action === 'retry') continue
        return null
      }
      const result = await response.json()
      return parseDeepgramApiResult(result, queryParams)
    } catch (error) {
      if (attempt < DEEPGRAM_MAX_ATTEMPTS) {
        const delay = backoffDelayMs(attempt, null)
        const label = error.isTimeout ? 'timeout' : 'network error'
        console.warn(`[aiTranscription] Deepgram ${label} (${error.message}) - retrying in ${delay}ms (attempt ${attempt}/${DEEPGRAM_MAX_ATTEMPTS})`)
        await sleep(delay)
        continue
      }
      console.error('[aiTranscription] Deepgram request failed (retries exhausted):', error.message)
      return null
    }
  }
  return null
}

/**
 * Transcribe audio file via Deepgram
 * Orchestrates param building, buffer load, API call, and result parsing
 */
async function transcribeWithDeepgram(absPath, settings, visitId) {
  const apiKey = settings.deepgram_api_key
  if (!apiKey) return null

  const mimetype = getMimeTypeFromPath(absPath) || 'audio/webm'
  const queryParams = buildDeepgramQueryParams(settings, visitId)
  const url = `https://api.deepgram.com/v1/listen?${queryParams.toString()}`
  const timeoutMs = resolveDeepgramTimeoutMs(settings)

  const audioBuffer = await loadAudioBufferForTranscription(absPath)
  if (!audioBuffer) return null

  const fetchOptions = buildDeepgramFetchOptions(apiKey, mimetype, audioBuffer)
  return callDeepgramWithRetries(url, fetchOptions, queryParams, timeoutMs)
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
