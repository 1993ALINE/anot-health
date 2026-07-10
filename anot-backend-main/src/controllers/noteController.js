const { sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const cloudWatchAudit = require('../utils/logger')
const { getVisitForUser } = require('../utils/visitAccess')
const { visitDurationSelect, visitTranscriptionStatusSelect } = require('../utils/visitSchemaCompat')
const { addColumnIfMissing } = require('../utils/schemaDdl')

const NOTE_STATUSES = new Set(['draft', 'pending', 'submitted', 'uploaded'])

async function logPhiBulkRead(req, resourceType, count, filters = {}) {
  void auditLog(
    req.user,
    'PHI_BULK_READ',
    resourceType,
    null,
    `Bulk read ${count} ${resourceType} record(s)`,
    {
      req,
      module_key: 'clinical',
      action_category: 'read',
      metadata: { count, ...filters },
    },
  ).catch(reportAuditFailure)
  cloudWatchAudit.logDataAccess(
    req.user.id,
    req.user.role,
    resourceType,
    'bulk',
    'LIST',
    req.clientIp,
    { count, ...filters },
  )
}

// Columns backing the "Upload to EHR" action. The note `status` lifecycle
// (draft → submitted → uploaded/graded) is separate from the EHR push, so we
// track the EHR upload independently via these idempotent columns.
async function ensureEhrColumns() {
  await addColumnIfMissing('notes', 'ehr_uploaded_at', 'ALTER TABLE notes ADD COLUMN IF NOT EXISTS ehr_uploaded_at TIMESTAMPTZ')
  await addColumnIfMissing('notes', 'ehr_uploaded_by', 'ALTER TABLE notes ADD COLUMN IF NOT EXISTS ehr_uploaded_by INTEGER REFERENCES users(id)')
}

// ─── GET NOTE BY VISIT ID ─────────────────────────────────────────────────────
// Read access is gated by visit ownership: clinicians who own the visit,
// scribes assigned to it, or qps/admin.

const getNoteByVisit = async (req, res) => {
  try {
    const { visitId } = req.params

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) return res.status(404).json({ error: 'Note not found for this visit.' })

    const durationCol = await visitDurationSelect('v')
    const txStatusCol = await visitTranscriptionStatusSelect('v')
    const result = await pool.query(
      `SELECT n.*,
              v.visit_type, v.visit_date, v.visit_time,
              ${durationCol}, v.audio_file, ${txStatusCol},
              p.name  AS patient_name, p.mrn,
              c.name  AS clinician_name,
              COALESCE(sb.name, s.name) AS scribe_name,
              COALESCE(n.submitted_by, v.scribe_id) AS actual_scribe_id
       FROM visits   v
       JOIN patients p  ON p.id  = v.patient_id
       JOIN users    c  ON c.id  = v.clinician_id
       LEFT JOIN users s  ON s.id  = v.scribe_id
       LEFT JOIN notes n  ON n.visit_id = v.id
       LEFT JOIN users sb ON sb.id = n.submitted_by
       WHERE v.id = $1`,
      [visitId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Note not found for this visit.' })

    const row = result.rows[0]
    const note = {
      ...row,
      visit_id: row.visit_id ?? parseInt(visitId, 10),
      status: row.status ?? 'pending',
    }

    if (note.id) {
      void auditLog(req.user, 'NOTE_VIEWED', 'note', String(note.id), 'Clinical note accessed', {
        req,
        module_key: 'clinical',
        action_category: 'read',
        metadata: { visit_id: visitId },
      }).catch(reportAuditFailure)
      cloudWatchAudit.logDataAccess(
        req.user.id, req.user.role, 'note', String(note.id), 'READ', req.clientIp,
        { visit_id: visitId },
      )
    }

    res.status(200).json({ note })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── GET MY NOTES (Scribe) ────────────────────────────────────────────────────

const getMyNotes = async (req, res) => {
  try {
    const durationCol = await visitDurationSelect('v')
    const result = await pool.query(
      `SELECT n.*,
              v.visit_type, v.visit_date, v.visit_time,
              ${durationCol}, v.audio_file,
              p.name AS patient_name, p.mrn,
              c.name AS clinician_name, c.id AS clinician_id,
              COALESCE(sb.name, s.name) AS scribe_name
       FROM notes n
       JOIN visits   v  ON v.id  = n.visit_id
       JOIN patients p  ON p.id  = v.patient_id
       JOIN users    c  ON c.id  = v.clinician_id
       LEFT JOIN users s  ON s.id  = v.scribe_id
       LEFT JOIN users sb ON sb.id = n.submitted_by
       WHERE v.scribe_id = $1 OR n.submitted_by = $1
       ORDER BY n.created_at DESC`,
      [req.user.id]
    )
    await logPhiBulkRead(req, 'note', result.rows.length, { scope: 'scribe_my_notes' })
    res.status(200).json({ notes: result.rows })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── GET ALL NOTES (QPS / Admin) ─────────────────────────────────────────────

const getAllNotes = async (req, res) => {
  try {
    const { provider_id, status } = req.query

    const durationCol = await visitDurationSelect('v')
    let query = `
      SELECT n.*,
             v.visit_type, v.visit_date, v.visit_time,
             ${durationCol}, v.audio_file,
             p.name AS patient_name, p.mrn,
             c.name AS clinician_name, c.id AS clinician_id,
             COALESCE(sb.name, s.name) AS scribe_name,
             COALESCE(n.submitted_by, v.scribe_id) AS actual_scribe_id
      FROM notes n
      JOIN visits   v  ON v.id  = n.visit_id
      JOIN patients p  ON p.id  = v.patient_id
      JOIN users    c  ON c.id  = v.clinician_id
      LEFT JOIN users s  ON s.id  = v.scribe_id
      LEFT JOIN users sb ON sb.id = n.submitted_by
      WHERE 1=1
    `
    const params = []

    if (provider_id) { params.push(provider_id); query += ` AND c.id = $${params.length}` }
    if (status) {
      if (!NOTE_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Invalid status filter.' })
      }
      params.push(status);       query += ` AND n.status = $${params.length}`
    }

    query += ' ORDER BY n.created_at DESC'

    const result = await pool.query(query, params)
    await logPhiBulkRead(req, 'note', result.rows.length, {
      scope: 'admin_qps_all_notes',
      provider_id: provider_id || null,
      status: status || null,
    })
    res.status(200).json({ notes: result.rows })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── GET NOTES FOR CLINICIAN REVIEW ──────────────────────────────────────────

const getClinicianNotes = async (req, res) => {
  try {
    const durationCol = await visitDurationSelect('v')
    const result = await pool.query(
      `SELECT n.*,
              v.visit_type, v.visit_date, v.visit_time,
              ${durationCol}, v.audio_file,
              p.name AS patient_name, p.mrn,
              COALESCE(sb.name, s.name) AS scribe_name
       FROM notes n
       JOIN visits   v  ON v.id  = n.visit_id
       JOIN patients p  ON p.id  = v.patient_id
       LEFT JOIN users s  ON s.id  = v.scribe_id
       LEFT JOIN users sb ON sb.id = n.submitted_by
       WHERE v.clinician_id = $1
         AND n.status IN ('submitted', 'uploaded')
       ORDER BY n.updated_at DESC`,
      [req.user.id]
    )
    await logPhiBulkRead(req, 'note', result.rows.length, { scope: 'clinician_review' })
    res.status(200).json({ notes: result.rows })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── GET MY GRADES (Scribe) ───────────────────────────────────────────────────

const getMyGrades = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*,
              p.name AS patient_name, p.mrn,
              v.visit_type, v.visit_date,
              c.name AS clinician_name,
              q.name AS qps_name,
              n.final_note
       FROM grades g
       JOIN notes    n ON n.id  = g.note_id
       JOIN visits   v ON v.id  = n.visit_id
       JOIN patients p ON p.id  = v.patient_id
       JOIN users    c ON c.id  = v.clinician_id
       LEFT JOIN users q ON q.id = g.qps_id
       WHERE n.submitted_by = $1
          OR (n.submitted_by IS NULL AND v.scribe_id = $1)
       ORDER BY g.created_at DESC`,
      [req.user.id]
    )
    await logPhiBulkRead(req, 'grade', result.rows.length, { scope: 'scribe_my_grades' })
    res.status(200).json({ grades: result.rows })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── SAVE DRAFT ───────────────────────────────────────────────────────────────
// Only the scribe assigned to the visit may save a draft, and a note that has
// already been submitted/uploaded is locked from further content changes.

const saveDraft = async (req, res) => {
  try {
    const { visit_id, transcription, ai_draft, final_note } = req.body
    if (!visit_id) return res.status(400).json({ error: 'Visit ID is required.' })

    // Reuse the same access predicate; since req.user.role === 'scribe'
    // (route restriction), this resolves to "is this scribe the assigned one
    // for the visit OR currently assigned to the clinician".
    const visit = await getVisitForUser(visit_id, req.user)
    if (!visit) return res.status(403).json({ error: 'You are not assigned to this visit.' })

    const existing = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [visit_id])

    const hasTranscription = Object.prototype.hasOwnProperty.call(req.body, 'transcription')

    let result
    if (existing.rows.length > 0) {
      const currentStatus = existing.rows[0].status

      // Lock: once a note is submitted or uploaded, content is frozen.
      // Clinicians use request-edit to send it back to draft first.
      if (['submitted', 'uploaded'].includes(currentStatus)) {
        return res.status(409).json({
          error: 'Note is locked (submitted or uploaded). Ask the clinician to request an edit first.',
        })
      }

      const prevRow = await pool.query('SELECT transcription FROM notes WHERE visit_id = $1', [visit_id])
      const mergedTranscription = hasTranscription
        ? (transcription != null && transcription !== '' ? String(transcription) : null)
        : prevRow.rows[0]?.transcription

      result = await pool.query(
        `UPDATE notes
         SET transcription = $1,
             ai_draft      = COALESCE($2, ai_draft),
             final_note    = COALESCE($3, final_note),
             status        = 'draft',
             updated_at    = NOW()
         WHERE visit_id = $4 RETURNING *`,
        [mergedTranscription, ai_draft || null, final_note || null, visit_id]
      )
    } else {
      result = await pool.query(
        `INSERT INTO notes (visit_id, transcription, ai_draft, final_note, status)
         VALUES ($1, $2, $3, $4, 'draft') RETURNING *`,
        [visit_id, transcription || null, ai_draft || null, final_note || null]
      )
    }

    res.status(200).json({ message: 'Draft saved successfully.', note: result.rows[0] })

    const draftAction = existing.rows.length > 0 ? 'UPDATE' : 'CREATE'
    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'note', result.rows[0].id, draftAction, req.clientIp,
      { visit_id: visit_id, stage: 'draft' }
    )
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── SUBMIT NOTE ──────────────────────────────────────────────────────────────
// Scribe-only at the route layer. Here we additionally verify the note's
// visit is one this scribe is allowed to act on, and we wrap the two writes
// + audit in a transaction.

const submitNote = async (req, res) => {
  try {
    const { id }    = req.params
    const scribe_id = req.user.id

    const out = await withTransaction(async (client) => {
      const noteRow = await client.query(
        'SELECT id, visit_id, status, locked_at FROM notes WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      const visit = await getVisitForUser(noteRow.rows[0].visit_id, req.user, client)
      if (!visit) return { forbidden: true }

      // A locked (clinician-finalized) or already submitted/graded note must not
      // be re-submitted — that would reopen finalized clinical documentation and
      // corrupt the QPS grading lifecycle. Clinicians use request-edit to send
      // it back to draft first.
      if (noteRow.rows[0].locked_at || !['pending', 'draft'].includes(noteRow.rows[0].status)) {
        return { conflict: true }
      }

      const upd = await client.query(
        `UPDATE notes
            SET status       = 'submitted',
                submitted_by = $1,
                updated_at   = NOW()
          WHERE id = $2 RETURNING *`,
        [scribe_id, id]
      )

      await client.query(
        `UPDATE visits SET status = 'note-ready' WHERE id = $1`,
        [upd.rows[0].visit_id]
      )

      await auditLog(
        req.user,
        'NOTE_SUBMITTED',
        'note',
        String(id),
        `Note submitted for visit: ${upd.rows[0].visit_id}`,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'success' }
      )

      return { note: upd.rows[0] }
    })

    if (out.notFound)  return res.status(404).json({ error: 'Note not found.' })
    if (out.forbidden) return res.status(403).json({ error: 'Not authorized for this note.' })
    if (out.conflict) {
      return res.status(409).json({
        error: 'Note is already submitted, locked, or graded. Ask the clinician to request an edit first.',
      })
    }

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'note', id, 'UPDATE', req.clientIp,
      { visit_id: out.note.visit_id, stage: 'submitted' }
    )

    res.status(200).json({ message: 'Note submitted successfully.', note: out.note })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── UPDATE NOTE CONTENT ──────────────────────────────────────────────────────
// Clinician-only. Allows clinicians to directly edit note content before locking.
// Only blocks editing if the note has been locked by the clinician (locked_at is set).

const updateNoteContent = async (req, res) => {
  try {
    const { id } = req.params
    const { final_note } = req.body

    if (!final_note || typeof final_note !== 'string') {
      return res.status(400).json({ error: 'final_note is required.' })
    }

    const out = await withTransaction(async (client) => {
      const noteRow = await client.query(
        'SELECT id, visit_id, status, locked_at FROM notes WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      const note = noteRow.rows[0]

      // Only block editing if the note has been locked by the clinician
      if (note.locked_at) {
        return { 
          locked: true, 
          message: 'Note is already locked and cannot be edited.' 
        }
      }

      const visit = await getVisitForUser(note.visit_id, req.user, client)
      if (!visit) return { forbidden: true }

      const updated = await client.query(
        `UPDATE notes 
         SET final_note = $1, 
             updated_at = NOW() 
         WHERE id = $2 
         RETURNING *`,
        [final_note, id]
      )

      await auditLog(
        req.user,
        'NOTE_CONTENT_UPDATED',
        'note',
        String(id),
        `Clinician edited note content for visit: ${note.visit_id}`,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'success' }
      )

      return { note: updated.rows[0] }
    })

    if (out.notFound) return res.status(404).json({ error: 'Note not found.' })
    if (out.forbidden) return res.status(403).json({ error: 'Not authorized for this note.' })
    if (out.locked) return res.status(409).json({ error: out.message })

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'note', id, 'UPDATE', req.clientIp,
      { visit_id: out.note.visit_id, stage: 'content_edit' }
    )

    res.status(200).json({ message: 'Note updated successfully.', note: out.note })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── REQUEST EDIT ─────────────────────────────────────────────────────────────
// Clinician-only at route layer. Verifies the note belongs to their visit.

const requestEdit = async (req, res) => {
  try {
    const { id } = req.params
    const rawMsg = req.body?.message
    const message = typeof rawMsg === 'string' ? rawMsg.trim().slice(0, 500) : ''
    const details = message
      ? `Edit requested by clinician — ${message}`
      : 'Edit requested by clinician'

    const out = await withTransaction(async (client) => {
      const noteRow = await client.query(
        'SELECT id, visit_id FROM notes WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      const visit = await getVisitForUser(noteRow.rows[0].visit_id, req.user, client)
      if (!visit) return { forbidden: true }

      // Reopening for edits also releases the clinician lock; otherwise the
      // scribe could never re-submit (and the clinician could never re-edit).
      await client.query(
        `UPDATE notes
            SET status = 'draft',
                locked_at = NULL,
                locked_by = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [id]
      )
      await client.query(
        `UPDATE visits SET status = 'recording-uploaded' WHERE id = $1`,
        [noteRow.rows[0].visit_id]
      )
      await auditLog(
        req.user,
        'EDIT_REQUESTED',
        'note',
        String(id),
        details,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'warning' }
      )

      return { ok: true }
    })

    if (out.notFound)  return res.status(404).json({ error: 'Note not found.' })
    if (out.forbidden) return res.status(403).json({ error: 'Not authorized for this note.' })

    res.status(200).json({ message: 'Edit requested.' })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── UPLOAD TO EHR ────────────────────────────────────────────────────────────
// Scribe-only at the route layer. Marks a finalized note as pushed to the EHR,
// recording when and by which scribe. Idempotent: re-uploading a note that is
// already marked returns the existing state rather than overwriting it.

const uploadToEHR = async (req, res) => {
  try {
    const { id }    = req.params
    const scribe_id = req.user.id

    await ensureEhrColumns()

    const out = await withTransaction(async (client) => {
      const noteRow = await client.query(
        'SELECT id, visit_id, status, ehr_uploaded_at FROM notes WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      const visit = await getVisitForUser(noteRow.rows[0].visit_id, req.user, client)
      if (!visit) return { forbidden: true }

      // Only finalized notes (submitted to the clinician or QPS-graded) may be
      // pushed to the EHR — drafts are still in progress.
      if (!['submitted', 'uploaded'].includes(noteRow.rows[0].status)) {
        return { invalidStatus: true }
      }

      // Already uploaded — no double write, no duplicate audit entry.
      if (noteRow.rows[0].ehr_uploaded_at) {
        const existing = await client.query('SELECT * FROM notes WHERE id = $1', [id])
        return { already: true, note: existing.rows[0] }
      }

      const upd = await client.query(
        `UPDATE notes
            SET ehr_uploaded_at = NOW(),
                ehr_uploaded_by = $1,
                updated_at      = NOW()
          WHERE id = $2 RETURNING *`,
        [scribe_id, id]
      )

      await auditLog(
        req.user,
        'NOTE_UPLOADED_EHR',
        'note',
        String(id),
        `Note uploaded to EHR for visit: ${upd.rows[0].visit_id}`,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'success' }
      )

      return { note: upd.rows[0] }
    })

    if (out.notFound)      return res.status(404).json({ error: 'Note not found.' })
    if (out.forbidden)     return res.status(403).json({ error: 'Not authorized for this note.' })
    if (out.invalidStatus) return res.status(409).json({ error: 'Only finalized notes can be uploaded to the EHR.' })
    if (out.already)       return res.status(200).json({ message: 'Note already uploaded to EHR.', note: out.note })

    res.status(200).json({ message: 'Note uploaded to EHR.', note: out.note })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

// ─── SUBMIT GRADE ─────────────────────────────────────────────────────────────
// All four scores are validated as integers in [0,100]. Without this, sending
// strings produced string-concat in `accuracy + completeness + ...` and stored
// nonsense `overall_score` values.

function validateScore(name, value) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
    return `${name} must be an integer between 0 and 100.`
  }
  return null
}

const submitGrade = async (req, res) => {
  try {
    const { note_id, accuracy, completeness, terminology, formatting, comment } = req.body
    const qps_id = req.user.id

    if (!note_id) return res.status(400).json({ error: 'Note ID is required.' })

    for (const [k, v] of Object.entries({ accuracy, completeness, terminology, formatting })) {
      const err = validateScore(k, v)
      if (err) return res.status(400).json({ error: err })
    }

    const a = Number(accuracy), c = Number(completeness), t = Number(terminology), f = Number(formatting)
    const overall = Math.round((a + c + t + f) / 4)

    const out = await withTransaction(async (client) => {
      const noteRow = await client.query(
        'SELECT id, visit_id FROM notes WHERE id = $1 FOR UPDATE',
        [note_id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      const result = await client.query(
        `INSERT INTO grades
           (note_id, qps_id, accuracy, completeness, terminology, formatting, overall_score, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (note_id) DO UPDATE
           SET accuracy = $3, completeness = $4, terminology = $5,
               formatting = $6, overall_score = $7, comment = $8, qps_id = $2
         RETURNING *`,
        [note_id, qps_id, a, c, t, f, overall, comment || null]
      )

      await client.query(
        `UPDATE notes SET status = 'uploaded', updated_at = NOW() WHERE id = $1`,
        [note_id]
      )
      await client.query(
        `UPDATE visits SET status = 'uploaded' WHERE id = $1`,
        [noteRow.rows[0].visit_id]
      )
      await auditLog(
        req.user,
        'GRADE_SUBMITTED',
        'note',
        String(note_id),
        `Grade: ${overall}/100`,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'success' }
      )

      return { grade: result.rows[0] }
    })

    if (out.notFound) return res.status(404).json({ error: 'Note not found.' })

    res.status(201).json({ message: 'Grade submitted successfully.', grade: out.grade })
  } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
  }
}

module.exports = {
  getNoteByVisit, getMyNotes, getAllNotes, getClinicianNotes,
  getMyGrades, saveDraft, submitNote, updateNoteContent, requestEdit, uploadToEHR, submitGrade,
  logPhiBulkRead,
}
