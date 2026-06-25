const express = require('express')
const router = express.Router()
const multer = require('multer')
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { createSecureUpload, validateUploadedFile } = require('../middleware/fileValidation')
const { getPublicErrorMessage, logServerError } = require('../utils/errorMessages')
const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')
const { loadAiSettings, defaultRuntimeSettings } = require('../services/aiSettings')
const { uploadAudio, getAudioStream, dbPathToKey } = require('../services/s3Storage')
const cloudWatchAudit = require('../utils/logger')

// ─── Storage ──────────────────────────────────────────────────────────────────
// Files are buffered in memory then uploaded to S3 (local disk is wiped on
// every Elastic Beanstalk redeploy, so nothing durable can live there).

const upload = createSecureUpload(multer.memoryStorage())

function extFromMimetype(mimetype) {
  return mimetype.includes('mp4') ? 'mp4' : mimetype.includes('ogg') ? 'ogg' : 'webm'
}

function buildAudioFilename(visitId, mimetype) {
  return `visit_${visitId}_${Date.now()}.${extFromMimetype(mimetype)}`
}

async function maybeAutoTranscribe(visitId, user, req) {
  try {
    const s = await loadAiSettings()
    if (!s.deepgram_auto_transcribe_on_upload) return
    setImmediate(() => {
      runAIPipeline(visitId, { user, req }).catch((err) => console.error('Auto-transcribe error:', err.message))
    })
  } catch (e) {
    console.warn('maybeAutoTranscribe:', e.message)
  }
}

/**
 * Validate audio upload request
 */
async function validateAudioUpload(req, visitId) {
  if (!req.file) throw Object.assign(new Error('No audio file uploaded.'), { status: 400 })
  const visit = await getVisitForUser(visitId, req.user)
  if (!visit) throw Object.assign(new Error('Visit not found or not yours.'), { status: 404 })
  let settings
  try {
    settings = await loadAiSettings()
  } catch (err) {
    console.warn('[audio] loadAiSettings failed, using defaults:', err.message)
    settings = defaultRuntimeSettings()
  }
  const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
  if (req.file.size > maxBytes) {
    throw Object.assign(
      new Error(`Audio exceeds max size (${settings.ffmpeg_max_upload_mb} MB).`),
      { status: 413 }
    )
  }
  return { visit, settings }
}

/**
 * Upload audio buffer to S3 and return DB path
 */
async function uploadAudioToStorage(visitId, file) {
  const filename = buildAudioFilename(visitId, file.mimetype)
  const audioPath = `/uploads/${filename}`
  await uploadAudio(dbPathToKey(audioPath), file.buffer, file.mimetype)
  return { audioPath, filename }
}

/**
 * Atomically append audio path to visit record
 */
async function appendAudioPathToVisit(visitId, audioPath, status) {
  const params = status
    ? [audioPath, status, visitId]
    : [audioPath, visitId]
  const sql = status
    ? `UPDATE visits
          SET audio_file = CASE
                WHEN audio_file IS NULL OR audio_file = '' THEN $1
                ELSE audio_file || ',' || $1
              END,
              status = $2
        WHERE id = $3`
    : `UPDATE visits
          SET audio_file = CASE
                WHEN audio_file IS NULL OR audio_file = '' THEN $1
                ELSE audio_file || ',' || $1
              END
        WHERE id = $2
        RETURNING audio_file`
  const result = await pool.query(sql, params)
  return status ? null : result.rows[0]?.audio_file
}

/**
 * Handle audio upload route errors
 */
function handleAudioUploadError(res, err, req) {
  const status = err.status || 500
  if (err.status) {
    return res.status(status).json({ error: getPublicErrorMessage(status, err) })
  }
  logServerError('audio.upload', err, req)
  return res.status(500).json({ error: getPublicErrorMessage(500, err) })
}

// ─── POST /api/audio/:visitId — Upload primary recording ─────────────────────

