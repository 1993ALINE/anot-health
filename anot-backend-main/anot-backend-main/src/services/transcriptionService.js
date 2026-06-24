const { extractConfidence } = require('../utils/transcriptionConfidence')
const { loadAiSettings, useDeepgram, defaultRuntimeSettings } = require('./aiSettings')

/**
 * Validate transcription request inputs
 */
function validateTranscriptionRequest(visitId, audioBuffer) {
  if (!visitId) throw new Error('Visit ID required')
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('Audio buffer required and must not be empty')
  }
  if (audioBuffer.length > 500 * 1024 * 1024) {
    throw new Error('Audio file too large')
  }
}

/**
 * Ensure Deepgram is configured
 */
function assertDeepgramConfigured(settings) {
  if (!useDeepgram(settings)) {
    throw new Error('Deepgram not configured. Add an API key in app.anot.health/settings.')
  }
}

/**
 * Build Deepgram API parameters for buffer transcription
 */
function buildTranscriptionParams(settings, language, options = {}) {
  return {
    url: `https://api.deepgram.com/v1/listen?${new URLSearchParams({
      model: settings.deepgram_model || 'nova-2-medical',
      language: settings.deepgram_language || language || 'en-US',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      numerals: 'true',
    }).toString()}`,
    contentType: options.contentType || 'audio/wav',
    apiKey: settings.deepgram_api_key,
  }
}

/**
 * Call Deepgram transcription API
 */
async function callTranscriptionAPI(audioBuffer, params) {
  console.log('[transcriptionService] Sending to Deepgram...')
  const response = await fetch(params.url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${params.apiKey}`,
      'Content-Type': params.contentType,
    },
    body: audioBuffer,
  })

  console.log('[transcriptionService] Response status:', response.status)
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    console.error('[transcriptionService] Deepgram error:', response.status, errorText.slice(0, 300))
    throw new Error(`Transcription failed: Deepgram returned ${response.status}`)
  }
  return response.json()
}

/**
 * Parse transcription result from Deepgram response
 */
function parseTranscriptionResult(result) {
  return String(
    result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  ).trim()
}

class TranscriptionService {
  /**
   * Transcribe raw audio with Deepgram (primary and only transcription service).
   *
   * @param {Buffer} audioBuffer - Raw audio data
   * @param {String} visitId - Medical visit ID for audit trail
   * @param {String} language - Language code (default: 'en')
   * @param {{ filename?: string, contentType?: string }} [options]
   * @returns {Promise<Object>} - { transcript, visitId, language, processingTime, timestamp }
   */
  static async transcribeAudio(audioBuffer, visitId, language = 'en', options = {}) {
    validateTranscriptionRequest(visitId, audioBuffer)

    let settings
    try {
      settings = await loadAiSettings()
    } catch (err) {
      console.warn('[transcriptionService] loadAiSettings failed:', err.message)
      settings = defaultRuntimeSettings()
    }
    assertDeepgramConfigured(settings)

    const params = buildTranscriptionParams(settings, language, options)
    const startTime = Date.now()
    const result = await callTranscriptionAPI(audioBuffer, params)
    const transcript = parseTranscriptionResult(result)
    const processingTime = (Date.now() - startTime) / 1000

    return {
      transcript,
      visitId,
      language,
      processingTime,
      timestamp: new Date().toISOString(),
    }
  }
}

module.exports = TranscriptionService;
