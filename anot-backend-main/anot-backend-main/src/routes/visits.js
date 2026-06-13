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
  lockNote,
} = require('../controllers/visitController')
const { protect, restrict } = require('../middleware/auth')

// Clinician routes
router.get('/my', protect, restrict('clinician'), getVisitsByDate)
router.get('/history', protect, restrict('clinician'), getVisitHistory)
router.post('/', protect, restrict('clinician'), createVisit)
router.put('/:id/end', protect, restrict('clinician'), endVisit)
router.put('/:id/status', protect, restrict('clinician', 'scribe'), updateVisitStatus)
router.put('/:id', protect, restrict('clinician'), updateVisit)
router.delete('/:id', protect, restrict('clinician'), deleteVisit)
router.post('/:id/lock-note', protect, restrict('clinician'), lockNote)

// Clinician (own visits), Scribe (assigned visits) and QPS (review) — the
// controller scopes results per role. Admins do not work with the visit list.
router.get('/', protect, restrict('clinician', 'scribe', 'qps'), getAllVisits)

const pool = require('../config/db')
const { runAIPipeline, generateAINote } = require('../utils/aiPipeline')
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

function parseTranscriptionSegments(transcription) {
  if (!transcription) return []
  const raw = String(transcription).trim()
  if (!raw || raw === '[]' || raw === 'null') return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((s) => String(s || '').trim()).filter(Boolean)
    }
    const one = String(parsed || '').trim()
    return one ? [one] : []
  } catch {
    return raw.length > 0 ? [raw] : []
  }
}

const AI_DRAFT_UNAVAILABLE =
  '[AI draft unavailable — add an Anthropic API key in Admin → Settings or ANTHROPIC_API_KEY to the server .env file, then click Transcribe audio or Refresh.]'

async function generateDraft(req, res) {
  try {
    const { id } = req.params
    const visit = await getVisitForUser(id, req.user)
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found.' })
    }

    const detail = await pool.query(
      `
        SELECT v.visit_type, v.visit_date, p.name AS patient_name, p.mrn
        FROM visits v
        JOIN patients p ON p.id = v.patient_id
        WHERE v.id = $1
      `,
      [id],
    )
    const row = detail.rows[0]
    if (!row) {
      return res.status(404).json({ error: 'Visit not found.' })
    }

    const noteRow = await pool.query('SELECT id, transcription, status FROM notes WHERE visit_id = $1', [id])
    const segments = parseTranscriptionSegments(noteRow.rows[0]?.transcription)
    if (!segments.length) {
      return res.status(400).json({ error: 'No transcription available for this visit.' })
    }

    if (noteRow.rows.length > 0 && !['pending', 'draft'].includes(noteRow.rows[0].status)) {
      return res.status(409).json({ error: 'Note is locked.' })
    }

    let aiDraft = await generateAINote(segments, {
      patient_name: row.patient_name,
      mrn: row.mrn,
      visit_type: row.visit_type,
      visit_date: row.visit_date,
    })
    if (!aiDraft) {
      aiDraft = AI_DRAFT_UNAVAILABLE
    }

    if (noteRow.rows.length > 0) {
      await pool.query(
        `
          UPDATE notes
          SET ai_draft = $1, updated_at = NOW()
          WHERE visit_id = $2
        `,
        [aiDraft, id],
      )
    } else {
      await pool.query(
        `
          INSERT INTO notes (visit_id, transcription, ai_draft, status)
          VALUES ($1, $2, $3, 'pending')
        `,
        [id, JSON.stringify(segments), aiDraft],
      )
    }

    return res.status(200).json({ ai_draft: aiDraft })
  } catch (err) {
    console.error('Generate draft error:', err.message)
    return res.status(500).json({ error: 'Failed to generate AI draft.' })
  }
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

// POST /api/visits/:id/generate-draft — manual AI draft generation from saved transcriptions
router.post('/:id/generate-draft', protect, restrict('scribe'), generateDraft)


module.exports = router
