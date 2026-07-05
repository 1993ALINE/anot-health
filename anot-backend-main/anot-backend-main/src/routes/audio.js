const express = require('express')
const router = express.Router()
const multer = require('multer')
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { audioFileFilter, MAX_FILE_SIZE } = require('../middleware/fileValidation')
const { createS3StreamStorage } = require('../middleware/s3StreamUpload')
const { getPublicErrorMessage, logServerError } = require('../utils/errorMessages')
const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')
const { visitHasPatientConsentRecorded } = require('../utils/visitSchemaCompat')
const { loadAiSettings, defaultRuntimeSettings, useDeepgram } = require('../services/aiSettings')
const { getAudioStream, dbPathToKey } = require('../services/s3Storage')
const cloudWatchAudit = require('../utils/logger')

// Stream multipart uploads directly to S3 (no in-memory buffering).

function extFromMimetype(mimetype) {
  return mimetype.includes('mp4') ? 'mp4' : mimetype.includes('ogg') ? 'ogg' : 'webm'
}

function buildAudioFilename(visitId, mimetype) {
  return `visit_${visitId}_${Date.now()}.${extFromMimetype(mimetype)}`
}

async function resolveUploadTarget(req, file) {
  const visitId = req.params.visitId
  const visit = await getVisitForUser(visitId, req.user)
  if (!visit) {
    throw Object.assign(new Error('Visit not found or not yours.'), { status: 404 })
  }

  if (await visitHasPatientConsentRecorded()) {
    if (!visit.patient_consent_recorded) {
      throw Object.assign(
        new Error('Patient recording consent is required before uploading audio.'),
        { status: 403 },
      )
    }
  }

  let settings
  try {
    settings = await loadAiSettings()
  } catch (err) {
    console.warn('[audio] loadAiSettings failed, using defaults:', err.message)
    settings = defaultRuntimeSettings()
  }

  const maxBytes = Math.min(
    settings.ffmpeg_max_upload_mb * 1024 * 1024,
    MAX_FILE_SIZE,
  )
  const filename = buildAudioFilename(visitId, file.mimetype)
  const audioPath = `/uploads/${filename}`

  req._audioUploadMeta = { visit, settings, audioPath, maxBytes }
  return { key: dbPathToKey(audioPath), maxBytes }
}

const upload = multer({
  storage: createS3StreamStorage(resolveUploadTarget),
  fileFilter: audioFileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
})

function handleMulterError(err, req, res, next) {
  if (!err) { return next() }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB.` })
  }
  const status = err.status || 500
  if (err.status) {
    return res.status(status).json({ error: getPublicErrorMessage(status, err) })
  }
  logServerError('audio.multer', err, req)
  return res.status(500).json({ error: getPublicErrorMessage(500, err) })
}

async function queueVisitTranscription(visitId, user, req, source = 'upload') {
  console.log(`[transcription] Starting pipeline for visit ${visitId} (${source})`)
  setImmediate(() => {
    runAIPipeline(visitId, { user, req })
      .then(() => console.log(`[transcription] Pipeline finished for visit ${visitId}`))
      .catch((err) => console.error(`[transcription] Failed for visit ${visitId}:`, err.message))
  })
}

async function maybeAutoTranscribe(visitId, user, req) {
  try {
    const settings = await loadAiSettings()
    if (!settings.transcribe_auto_transcribe_on_upload) {
      console.log(`[transcription] Auto-transcribe disabled in settings — skipping visit ${visitId}`)
      return false
    }
    if (!useDeepgram(settings)) {
      console.warn(`[transcription] Deepgram not configured — skipping auto-transcribe for visit ${visitId}`)
      return false
    }
    await queueVisitTranscription(visitId, user, req, 'upload')
    return true
  } catch (e) {
    console.warn('[transcription] maybeAutoTranscribe:', e.message)
    return false
  }
}

function validateAudioUpload(req) {
  if (!req.file) throw Object.assign(new Error('No audio file uploaded.'), { status: 400 })
  if (!req._audioUploadMeta?.visit) {
    throw Object.assign(new Error('Visit not found or not yours.'), { status: 404 })
  }
  const { maxBytes } = req._audioUploadMeta
  if (req.file.size > maxBytes) {
    throw Object.assign(
      new Error(`Audio exceeds max size (${Math.round(maxBytes / (1024 * 1024))} MB).`),
      { status: 413 },
    )
  }
  return req._audioUploadMeta
}

function uploadAudioToStorage(req) {
  const { audioPath } = req._audioUploadMeta
  const filename = audioPath.replace(/^\/uploads\//, '')
  return { audioPath, filename }
}

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

function handleAudioUploadError(res, err, req) {
  const status = err.status || 500
  if (err.status) {
    return res.status(status).json({ error: getPublicErrorMessage(status, err) })
  }
  logServerError('audio.upload', err, req)
  return res.status(500).json({ error: getPublicErrorMessage(500, err) })
}

router.post('/:visitId', protect, restrict('clinician'), upload.single('audio'), handleMulterError, async (req, res) => {
  try {
    const { visitId } = req.params
    validateAudioUpload(req)
    const { audioPath, filename } = uploadAudioToStorage(req)
    await appendAudioPathToVisit(visitId, audioPath, 'recording-uploaded')
    console.log('[audio] Upload complete for visit:', visitId, 's3Key:', audioPath, 'size:', req.file.size)

    res.status(200).json({
      message: 'Audio uploaded successfully.',
      audio_file: audioPath,
      filename,
      size: req.file.size,
      transcription_status: 'processing',
      transcription_queued: true,
    })

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'audio', visitId, 'UPLOAD', req.clientIp,
      { filename, size: req.file.size, kind: 'primary' },
    )

    await maybeAutoTranscribe(visitId, req.user, req)
    console.log('[audio] Transcription queue finished for visit:', visitId)
  } catch (err) {
    handleAudioUploadError(res, err, req)
  }
})

router.post('/:visitId/append', protect, restrict('clinician'), upload.single('audio'), handleMulterError, async (req, res) => {
  try {
    const { visitId } = req.params
    validateAudioUpload(req)
    const { audioPath, filename } = uploadAudioToStorage(req)
    const updated = await appendAudioPathToVisit(visitId, audioPath) || audioPath

    res.status(200).json({
      message: 'Additional recording uploaded.',
      audio_file: audioPath,
      total_recordings: updated.split(',').length,
    })

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'audio', visitId, 'UPLOAD', req.clientIp,
      { filename, kind: 'append', total_recordings: updated.split(',').length },
    )

    setImmediate(() => {
      console.log(`[transcription] Re-running AI pipeline for visit ${visitId} after additional recording`)
      runAIPipeline(visitId, { user: req.user, req })
        .catch((err) => console.error(`[transcription] AI re-run error for visit ${visitId}:`, err.message))
    })
  } catch (err) {
    handleAudioUploadError(res, err, req)
  }
})

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
      { index, partial: !!rangeHeader },
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
