const { loadAiSettings, useDeepgram } = require('./aiSettings')

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
    const settings = await loadAiSettings()
    if (!useDeepgram(settings)) {
      throw new Error('Deepgram not configured. Add an API key in app.anot.health/settings.')
    }

    const queryParams = new URLSearchParams({
      model: settings.deepgram_model || 'nova-2-medical',
      language: settings.deepgram_language || language || 'en-US',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      numerals: 'true',
    })
    const url = `https://api.deepgram.com/v1/listen?${queryParams.toString()}`

    console.log('[transcriptionService] Sending to Deepgram...')
    const startTime = Date.now()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${settings.deepgram_api_key}`,
        'Content-Type': options.contentType || 'audio/wav',
      },
      body: audioBuffer,
    })

    console.log('[transcriptionService] Response status:', response.status)
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.error('[transcriptionService] Deepgram error:', response.status, errorText.slice(0, 300))
      throw new Error(`Transcription failed: Deepgram returned ${response.status}`)
    }

    const result = await response.json()
    const transcript = String(
      result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
    ).trim()
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
