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
router.put('/:id/lock-note',  protect, restrict('clinician'), lockNote)

const { visitEvents } = require('../utils/visitEvents')

// Real-time Server-Sent Events stream for clinicians and scribes
router.get('/events', protect, restrict('clinician', 'scribe', 'admin', 'super_admin'), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }

  res.write(`event: connected\ndata: ${JSON.stringify({ connected: true, userId: req.user.id, timestamp: Date.now() })}\n\n`)

  const userId = req.user.id
  const eventChannel = `clinician:${userId}`

  const onVisitEvent = (eventData) => {
    try {
      res.write(`event: visit_update\ndata: ${JSON.stringify(eventData)}\n\n`)
    } catch {
      // client disconnected
    }
  }

  visitEvents.on(eventChannel, onVisitEvent)
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    visitEvents.on('all', onVisitEvent)
  }

  const heartbeatId = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(heartbeatId)
    }
  }, 20000)

  req.on('close', () => {
    clearInterval(heartbeatId)
    visitEvents.off(eventChannel, onVisitEvent)
    if (req.user.role === 'admin' || req.user.role === 'super_admin') {
      visitEvents.off('all', onVisitEvent)
    }
  })
})

// Clinician (own visits), Scribe (assigned visits), QPS (review), and Admins (all) — the
// controller scopes results per role.
router.get('/', protect, restrict('clinician', 'scribe', 'qps', 'admin', 'super_admin'), getAllVisits)

const pool = require('../config/db')
const { generateAINote } = require('../utils/aiPipeline')
const { extractDictatedPatientDetails } = require('../utils/aiPipelineHelpers')
const { enqueueTranscription } = require('../services/transcriptionQueue')
const { getVisitForUser } = require('../utils/visitAccess')
const { setVisitTranscriptionStatus } = require('../utils/visitSchemaCompat')
const { resolveTemplateSections } = require('../utils/noteTemplateSections')
const { formatClinicalDictationToSOAP } = require('../utils/clinicalSoapSynthesizer')

const TRANSCRIPTION_UNAVAILABLE_RE = /^\[Recording \d+: transcription unavailable\]$/i

function segmentIsRealTranscript(text) {
  const s = String(text || '').trim()
  if (!s) return false
  return !TRANSCRIPTION_UNAVAILABLE_RE.test(s)
}

