const fs = require('fs')
const { createReadStream } = require('fs')
const { DeepgramClient } = require('@deepgram/sdk')
const { getSignedAudioUrl, getAudioBucket } = require('./s3Storage')
const { extractTranscriptsFromDeepgramBody } = require('../utils/deepgramPayload')
const { extractConfidence } = require('../utils/transcriptionConfidence')
const { parseCustomVocabulary } = require('../utils/deepgramSettingsUtils')
const { appendDeepgramVisitQuery } = require('../utils/webhookSignature')
const { isReachableWebhookUrl } = require('../utils/webhookReachability')
const { withRetry } = require('../utils/retry')
const { createCircuitBreaker } = require('../utils/circuitBreaker')
const { withOutboundSlot } = require('../utils/outboundConcurrency')

const DEEPGRAM_MAX_RETRIES = parseInt(process.env.DEEPGRAM_MAX_RETRIES || '5', 10)
const deepgramCircuit = createCircuitBreaker('deepgram', {
  failureThreshold: parseInt(process.env.DEEPGRAM_CIRCUIT_FAILURES || '5', 10),
  resetMs: parseInt(process.env.DEEPGRAM_CIRCUIT_RESET_MS || '30000', 10),
})

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || process.env.TRANSCRIPTION_POLL_INTERVAL_MS || '10000', 10)
const POLL_INTERVAL_MAX_MS = Math.max(POLL_INTERVAL_MS, 10000)

/** Max Deepgram job wait — 30 minutes for long clinical recordings. */
const MAX_TRANSCRIBE_TIMEOUT_MS = parseInt(
  process.env.TRANSCRIPTION_TIMEOUT || process.env.MAX_POLL_WAIT || '1800000',
  10,
)
const MAX_DEEPGRAM_SDK_TIMEOUT_SEC = Math.ceil(MAX_TRANSCRIBE_TIMEOUT_MS / 1000)

const DEEPGRAM_MODELS = new Set(['nova-3-medical', 'nova-3', 'nova-2'])

/** In-memory async job store — populated by sync responses or webhook callbacks. */
const jobs = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function resolveDeepgramApiKey(settings) {
  if (settings?.deepgram_api_key) return settings.deepgram_api_key
  const envKey = String(process.env.DEEPGRAM_API_KEY || '').trim()
  return envKey || null
}

function resolveDeepgramModel(settings) {
  const fromSettings = String(settings?.deepgram_model || '').trim()
  if (fromSettings && DEEPGRAM_MODELS.has(fromSettings)) return fromSettings
  const fromEnv = String(process.env.DEEPGRAM_MODEL || 'nova-3-medical').trim()
  return DEEPGRAM_MODELS.has(fromEnv) ? fromEnv : 'nova-3-medical'
}

/**
 * Scale job poll timeout from audio file size (MB).
 * Base 2 min + ~10s per MB + 30% buffer; bounded 60s–30min.
 */
function calculateTranscribeTimeout(fileSizeMB) {
  const baseMs = 120000
  const processingMs = fileSizeMB * 10000
  const buffer = (baseMs + processingMs) * 0.3
  const totalMs = baseMs + processingMs + buffer

  const envOverride = process.env.DEEPGRAM_TIMEOUT_MS || process.env.TRANSCRIBE_TIMEOUT_MS
  if (envOverride) {
    return Math.max(totalMs, parseInt(envOverride, 10))
  }

  return Math.max(60000, Math.min(totalMs, MAX_TRANSCRIBE_TIMEOUT_MS))
}

function resolveTranscribeTimeoutMs(settings, fileSizeBytes = 0) {
  const sizeMb = Math.max(0, Number(fileSizeBytes) || 0) / (1024 * 1024)
  let timeoutMs = calculateTranscribeTimeout(sizeMb)
  const settingsMin = Number(settings?.transcribe_timeout_ms ?? settings?.deepgram_timeout_ms)
  if (settingsMin > 0) {
    timeoutMs = Math.max(timeoutMs, settingsMin)
  }
  return timeoutMs
}

function buildListenOptions(settings, callbackUrl) {
  const opts = {
    model: resolveDeepgramModel(settings),
    language: settings?.transcribe_language || settings?.deepgram_language || 'en-US',
    smart_format: true,
    punctuate: settings?.deepgram_punctuate !== false,
    numerals: settings?.deepgram_numerals !== false,
    filler_words: settings?.deepgram_remove_filler_words === false,
    profanity_filter: !!settings?.deepgram_profanity_filter,
  }

  if (settings?.transcribe_show_speaker_labels !== false) {
    opts.diarize = true
    opts.utterances = true
  } else {
    opts.diarize = false
  }

  if (settings?.deepgram_redact_pii) {
    opts.redact = ['pii', 'numbers']
  }

  const keyterms = parseCustomVocabulary(settings?.deepgram_custom_vocabulary)
  if (keyterms.length > 0) {
    opts.keyterm = keyterms
  }

  if (callbackUrl) {
    opts.callback = callbackUrl
    opts.callback_method = 'POST'
  }
  return opts
}

