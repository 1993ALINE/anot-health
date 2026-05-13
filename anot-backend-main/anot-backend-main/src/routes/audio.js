const express = require('express')
const router = express.Router()
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')
const { loadAiSettings } = require('../services/aiSettings')

// ─── Storage ──────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext = file.mimetype.includes('mp4') ? 'mp4' : file.mimetype.includes('ogg') ? 'ogg' : 'webm'
    const unique = `visit_${req.params.visitId}_${Date.now()}.${ext}`
    cb(null, unique)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true)
    } else {
      cb(new Error('Only audio files are allowed.'))
    }
  },
})

// ─── Helper: stream file ──────────────────────────────────────────────────────

function streamFile(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found on server.' })
  }
  const stat = fs.statSync(filePath)
  const fileSize = stat.size
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = ext === '.mp4' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : ext === '.mp3' ? 'audio/mpeg' : 'audio/webm'

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
  })
  const stream = fs.createReadStream(filePath)
  res.on('close', () => stream.destroy())
  stream.on('error', (err) => {
    console.error('Audio stream error:', err.message)
    if (!res.headersSent) res.status(500).end()
    else res.destroy(err)
  })
  stream.pipe(res)
}

function unlinkSilently(filePath) {
  if (!filePath) return
  fs.promises.unlink(filePath).catch(() => { /* best-effort */ })
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

router.post('/:visitId', protect, restrict('clinician', 'scribe'), upload.single('audio'), async (req, res) => {
  try {
    const { visitId } = req.params
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' })

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      unlinkSilently(req.file.path)
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    const settings = await loadAiSettings()
    const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
    if (req.file.size > maxBytes) {
      unlinkSilently(req.file.path)
      return res.status(413).json({ error: `Audio exceeds max size (${settings.ffmpeg_max_upload_mb} MB).` })
    }

    const audioPath = `/uploads/${req.file.filename}`

    const existingFiles = visit.audio_file || ''
    const updated = existingFiles ? `${existingFiles},${audioPath}` : audioPath

    await pool.query('UPDATE visits SET audio_file = $1, status = $2 WHERE id = $3', [updated, 'recording-uploaded', visitId])

    res.status(200).json({
      message: 'Audio uploaded successfully.',
      audio_file: audioPath,
      filename: req.file.filename,
      size: req.file.size,
    })

    await maybeAutoTranscribe(visitId, req.user, req)
  } catch (err) {
    if (req.file) unlinkSilently(req.file.path)
    console.error('Audio upload error:', err.message)
    res.status(500).json({ error: 'Failed to upload audio.' })
  }
})

// ─── POST /api/audio/:visitId/append — Append additional recording ───────────

router.post('/:visitId/append', protect, restrict('clinician', 'scribe'), upload.single('audio'), async (req, res) => {
  try {
    const { visitId } = req.params
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' })

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      unlinkSilently(req.file.path)
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    const settings = await loadAiSettings()
    const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
    if (req.file.size > maxBytes) {
      unlinkSilently(req.file.path)
      return res.status(413).json({ error: `Audio exceeds max size (${settings.ffmpeg_max_upload_mb} MB).` })
    }

    const newPath = `/uploads/${req.file.filename}`
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
    if (req.file) unlinkSilently(req.file.path)
    console.error('Append audio error:', err.message)
    res.status(500).json({ error: 'Failed to upload additional recording.' })
  }
})

// ─── GET /api/audio/:visitId/count — Count recordings ────────────────────────

router.get('/:visitId/count', protect, async (req, res) => {
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

// ─── GET /api/audio/:visitId — Stream audio (supports ?index=N) ──────────────

router.get('/:visitId', protect, async (req, res) => {
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

    const audioPath = path.join(__dirname, '..', filePath)
    streamFile(req, res, audioPath)
  } catch (err) {
    console.error('Audio stream error:', err.message)
    res.status(500).json({ error: 'Failed to stream audio.' })
  }
})

module.exports = router
