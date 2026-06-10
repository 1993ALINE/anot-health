const express = require('express')
const router = express.Router()
const multer = require('multer')
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')
const { loadAiSettings } = require('../services/aiSettings')
const { uploadAudio, getSignedAudioUrl, dbPathToKey } = require('../services/s3Storage')

// ─── Storage ──────────────────────────────────────────────────────────────────
// Files are buffered in memory then uploaded to S3 (local disk is wiped on
// every Elastic Beanstalk redeploy, so nothing durable can live there).

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true)
    } else {
      cb(new Error('Only audio files are allowed.'))
    }
  },
})

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

// ─── POST /api/audio/:visitId — Upload primary recording ─────────────────────

router.post('/:visitId', protect, restrict('clinician'), upload.single('audio'), async (req, res) => {
  try {
    const { visitId } = req.params
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' })

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    const settings = await loadAiSettings()
    const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `Audio exceeds max size (${settings.ffmpeg_max_upload_mb} MB).` })
    }

    const filename = buildAudioFilename(visitId, req.file.mimetype)
    const audioPath = `/uploads/${filename}`
    await uploadAudio(dbPathToKey(audioPath), req.file.buffer, req.file.mimetype)

    const existingFiles = visit.audio_file || ''
    const updated = existingFiles ? `${existingFiles},${audioPath}` : audioPath

    await pool.query('UPDATE visits SET audio_file = $1, status = $2 WHERE id = $3', [updated, 'recording-uploaded', visitId])

    res.status(200).json({
      message: 'Audio uploaded successfully.',
      audio_file: audioPath,
      filename,
      size: req.file.size,
    })

    await maybeAutoTranscribe(visitId, req.user, req)
  } catch (err) {
    console.error('Audio upload error:', err.message)
    res.status(500).json({ error: 'Failed to upload audio.' })
  }
})

// ─── POST /api/audio/:visitId/append — Append additional recording ───────────

router.post('/:visitId/append', protect, restrict('clinician'), upload.single('audio'), async (req, res) => {
  try {
    const { visitId } = req.params
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' })

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    const settings = await loadAiSettings()
    const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `Audio exceeds max size (${settings.ffmpeg_max_upload_mb} MB).` })
    }

    const filename = buildAudioFilename(visitId, req.file.mimetype)
    const newPath = `/uploads/${filename}`
    await uploadAudio(dbPathToKey(newPath), req.file.buffer, req.file.mimetype)

    const existing = visit.audio_file || ''
    const updated = existing ? `${existing},${newPath}` : newPath

    await pool.query('UPDATE visits SET audio_file = $1 WHERE id = $2', [updated, visitId])

    res.status(200).json({
      message: 'Additional recording uploaded.',
      audio_file: newPath,
      total_recordings: updated.split(',').length,
    })

    setImmediate(() => {
      console.log(`🔄 Re-running AI pipeline for visit ${visitId} after additional recording`)
      runAIPipeline(visitId, { user: req.user, req }).catch((err) => console.error('AI re-run error:', err.message))
    })
  } catch (err) {
    console.error('Append audio error:', err.message)
    res.status(500).json({ error: 'Failed to upload additional recording.' })
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
    console.error('Count audio error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
})

// ─── GET /api/audio/:visitId — Serve audio (supports ?index=N) ────────────────
// Redirects to a presigned S3 URL (valid 1 hour). S3 handles Range requests
// natively, so seeking and Safari's 206 Partial Content requirement still work.

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

    const signedUrl = await getSignedAudioUrl(dbPathToKey(filePath))
    res.redirect(302, signedUrl)
  } catch (err) {
    console.error('Audio serve error:', err.message)
    res.status(500).json({ error: 'Failed to serve audio.' })
  }
})

module.exports = router