/** Minimal options for A/B comparison in Admin advanced-settings test. */
function buildBaselineListenOptions(settings, callbackUrl) {
  return buildListenOptions({
    ...settings,
    transcribe_show_speaker_labels: false,
    deepgram_profanity_filter: false,
    deepgram_punctuate: false,
    deepgram_numerals: false,
    deepgram_redact_pii: false,
    deepgram_remove_filler_words: false,
    deepgram_custom_vocabulary: [],
  }, callbackUrl)
}

function transcriptsToText(texts) {
  if (!texts?.length) return null
  const joined = texts.map((t) => String(t).trim()).filter(Boolean).join('\n\n')
  return joined || null
}

function parseDeepgramOutput(body) {
  return transcriptsToText(extractTranscriptsFromDeepgramBody(body))
}

async function unwrapDeepgramResponse(response) {
  if (response == null) return null
  if (typeof response === 'object' && response.results != null) return response
  if (typeof response.bodyUsed === 'boolean' && response.bodyUsed) {
    return response.data ?? response.result ?? response
  }
  if (typeof response.json === 'function') {
    try {
      const cloned = typeof response.clone === 'function' ? response.clone() : response
      return await cloned.json()
    } catch (err) {
      if (response.data) return response.data
      if (response.result) return response.result
      throw err
    }
  }
  if (typeof response.text === 'function' && typeof response.json !== 'function') {
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  }
  if (typeof response.then === 'function') {
    const resolved = await response
    return unwrapDeepgramResponse(resolved)
  }
  return response
}

function getDeepgramCircuitStatus() {
  return deepgramCircuit.status()
}

