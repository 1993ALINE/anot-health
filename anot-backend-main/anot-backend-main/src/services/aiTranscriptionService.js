const fs = require('fs')
const path = require('path')
const { loadAiSettings, useDeepgram } = require('./aiSettings')
const { isReachableWebhookUrl } = require('../utils/webhookReachability')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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

async function transcribeWithDeepgram(absPath, settings, visitId) {
  const { appendDeepgramVisitQuery } = require('../utils/webhookSignature')
  
  const apiKey = settings.deepgram_api_key
  if (!apiKey) return null
  
  // Detect mimetype from file extension
  const mimetype = getMimeTypeFromPath(absPath) || 'audio/webm'
  const fileExt = path.extname(absPath).toLowerCase()
  
  console.log(`[aiTranscription] Transcribing file: ${path.basename(absPath)}`)
  console.log(`[aiTranscription] File extension: ${fileExt}, mimetype: ${mimetype}`)
  
  // Use configured model or default to nova-2-medical
  const model = settings.deepgram_model || 'nova-2-medical'
  const language = settings.deepgram_language || 'en-US'
  
  // Build query parameters
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
  
  // Check if using webhook callback
  const baseCallback = String(settings.deepgram_webhook_url || '').trim()
  const id = parseInt(String(visitId), 10)
  
  if (baseCallback && Number.isInteger(id) && isReachableWebhookUrl(baseCallback)) {
    const callbackUrl = appendDeepgramVisitQuery(baseCallback, id)
    if (callbackUrl) {
      console.log(`[aiTranscription] Using webhook callback for visit ${id}`)
      queryParams.set('callback', callbackUrl)
    }
  }
  
  const url = `https://api.deepgram.com/v1/listen?${queryParams.toString()}`
  
  console.log(`[aiTranscription] Using direct HTTP request to Deepgram API`)
  console.log(`[aiTranscription] Model: ${model}, Language: ${language}`)
  console.log(`[aiTranscription] Content-Type: ${mimetype}`)
  
  try {
    // Read the audio file as a buffer
    const audioBuffer = await fs.promises.readFile(absPath)
    console.log(`[aiTranscription] Audio file size: ${audioBuffer.length} bytes`)
    
    // Send direct HTTP request to Deepgram
    console.log(`[aiTranscription] Sending request to Deepgram...`)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': mimetype,
      },
      body: audioBuffer,
    })
    
    console.log(`[aiTranscription] Deepgram response status: ${response.status}`)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[aiTranscription] Deepgram API error (${response.status}):`, errorText.slice(0, 500))
      throw new Error(`Deepgram API error: ${response.status} ${response.statusText} - ${errorText.slice(0, 200)}`)
    }
    
    const result = await response.json()
    console.log(`[aiTranscription] Received response from Deepgram`)
    
    // Check if using webhook (callback will return request_id)
    if (result.request_id && queryParams.has('callback')) {
      console.log(`[aiTranscription] Webhook request submitted with ID: ${result.request_id}`)
      // Check if there's an immediate transcript
      const immediate = extractDeepgramText(result)
      if (immediate) return immediate
      return '__DEFERRED__'
    }
    
    // Extract transcript from synchronous response
    const transcript = extractDeepgramText(result)
    if (!transcript) {
      console.warn('[aiTranscription] Deepgram returned empty transcript')
      console.warn('[aiTranscription] Response structure:', JSON.stringify(result).slice(0, 500))
    }
    
    return transcript
  } catch (error) {
    console.error(`[aiTranscription] Deepgram request failed:`, error.message)
    console.error(`[aiTranscription] File: ${absPath}, mimetype: ${mimetype}`)
    if (error.cause) {
      console.error(`[aiTranscription] Error cause:`, error.cause)
    }
    throw error
  }
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
