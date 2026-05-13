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

const { runAIPipeline } = require('../utils/aiPipeline')
const { getVisitForUser } = require('../utils/visitAccess')

async function queueTranscription(req, res) {
  const { id } = req.params
  const visit = await getVisitForUser(id, req.user)
  if (!visit) {
    return res.status(404).json({ error: 'Visit not found.' })
  }
  if (!visit.audio_file) {
    return res.status(400).json({ error: 'No audio uploaded for this visit.' })
  }
  if (visit.transcription_status === 'processing') {
    return res.status(202).json({
      message: 'Transcription already in progress.',
      transcription_status: 'processing',
    })
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