function resolveRequestId(body, fallbackPrefix = 'dg') {
  return (
    body?.metadata?.request_id
    || body?.request_id
    || `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  )
}

function resolveCallbackUrl(settings, visitId) {
  const base = String(settings?.deepgram_webhook_url || process.env.DEEPGRAM_WEBHOOK_URL || '').trim()
  if (!base || !isReachableWebhookUrl(base)) return null
  return appendDeepgramVisitQuery(base, visitId)
}

/**
 * Start an async or sync Deepgram transcription job.
 * @returns {Promise<{ requestId: string, async: boolean, transcript?: string|null }>}
 */
async function startTranscription(params) {
  const { settings, visitId, type, url, filePath, callbackUrl, optionsOverride } = params
  const apiKey = resolveDeepgramApiKey(settings)
  if (!apiKey) {
    console.error('[deepgram] DEEPGRAM_API_KEY not configured')
    return null
  }

  const client = new DeepgramClient({ apiKey })
  const options = optionsOverride || buildListenOptions(settings, callbackUrl)
  const timeoutSec = Math.ceil(resolveTranscribeTimeoutMs(settings, params.fileSizeBytes || 0) / 1000)

  console.log('[deepgram] Starting job', {
    visitId,
    model: options.model,
    type,
    async: !!callbackUrl,
    timeoutSec,
  })

  try {
    const started = await deepgramCircuit.exec(() => withOutboundSlot(() => withRetry(async () => {
      let response
      if (type === 'url') {
        response = await client.listen.v1.media.transcribeUrl(
          { url, ...options },
          { timeoutInSeconds: Math.min(timeoutSec, MAX_DEEPGRAM_SDK_TIMEOUT_SEC) },
        )
      } else {
        response = await client.listen.v1.media.transcribeFile(
          createReadStream(filePath),
          options,
          { timeoutInSeconds: Math.min(timeoutSec, MAX_DEEPGRAM_SDK_TIMEOUT_SEC) },
        )
      }
      const body = await unwrapDeepgramResponse(response)
      return { body, response }
    }, {
      maxAttempts: DEEPGRAM_MAX_RETRIES,
      label: `Deepgram visit ${visitId}`,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    })))

    const body = started.body
    const requestId = resolveRequestId(body, `visit-${visitId}`)

    if (callbackUrl) {
      jobs.set(requestId, {
        status: 'processing',
        transcript: null,
        visitId,
        createdAt: Date.now(),
      })
      console.log('[deepgram] Async job queued:', requestId)
      return { requestId, async: true }
    }

    const transcript = parseDeepgramOutput(body)
    jobs.set(requestId, {
      status: transcript ? 'completed' : 'failed',
      transcript,
      visitId,
      createdAt: Date.now(),
      error: transcript ? null : 'empty_transcript',
      confidence: extractConfidence(body).overall,
      rawBody: body,
    })

    if (transcript) {
      console.log('[deepgram] Sync job complete:', requestId, '| length:', transcript.length)
    } else {
      console.warn('[deepgram] Sync job returned empty transcript:', requestId)
    }

    return { requestId, async: false, transcript, confidence: extractConfidence(body).overall, rawBody: body }
  } catch (err) {
    if (err.code === 'CIRCUIT_OPEN') {
      console.error('[deepgram] Circuit breaker open — skipping transcription for visit', visitId)
    } else {
      console.error('[deepgram] startTranscription failed:', err.message)
    }
    return null
  }
}

/**
 * Poll in-memory job status (updated by sync completion or webhook).
 * @returns {{ status: 'processing'|'completed'|'failed'|'unknown', error?: string }}
 */
function getTranscriptionStatus(requestId) {
  const job = jobs.get(String(requestId))
  if (!job) return { status: 'unknown' }
  return { status: job.status, error: job.error || null }
}

/**
 * Retrieve transcript text for a completed job.
 * @returns {string|null}
 */
function getTranscript(requestId) {
  const job = jobs.get(String(requestId))
  if (!job || job.status !== 'completed') return null
  return job.transcript || null
}

/** Called by the Deepgram webhook handler when async processing completes. */
function completeJobFromWebhook(visitId, body) {
  const requestId = resolveRequestId(body, `webhook-${visitId}`)
  const transcript = parseDeepgramOutput(body)
  jobs.set(requestId, {
    status: transcript ? 'completed' : 'failed',
    transcript,
    visitId,
    createdAt: Date.now(),
    error: transcript ? null : 'empty_transcript',
  })
  return { requestId, transcript }
}

async function pollUntilComplete(requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let interval = POLL_INTERVAL_MS

  while (Date.now() < deadline) {
    const { status } = getTranscriptionStatus(requestId)
    if (status === 'completed') return getTranscript(requestId)
    if (status === 'failed') return null
    await sleep(interval)
    interval = Math.min(interval * 1.5, POLL_INTERVAL_MAX_MS)
  }

  console.error('[deepgram] Job timed out after', timeoutMs, 'ms:', requestId)
  const job = jobs.get(String(requestId))
  if (job) job.status = 'failed'
  return null
}

/**
 * Transcribe an S3 audio object via presigned URL (sync or async+callback).
 */
async function transcribeS3Key(s3Key, settings, visitId, fileSizeBytes = 0) {
  const bucket = getAudioBucket()
  console.log('[deepgram] env check', {
    S3_AUDIO_BUCKET: process.env.S3_AUDIO_BUCKET || '(unset)',
    resolvedBucket: bucket,
    USE_DEEPGRAM: process.env.USE_DEEPGRAM || '(unset)',
    DEEPGRAM_MODEL: resolveDeepgramModel(settings),
    visitId,
  })

  if (!bucket) {
    console.error('[deepgram] S3 audio bucket not configured')
    return null
  }

  let presignedUrl
  try {
    presignedUrl = await getSignedAudioUrl(s3Key)
  } catch (err) {
    console.error('[deepgram] Failed to presign S3 object:', err.message)
    return null
  }

  const callbackUrl = resolveCallbackUrl(settings, visitId)
  const timeoutMs = resolveTranscribeTimeoutMs(settings, fileSizeBytes)
  const started = await startTranscription({
    type: 'url',
    url: presignedUrl,
    settings,
    visitId,
    fileSizeBytes,
    callbackUrl,
  })

  if (!started) return null
  if (!started.async) return started.transcript || null
  return pollUntilComplete(started.requestId, timeoutMs)
}

/**
 * Transcribe a local audio file and return transcript + confidence (sync path only).
 */
async function transcribeLocalFileDetailed(absPath, settings, visitId, fileSizeBytes = 0, optionsOverride = null) {
  try {
    const size = fileSizeBytes || (await fs.promises.stat(absPath)).size
    const started = await startTranscription({
      type: 'file',
      filePath: absPath,
      settings,
      visitId,
      fileSizeBytes: size,
      callbackUrl: null,
      optionsOverride,
    })
    if (!started) return null
    return {
      transcript: started.transcript || null,
      confidence: started.confidence ?? null,
      options: optionsOverride || buildListenOptions(settings, null),
    }
  } catch (err) {
    console.error('[deepgram] Failed detailed local transcription:', err.message)
    return null
  }
}

/**
 * Transcribe a local audio file (post-ffmpeg preprocessing).
 */
async function transcribeLocalFile(absPath, settings, visitId, fileSizeBytes = 0) {
  try {
    const size = fileSizeBytes || (await fs.promises.stat(absPath)).size
    const callbackUrl = resolveCallbackUrl(settings, visitId)
    const timeoutMs = resolveTranscribeTimeoutMs(settings, size)
    const started = await startTranscription({
      type: 'file',
      filePath: absPath,
      settings,
      visitId,
      fileSizeBytes: size,
      callbackUrl,
    })
    if (!started) return null
    if (!started.async) return started.transcript || null
    return pollUntilComplete(started.requestId, timeoutMs)
  } catch (err) {
    console.error('[deepgram] Failed to transcribe local file:', err.message)
    return null
  }
}

module.exports = {
  startTranscription,
  getTranscriptionStatus,
  getTranscript,
  completeJobFromWebhook,
  transcribeS3Key,
  transcribeLocalFile,
  transcribeLocalFileDetailed,
  calculateTranscribeTimeout,
  resolveTranscribeTimeoutMs,
  parseDeepgramOutput,
  resolveDeepgramApiKey,
  resolveDeepgramModel,
  buildListenOptions,
  buildBaselineListenOptions,
  getDeepgramCircuitStatus,
  /** @deprecated tests only — prefer parseDeepgramOutput */
  parseTranscribeOutput: parseDeepgramOutput,
}
