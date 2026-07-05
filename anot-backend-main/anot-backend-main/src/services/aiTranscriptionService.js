const fs = require('fs')
const path = require('path')
const { loadAiSettings, useDeepgram, defaultRuntimeSettings } = require('./aiSettings')
const {
  transcribeS3Key,
  transcribeLocalFile,
  calculateTranscribeTimeout,
  resolveTranscribeTimeoutMs,
} = require('./deepgramService')
const { dbPathToKey } = require('./s3Storage')

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'audio/mp4',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
  }
  return mimeTypes[ext] || null
}

/**
 * Transcribe audio from a local file path (after optional ffmpeg preprocessing).
 */
async function transcribeFromLocalPath(absPath, settings, visitId) {
  let fileSizeBytes = 0
  try {
    fileSizeBytes = fs.statSync(absPath).size
  } catch { /* */ }

  console.log('[deepgram] Local file:', path.basename(absPath), '| size:', (fileSizeBytes / (1024 * 1024)).toFixed(2), 'MB')
  return transcribeLocalFile(absPath, settings, visitId, fileSizeBytes)
}

/**
 * Transcribe audio directly from an S3 key (DB path format /uploads/...).
 */
async function transcribeFromS3Path(audioPath, settings, visitId, fileSizeBytes = 0) {
  const s3Key = dbPathToKey(audioPath)
  console.log('[deepgram] S3 key:', s3Key)
  return transcribeS3Key(s3Key, settings, visitId, fileSizeBytes)
}

/**
 * Transcribe a local file with Deepgram Nova-3 Medical.
 */
async function transcribeFile(absPath, settingsOverride, visitId, options = {}) {
  let settings = settingsOverride
  if (!settings) {
    try {
      settings = await loadAiSettings()
    } catch (err) {
      console.warn('[aiTranscription] loadAiSettings failed:', err.message)
      settings = defaultRuntimeSettings()
    }
  }

  if (!useDeepgram(settings)) {
    console.error('[aiTranscription] Deepgram not configured — set DEEPGRAM_API_KEY, USE_DEEPGRAM=true, and enable in Admin → Settings')
    return null
  }

  console.log(`[aiTranscription] Starting Deepgram for visit ${visitId}`)

  try {
    let text
    if (options.fromS3 && options.s3Path) {
      text = await transcribeFromS3Path(options.s3Path, settings, visitId, options.fileSizeBytes || 0)
    } else {
      text = await transcribeFromLocalPath(absPath, settings, visitId)
    }
    if (text) {
      console.log('[aiTranscription] Transcription successful')
      return text
    }
    console.warn('[aiTranscription] Empty transcript')
    return null
  } catch (error) {
    console.error('[aiTranscription] Transcription error:', error.message)
    return null
  }
}

module.exports = {
  transcribeFile,
  transcribeFromS3Path,
  useDeepgram,
  getMimeTypeFromPath,
  calculateTranscribeTimeout,
  resolveTranscribeTimeoutMs,
}