function noteHasTranscript(transcription) {
  if (!transcription) return false
  const raw = String(transcription).trim()
  if (!raw || raw === '[]' || raw === 'null') return false
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.some((s) => segmentIsRealTranscript(s))
    }
  } catch {
    return segmentIsRealTranscript(raw)
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

/**
 * Load visit detail for draft generation
 */
async function loadVisitDetailForDraft(visitId) {
  const detail = await pool.query(
    `
      SELECT v.visit_type, v.visit_date, v.clinician_id, COALESCE(p.name, 'Patient') AS patient_name, COALESCE(p.mrn, 'Auto-generated') AS mrn, p.date_of_birth
      FROM visits v
      LEFT JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1
    `,
    [visitId],
  )
  return detail.rows[0] || null
}

/**
 * Load note transcription segments for draft generation
 */
async function loadNoteForDraft(visitId) {
  const noteRow = await pool.query('SELECT id, transcription, status FROM notes WHERE visit_id = $1', [visitId])
  const note = noteRow.rows[0]
  const segments = parseTranscriptionSegments(note?.transcription)
  return { note, segments }
}

/**
 * Validate note is editable for draft generation
 */
function validateNoteEditableForDraft(note) {
  if (note && !['pending', 'draft'].includes(note.status)) {
    throw Object.assign(new Error('Note is locked.'), { status: 409 })
  }
}

/**
 * Persist AI draft to notes table
 */
async function saveAiDraftToNote(visitId, aiDraft, segments, existingNote) {
  if (existingNote) {
    await pool.query(
      `UPDATE notes 
       SET ai_draft = $1, 
           final_note = CASE WHEN final_note IS NULL OR final_note = '' OR final_note = ai_draft THEN $1 ELSE final_note END,
           updated_at = NOW() 
       WHERE visit_id = $2`,
      [aiDraft, visitId],
    )
  } else {
    await pool.query(
      `INSERT INTO notes (visit_id, transcription, ai_draft, final_note, status) VALUES ($1, $2, $3, $3, 'pending')`,
      [visitId, JSON.stringify(segments), aiDraft],
    )
  }
}

/**
 * Handle generate draft errors
 */
function handleGenerateDraftError(res, err) {
  console.error('Generate draft error:', err.message)
  const status = err.status || 500
  res.status(status).json({ error: err.status ? err.message : 'Failed to generate AI draft.' })
}

/**
 * Generate AI draft route handler
 */
async function generateDraft(req, res) {
  try {
    const { id } = req.params
    const visit = await getVisitForUser(id, req.user)
    if (!visit) return res.status(404).json({ error: 'Visit not found.' })

    const row = await loadVisitDetailForDraft(id)
    if (!row) return res.status(404).json({ error: 'Visit not found.' })

    const { note, segments } = await loadNoteForDraft(id)
    if (!segments.length) {
      return res.status(400).json({ error: 'No transcription available for this visit.' })
    }

    validateNoteEditableForDraft(note)

    const requestedTemplate = req.body?.template || req.body?.template_id || req.body?.visit_type || row.visit_type
    const templateSections = await resolveTemplateSections(row.clinician_id, requestedTemplate, 'generate-draft')

    // Age dictated in the transcript itself ("63-year-old male...") takes priority over
    // the on-file date_of_birth for this note — it's what the clinician actually said.
    const dictated = extractDictatedPatientDetails(segments.join(' '))

    let aiDraft = await generateAINote(segments, {
      patient_name: row.patient_name,
      date_of_birth: row.date_of_birth,
      dictated_age: dictated?.age,
      dictated_gender: dictated?.gender,
      mrn: row.mrn,
      visit_type: row.visit_type,
      visit_date: row.visit_date,
    }, templateSections)
    let aiUsed = true
    if (!aiDraft || aiDraft === AI_DRAFT_UNAVAILABLE) {
      aiUsed = false
      const combinedTx = segments.join('\n\n')
      aiDraft = formatClinicalDictationToSOAP(combinedTx, '', row.visit_type, {
        patientName: row.patient_name,
        mrn: row.mrn,
      })
    }

    await saveAiDraftToNote(id, aiDraft, segments, note)

    try {
      const { emitVisitEvent, getDeviceTypeFromRequest } = require('../utils/visitEvents')
      emitVisitEvent(row.clinician_id, {
        type: 'AI_DRAFT_READY',
        visitId: Number(id) || id,
        status: 'draft',
        action: 'draft_ready',
        source: getDeviceTypeFromRequest(req),
      })
    } catch (e) {
      console.warn('[visits] emitVisitEvent failed:', e.message)
    }

    return res.status(200).json({
      ai_draft: aiDraft,
      ai_used: aiUsed,
      ai_warning: aiUsed ? undefined : 'AI note generation failed or is not configured. This note was generated using the template synthesizer. Please check Admin → Settings → Anthropic API key.',
    })
  } catch (err) {
    handleGenerateDraftError(res, err)
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

  // Only reset a stuck 'processing' state when no pipeline has started recently —
  // avoids racing an in-flight Deepgram/Anthropic job. Default 30 min for long audio.
  const STUCK_MS = parseInt(process.env.TRANSCRIPTION_STUCK_MS || process.env.MAX_POLL_WAIT || '1800000', 10)
  const started = await pool.query(
    `SELECT created_at FROM audit_logs
     WHERE entity_type = 'visit' AND entity_id = $1 AND action = 'TRANSCRIPTION_STARTED'
     ORDER BY created_at DESC LIMIT 1`,
    [String(visitId)],
  )
  const startedAt = started.rows[0]?.created_at
  if (startedAt && Date.now() - new Date(startedAt).getTime() < STUCK_MS) {
    return visit
  }

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
    enqueueTranscription(id, { user: req.user, req }).catch((err) => console.error('Transcription error:', err.message))
  })
}

// POST /api/visits/:id/generate-ai — legacy name (clinician + scribe)
router.post('/:id/generate-ai', protect, restrict('clinician', 'scribe'), queueTranscription)

// POST /api/visits/:id/transcribe — explicit transcription trigger
router.post('/:id/transcribe', protect, restrict('clinician', 'scribe'), queueTranscription)

// POST /api/visits/:id/generate-draft — manual AI draft generation from saved transcriptions
router.post('/:id/generate-draft', protect, restrict('clinician', 'scribe', 'admin', 'super_admin'), generateDraft)


module.exports = router
