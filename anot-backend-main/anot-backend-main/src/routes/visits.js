const express = require('express')
const router = express.Router()
const {
  getVisitsByDate,
  getAllVisits,
  createVisit,
  updateVisitStatus,
  endVisit,
  updateVisit,
  deleteVisit,
  getVisitHistory,
} = require('../controllers/visitController')
const { protect, restrict } = require('../middleware/auth')

// Clinician routes
router.get('/my', protect, restrict('clinician'), getVisitsByDate)
router.get('/history', protect, restrict('clinician'), getVisitHistory)
router.post('/', protect, restrict('clinician'), createVisit)
router.put('/:id/end', protect, restrict('clinician'), endVisit)
router.put('/:id/status', protect, restrict('clinician', 'scribe', 'admin', 'super_admin'), updateVisitStatus)
router.put('/:id', protect, restrict('clinician'), updateVisit)
router.delete('/:id', protect, restrict('clinician'), deleteVisit)

// Scribe / QPS / Admin / Clinician routes (controller scopes results per role)
router.get('/', protect, restrict('scribe', 'qps', 'admin', 'super_admin', 'clinician'), getAllVisits)

const pool = require('../config/db')
const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')
const { setVisitTranscriptionStatus } = require('../utils/visitSchemaCompat')

function noteHasTranscript(transcription) {
  if (!transcription) return false
  const raw = String(transcription).trim()
  if (!raw || raw === '[]' || raw === 'null') return false
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.some((s) => String(s || '').trim().length > 0)
  } catch {
    return raw.length > 0
  }
  return false
}

async function resolveStuckTranscription(visitId, visit) {
  if (visit.transcription_status !== 'processing') return visit

  const noteRow = await pool.query('SELECT transcription FROM notes WHERE visit_id = $1', [visitId])
  const hasTx = noteHasTranscript(noteRow.rows[0]?.transcription)

  if (hasTx) {
    await setVisitTranscriptionStatus(visitId, 'completed')
    return { ...visit, transcription_status: 'completed' }
  }

  // Prior run crashed, deferred on unreachable webhook, or was interrupted — allow retry.
  await setVisitTranscriptionStatus(visitId, 'idle')
  return { ...visit, transcription_status: 'idle' }
}

async function queueTranscription(req, res) {
  const { id } = req.params
  let visit = await getVisitForUser(id, req.user)
  if (!visit) {
    return res.status(404).json({ error: 'Visit not found.' })
  }
  if (!visit.audio_file) {
    return res.status(400).json({ error: 'No audio uploaded for this visit.' })
  }

  visit = await resolveStuckTranscription(id, visit)

  if (visit.transcription_status === 'processing') {
    return res.status(202).json({
      message: 'Transcription already in progress.',
      transcription_status: 'processing',
    })
  }

  if (visit.transcription_status === 'completed') {
    const noteRow = await pool.query('SELECT transcription FROM notes WHERE visit_id = $1', [id])
    if (noteHasTranscript(noteRow.rows[0]?.transcription)) {
      return res.status(200).json({
        message: 'Transcription already completed. Use Refresh in the note editor.',
        transcription_status: 'completed',
      })
    }
  }

  res.status(202).json({ message: 'Transcription queued.', transcription_status: 'processing' })
  setImmediate(() => {
    runAIPipeline(id, { user: req.user, req }).catch((err) => console.error('Transcription error:', err.message))
  })
}

// POST /api/visits/:id/generate-ai — legacy name (clinician + scribe)
router.post('/:id/generate-ai', protect, restrict('clinician', 'scribe'), queueTranscription)

// POST /api/visits/:id/transcribe — explicit transcription trigger
router.post('/:id/transcribe', protect, restrict('clinician', 'scribe'), queueTranscription)

module.exports = router