router.post('/:visitId', protect, restrict('clinician'), upload.single('audio'), validateUploadedFile, async (req, res) => {
  try {
    const { visitId } = req.params
    await validateAudioUpload(req, visitId)
    const { audioPath, filename } = await uploadAudioToStorage(visitId, req.file)
    await appendAudioPathToVisit(visitId, audioPath, 'recording-uploaded')

    res.status(200).json({
      message: 'Audio uploaded successfully.',
      audio_file: audioPath,
      filename,
      size: req.file.size,
    })

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'audio', visitId, 'UPLOAD', req.clientIp,
      { filename, size: req.file.size, kind: 'primary' }
    )

    await maybeAutoTranscribe(visitId, req.user, req)
  } catch (err) {
    handleAudioUploadError(res, err, req)
  }
})

// ─── POST /api/audio/:visitId/append — Append additional recording ───────────

router.post('/:visitId/append', protect, restrict('clinician'), upload.single('audio'), validateUploadedFile, async (req, res) => {
  try {
    const { visitId } = req.params
    await validateAudioUpload(req, visitId)
    const { audioPath, filename } = await uploadAudioToStorage(visitId, req.file)
    const updated = await appendAudioPathToVisit(visitId, audioPath) || audioPath

    res.status(200).json({
      message: 'Additional recording uploaded.',
      audio_file: audioPath,
      total_recordings: updated.split(',').length,
    })

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'audio', visitId, 'UPLOAD', req.clientIp,
      { filename, kind: 'append', total_recordings: updated.split(',').length }
    )

    setImmediate(() => {
      console.log(`🔄 Re-running AI pipeline for visit ${visitId} after additional recording`)
      runAIPipeline(visitId, { user: req.user, req }).catch((err) => console.error('AI re-run error:', err.message))
    })
  } catch (err) {
    handleAudioUploadError(res, err, req)
  }
})

// ─── GET /api/audio/:visitId/count — Count recordings ────────────────────────

router.get('/:visitId/count', protect, restrict('clinician', 'scribe', 'qps'), async (req, res) => {
  try {
    const visit = await getVisitForUser(req.params.visitId, req.user)
    if (!visit) return res.status(404).json({ error: 'Visit not found.' })

    const audioFile = visit.audio_file || ''
    const count = audioFile ? audioFile.split(',').filter(Boolean).length : 0
    res.json({ count })
  } catch (err) {
    logServerError('audio.count', err, req)
    res.status(500).json({ error: getPublicErrorMessage(500, err) })
  }
})

// ─── GET /api/audio/:visitId — Stream audio with Range support (?index=N) ─────
// Authenticated proxy to S3 — no presigned URL exposed to the client.

router.get('/:visitId', protect, restrict('clinician', 'scribe', 'qps'), async (req, res) => {
  try {
    const { visitId } = req.params
    const index = parseInt(req.query.index || '0')

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) return res.status(404).json({ error: 'Visit not found.' })
    if (!visit.audio_file) {
      return res.status(404).json({ error: 'No audio found for this visit.' })
    }

    const files = visit.audio_file.split(',').map((f) => f.trim()).filter(Boolean)
    const filePath = files[index] || files[0]

    if (!filePath) return res.status(404).json({ error: 'Audio file not found.' })

    if (!/^\/uploads\/[\w.\-]+$/.test(filePath)) {
      return res.status(400).json({ error: 'Invalid audio path.' })
    }

    const rangeHeader = req.headers.range
    const streamResult = await getAudioStream(dbPathToKey(filePath), rangeHeader)

    res.status(streamResult.statusCode)
    if (streamResult.contentType) res.setHeader('Content-Type', streamResult.contentType)
    if (streamResult.contentLength != null) res.setHeader('Content-Length', String(streamResult.contentLength))
    if (streamResult.contentRange) res.setHeader('Content-Range', streamResult.contentRange)
    res.setHeader('Accept-Ranges', streamResult.acceptRanges || 'bytes')

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'audio', visitId, 'STREAM', req.clientIp,
      { index, partial: !!rangeHeader }
    )

    streamResult.body.pipe(res)
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Audio file not found.' })
    }
    logServerError('audio.stream', err, req)
    res.status(500).json({ error: getPublicErrorMessage(500, err) })
  }
})

module.exports = router
