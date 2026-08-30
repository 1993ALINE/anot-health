const { loadAiSettings, useDeepgram, defaultRuntimeSettings } = require('./aiSettings')

const { transcribeLocalFile } = require('./deepgramService')



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

    throw new Error('Deepgram not configured. Set DEEPGRAM_API_KEY, USE_DEEPGRAM=true, and enable transcription in Admin → Settings.')

  }

}



class TranscriptionService {

  /**

   * Transcribe raw audio with Deepgram Nova-3 Medical.

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



    if (language && language !== 'en') {

      settings = { ...settings, transcribe_language: language }

    }



    const fs = require('fs')

    const os = require('os')

    const path = require('path')

    const ext = options.contentType?.includes('wav') ? '.wav' : '.webm'

    const tmpPath = path.join(os.tmpdir(), `anot_buf_${Date.now()}${ext}`)



    const startTime = Date.now()

    try {

      await fs.promises.writeFile(tmpPath, audioBuffer)

      const result = await transcribeLocalFile(tmpPath, settings, visitId, audioBuffer.length)

      const transcript = String(result || '').trim()

      const processingTime = (Date.now() - startTime) / 1000



      return {

        transcript,

        visitId,

        language,

        processingTime,

        timestamp: new Date().toISOString(),

      }

    } finally {

      await fs.promises.unlink(tmpPath).catch(() => {})

    }

  }

}



module.exports = TranscriptionService

