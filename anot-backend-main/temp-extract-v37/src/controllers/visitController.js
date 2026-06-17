const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const cloudWatchAudit = require('../utils/logger')
const { runAIPipeline } = require('../utils/aiPipeline')
const {
  visitDurationSelect,
  visitTranscriptionStatusSelect,
  visitHasDurationSeconds,
} = require('../utils/visitSchemaCompat')
const { getVisitForUser } = require('../utils/visitAccess')
const { addColumnIfMissing } = require('../utils/schemaDdl')
const { deleteAudio, dbPathToKey } = require('../services/s3Storage')

async function ensureNoteLockColumns() {
  await addColumnIfMissing('notes', 'locked_at', 'ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ')
  await addColumnIfMissing('notes', 'locked_by', 'ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id)')
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
}

function isHmTime(s) {
  return typeof s === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(s)
}

// Must stay in sync with DB constraint `visits_visit_type_check` (see migrations/).
const ALLOWED_VISIT_TYPES = ['Follow-up', 'New Patient', 'Virtual Visit', 'Other']

// ─── GET VISITS BY DATE FOR CLINICIAN ────────────────────────────────────────

const getVisitsByDate = async (req, res) => {
  try {
    const { date } = req.query
    const clinician_id = req.user.id

    // We *prefer* a client-supplied date because "today" depends on the user's
    // timezone, not the Railway container's. If the client doesn't send one,
    // we fall back to the server-local date, which is best-effort only.
    const d = new Date()
    const localDate = date || `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

    if (!isIsoDate(localDate)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD.' })
    }

    const durationCol = await visitDurationSelect('v')
    const result = await pool.query(
      `SELECT
         v.id, v.visit_date, v.visit_time, v.visit_type, v.status,
         ${durationCol}, v.audio_file,
         p.id as patient_id, p.name as patient_name, p.mrn, p.date_of_birth,
         u.name as scribe_name, u.id as scribe_id,
         n.id as note_id, n.status as note_status,
         n.ai_draft, n.transcription, n.updated_at as note_updated_at
       FROM visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users u ON u.id = v.scribe_id
       LEFT JOIN notes n ON n.visit_id = v.id
       WHERE v.clinician_id = $1 AND v.visit_date = $2
       ORDER BY v.visit_time ASC`,
      [clinician_id, localDate]
    )

    res.status(200).json({ visits: result.rows })

    void auditLog(
      req.user,
      'VISITS_VIEWED',
      'visit',
      null,
      `Viewed ${result.rows.length} visit(s) for ${localDate}`,
      {
        req,
        module_key: 'clinical',
        action_category: 'read',
        status: 'success',
        metadata: { scope: 'by_date', date: localDate, count: result.rows.length },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', null, 'READ', req.clientIp,
      { scope: 'by_date', date: localDate, count: result.rows.length }
    )
  } catch (err) {
    console.error('Get visits error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── GET ALL VISITS (scribe / qps / admin / clinician view) ──────────────────
// Per-role scoping is applied here so clinicians only see their own visits
// and scribes only see visits assigned to them. qps/admin see everything.

const getAllVisits = async (req, res) => {
  try {
    const { provider_id, date } = req.query
    const user_id  = req.user.id
    const userRole = req.user.role

    const durationCol = await visitDurationSelect('v')
    const txStatusCol = await visitTranscriptionStatusSelect('v')
    let query = `
      SELECT
        v.id, v.visit_date, v.visit_time, v.visit_type, v.status,
        ${durationCol}, v.audio_file, ${txStatusCol},
        p.id as patient_id, p.name as patient_name, p.mrn,
        c.name as clinician_name, c.id as clinician_id,
        s.name as scribe_name, s.id as scribe_id,
        n.id as note_id, n.status as note_status, n.updated_at as note_updated_at
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
      JOIN users c    ON c.id = v.clinician_id
      LEFT JOIN users s ON s.id = v.scribe_id
      LEFT JOIN notes n ON n.visit_id = v.id
      WHERE 1=1
    `

    const params = []
    if (provider_id) {
      params.push(provider_id)
      query += ` AND v.clinician_id = $${params.length}`
    }

    if (date) {
      if (!isIsoDate(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD.' })
      }
      params.push(date)
      query += ` AND v.visit_date = $${params.length}`
    }

    if (userRole === 'scribe') {
      params.push(user_id)
      query += ` AND (
        v.clinician_id IN (
          SELECT clinician_id FROM scribe_assignments WHERE scribe_id = $${params.length}
        )
        OR v.id IN (SELECT visit_id FROM notes WHERE submitted_by = $${params.length})
      )`
    } else if (userRole === 'clinician') {
      // Clinicians may only see their own visits via this endpoint.
      params.push(user_id)
      query += ` AND v.clinician_id = $${params.length}`
    }
    // qps + admin: no additional scoping — they see everything.

    query += ' ORDER BY v.visit_date DESC, v.visit_time ASC'

    const result = await pool.query(query, params)
    res.status(200).json({ visits: result.rows })

    void auditLog(
      req.user,
      'VISITS_VIEWED',
      'visit',
      null,
      `Viewed visit list (${result.rows.length} record(s))`,
      {
        req,
        module_key: 'clinical',
        action_category: 'read',
        status: 'success',
        metadata: { scope: 'list', count: result.rows.length, provider_id: provider_id || null, date: date || null },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', null, 'READ', req.clientIp,
      { scope: 'list', count: result.rows.length }
    )
  } catch (err) {
    console.error('Get all visits error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── CREATE VISIT ─────────────────────────────────────────────────────────────

const createVisit = async (req, res) => {
  try {
    const { patient_id, visit_date, visit_time, visit_type } = req.body
    const clinician_id = req.user.id

    if (!patient_id || !visit_date || !visit_time || !visit_type) {
      return res.status(400).json({ error: 'Patient, date, time and visit type are required.' })
    }

    const pid = parseInt(patient_id, 10)
    if (!Number.isInteger(pid)) {
      return res.status(400).json({ error: 'Invalid patient.' })
    }
    if (!isIsoDate(visit_date)) {
      return res.status(400).json({ error: 'visit_date must be YYYY-MM-DD.' })
    }
    if (!isHmTime(String(visit_time).trim())) {
      return res.status(400).json({ error: 'visit_time must be HH:MM (24h).' })
    }
    const visitTypeStr = String(visit_type).trim()
    if (!visitTypeStr || visitTypeStr.length > 200) {
      return res.status(400).json({ error: 'Invalid visit type.' })
    }
    if (!ALLOWED_VISIT_TYPES.includes(visitTypeStr)) {
      return res.status(400).json({
        error: `visit_type must be one of: ${ALLOWED_VISIT_TYPES.join(', ')}.`,
      })
    }

    // Pick the most-recently-assigned scribe deterministically (was non-deterministic
    // before — `LIMIT 1` with no ORDER BY).
    const assignResult = await pool.query(
      'SELECT scribe_id FROM scribe_assignments WHERE clinician_id = $1 ORDER BY assigned_at DESC LIMIT 1',
      [clinician_id]
    )
    const scribe_id = assignResult.rows[0]?.scribe_id || null

    const result = await pool.query(
      `INSERT INTO visits (patient_id, clinician_id, scribe_id, visit_date, visit_time, visit_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'upcoming') RETURNING *`,
      [pid, clinician_id, scribe_id, visit_date, String(visit_time).trim(), visitTypeStr]
    )

    const full = await pool.query(
      `SELECT v.*, p.name as patient_name, p.mrn
       FROM visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.id = $1`,
      [result.rows[0].id]
    )

    res.status(201).json({ message: 'Visit scheduled successfully.', visit: full.rows[0] })

    // Fire-and-forget: the row is already committed, so an audit failure must
    // not turn a successful create into a 500. reportAuditFailure surfaces it.
    void auditLog(
      req.user,
      'VISIT_CREATED',
      'visit',
      String(result.rows[0].id),
      `Visit scheduled (${visitTypeStr}) for ${visit_date} ${String(visit_time).trim()}`,
      {
        req,
        module_key: 'clinical',
        action_category: 'create',
        status: 'success',
        metadata: {
          visit_id: result.rows[0].id,
          patient_id: pid,
          visit_date,
          visit_type: visitTypeStr,
        },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', result.rows[0].id, 'CREATE', req.clientIp,
      { patient_id: pid, visit_type: visitTypeStr }
    )
  } catch (err) {
    console.error('Create visit error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── UPDATE VISIT STATUS ──────────────────────────────────────────────────────
// The route layer restricts to clinician/scribe/admin; here we additionally
// require the actor to have access to the visit (clinicians own it, scribes
// are assigned, admins always).

const updateVisitStatus = async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    const validStatuses = ['scheduled', 'upcoming', 'in-progress', 'recording-uploaded', 'note-ready', 'done', 'uploaded']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' })
    }

    const { getVisitForUser } = require('../utils/visitAccess')
    const accessible = await getVisitForUser(id, req.user)
    if (!accessible) return res.status(404).json({ error: 'Visit not found.' })

    // Enforce the visit lifecycle: only adjacent moves are allowed, and a
    // finalized ('uploaded') visit is immutable through this endpoint. This
    // stops a fresh visit being jumped straight to 'uploaded', or a graded
    // visit being reverted, which would desync the visit/note workflow.
    const ALLOWED_TRANSITIONS = {
      scheduled: ['upcoming', 'in-progress'],
      upcoming: ['scheduled', 'in-progress'],
      'in-progress': ['upcoming', 'recording-uploaded'],
      'recording-uploaded': ['in-progress', 'note-ready'],
      'note-ready': ['recording-uploaded', 'done', 'uploaded'],
      done: ['uploaded'],
      uploaded: [],
    }
    const current = accessible.status
    const allowed = ALLOWED_TRANSITIONS[current] || []
    if (status !== current && !allowed.includes(status)) {
      return res.status(409).json({
        error: `Cannot change visit status from '${current}' to '${status}'.`,
      })
    }

    const result = await pool.query(
      'UPDATE visits SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    )

    if (!result.rows[0]) return res.status(404).json({ error: 'Visit not found.' })

    res.status(200).json({ message: 'Visit status updated.', visit: result.rows[0] })

    void auditLog(
      req.user,
      'VISIT_STATUS_UPDATED',
      'visit',
      String(id),
      `Visit status changed: ${current} → ${status}`,
      {
        req,
        module_key: 'clinical',
        action_category: 'update',
        status: 'success',
        metadata: { visit_id: Number(id) || id, changes: { status: { from: current, to: status } } },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', id, 'UPDATE', req.clientIp,
      { changes: { status: { from: current, to: status } } }
    )
  } catch (err) {
    console.error('Update visit status error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── END VISIT — triggers AI pipeline ────────────────────────────────────────
// Now performs the visit-status flip + auto-create-note + audit insert in a
// single transaction, with a row lock on the visit so two concurrent endVisit
// calls can't both insert a note (race that previously existed).

const endVisit = async (req, res) => {
  try {
    const { id } = req.params
    const { duration_seconds } = req.body

    const visit = await withTransaction(async (client) => {
      // Lock the visit row scoped to this clinician — also enforces ownership.
      const lock = await client.query(
        `SELECT * FROM visits WHERE id = $1 AND clinician_id = $2 FOR UPDATE`,
        [id, req.user.id]
      )
      if (!lock.rows[0]) return { notFound: true }

      if (!lock.rows[0].audio_file) {
        return { noAudio: true }
      }

      const hasDuration = await visitHasDurationSeconds()
      const updated = hasDuration
        ? await client.query(
            `UPDATE visits
                SET status = 'recording-uploaded', duration_seconds = $1
              WHERE id = $2
              RETURNING *`,
            [duration_seconds || 0, id]
          )
        : await client.query(
            `UPDATE visits SET status = 'recording-uploaded' WHERE id = $1 RETURNING *`,
            [id]
          )

      // Auto-create note if not exists. Inside the transaction + visit lock
      // this is now race-free.
      const existingNote = await client.query(
        'SELECT id FROM notes WHERE visit_id = $1', [id]
      )
      if (existingNote.rows.length === 0) {
        await client.query(
          `INSERT INTO notes (visit_id, status) VALUES ($1, 'pending')`,
          [id]
        )
      }

      // Audit inside the transaction — if it fails the whole op rolls back.
      await auditLog(
        req.user,
        'VISIT_ENDED',
        'visit',
        String(id),
        `Visit ended — duration: ${duration_seconds}s`,
        client,
        { req, module_key: 'clinical', action_category: 'update', status: 'success' }
      )

      return { visit: updated.rows[0] }
    })

    if (visit.notFound) return res.status(404).json({ error: 'Visit not found.' })
    if (visit.noAudio)  return res.status(400).json({ error: 'Cannot end visit before any audio is uploaded.' })

    res.status(200).json({ message: 'Visit ended. AI transcription starting...', visit: visit.visit })

    // Run AI pipeline in background (non-blocking)
    setImmediate(() => {
      runAIPipeline(id, { user: req.user, req }).catch(err => console.error('Background AI error:', err.message))
    })

  } catch (err) {
    console.error('End visit error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── UPDATE VISIT ─────────────────────────────────────────────────────────────

const updateVisit = async (req, res) => {
  try {
    const { id } = req.params
    const { visit_time, visit_type } = req.body

    if (!isHmTime(String(visit_time || '').trim())) {
      return res.status(400).json({ error: 'visit_time must be HH:MM (24h).' })
    }
    const vtype = String(visit_type || '').trim()
    if (!ALLOWED_VISIT_TYPES.includes(vtype)) {
      return res.status(400).json({
        error: `visit_type must be one of: ${ALLOWED_VISIT_TYPES.join(', ')}.`,
      })
    }

    const result = await pool.query(
      `UPDATE visits SET visit_time = $1, visit_type = $2
       WHERE id = $3 AND clinician_id = $4 RETURNING *`,
      [String(visit_time).trim(), vtype, id, req.user.id]
    )

    if (!result.rows[0]) return res.status(404).json({ error: 'Visit not found.' })

    res.status(200).json({ message: 'Visit updated.', visit: result.rows[0] })

    void auditLog(
      req.user,
      'VISIT_UPDATED',
      'visit',
      String(id),
      'Visit details updated (time/type)',
      {
        req,
        module_key: 'clinical',
        action_category: 'update',
        status: 'success',
        metadata: {
          visit_id: Number(id) || id,
          changes: { visit_time: String(visit_time).trim(), visit_type: vtype },
        },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', id, 'UPDATE', req.clientIp,
      { updated_fields: ['visit_time', 'visit_type'] }
    )
  } catch (err) {
    console.error('Update visit error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── DELETE VISIT ─────────────────────────────────────────────────────────────
// Transactional: notes + visit + audit all-or-nothing. Also deletes any S3
// audio objects the visit owned so we don't leak storage.

const deleteVisit = async (req, res) => {
  try {
    const { id } = req.params

    const audioFiles = await withTransaction(async (client) => {
      const check = await client.query(
        'SELECT status, clinician_id, audio_file FROM visits WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!check.rows[0]) return { notFound: true }
      if (check.rows[0].clinician_id !== req.user.id) return { forbidden: true }

      await client.query('DELETE FROM notes WHERE visit_id = $1', [id])
      await client.query('DELETE FROM visits WHERE id = $1', [id])

      await auditLog(
        req.user,
        'VISIT_DELETED',
        'visit',
        String(id),
        'Visit deleted',
        client,
        { req, module_key: 'clinical', action_category: 'delete', status: 'critical' }
      )

      return { files: (check.rows[0].audio_file || '').split(',').map(s => s.trim()).filter(Boolean) }
    })

    if (audioFiles.notFound)  return res.status(404).json({ error: 'Visit not found.' })
    if (audioFiles.forbidden) return res.status(403).json({ error: 'Not authorized.' })

    // Best-effort cleanup of S3 audio objects after the DB commit. We
    // deliberately do this AFTER commit so a delete that succeeds in DB isn't
    // undone by an S3 error.
    for (const rel of audioFiles.files || []) {
      if (!/^\/uploads\/[\w.\-]+$/.test(rel)) continue
      deleteAudio(dbPathToKey(rel)).catch(() => { /* best-effort */ })
    }

    cloudWatchAudit.logDataAccess(req.user.id, req.user.role, 'visit', id, 'DELETE', req.clientIp)

    res.status(200).json({ message: 'Visit deleted.' })
  } catch (err) {
    console.error('Delete visit error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── GET VISIT HISTORY ────────────────────────────────────────────────────────

const getVisitHistory = async (req, res) => {
  try {
    await ensureNoteLockColumns()
    const clinician_id = req.user.id

    const durationCol = await visitDurationSelect('v')
    const txStatusCol = await visitTranscriptionStatusSelect('v')
    const result = await pool.query(
      `SELECT
         v.id, v.visit_date, v.visit_time, v.visit_type, v.status,
         ${durationCol}, v.audio_file, ${txStatusCol},
         p.name as patient_name, p.mrn,
         COALESCE(sb.name, s.name) as scribe_name,
         n.final_note, n.ai_draft, n.transcription, n.id as note_id,
         n.status as note_status, n.locked_at
       FROM visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users s  ON s.id  = v.scribe_id
       LEFT JOIN notes n  ON n.visit_id = v.id
       LEFT JOIN users sb ON sb.id = n.submitted_by
       WHERE v.clinician_id = $1
         AND v.status IN ('done', 'recording-uploaded', 'note-ready', 'uploaded')
       ORDER BY v.visit_date DESC, v.visit_time DESC`,
      [clinician_id]
    )

    res.status(200).json({ visits: result.rows })

    // History returns finalized note content (PHI), so access is audited.
    void auditLog(
      req.user,
      'VISIT_HISTORY_VIEWED',
      'visit',
      null,
      `Viewed visit history (${result.rows.length} record(s))`,
      {
        req,
        module_key: 'clinical',
        action_category: 'read',
        status: 'success',
        metadata: { scope: 'history', count: result.rows.length },
      }
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', null, 'READ', req.clientIp,
      { scope: 'history', count: result.rows.length }
    )
  } catch (err) {
    console.error('Get visit history error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

// ─── LOCK NOTE (Clinician) ────────────────────────────────────────────────────

const lockNote = async (req, res) => {
  try {
    await ensureNoteLockColumns()
    const { id } = req.params

    const out = await withTransaction(async (client) => {
      const visit = await getVisitForUser(id, req.user, client)
      if (!visit) return { forbidden: true }

      const noteRow = await client.query(
        'SELECT id FROM notes WHERE visit_id = $1 FOR UPDATE',
        [id]
      )
      if (!noteRow.rows[0]) return { notFound: true }

      await client.query(
        `UPDATE notes
            SET status = 'uploaded',
                locked_at = NOW(),
                locked_by = $1,
                updated_at = NOW()
          WHERE visit_id = $2`,
        [req.user.id, id]
      )

      await client.query(
        `UPDATE visits SET status = 'uploaded' WHERE id = $1`,
        [id]
      )

      await auditLog(
        req.user,
        'lock_note',
        'note',
        String(id),
        'Note locked and marked as completed by clinician',
        client,
        { req, module_key: 'clinical', action_category: 'update' }
      )

      return { ok: true }
    })

    if (out.notFound) return res.status(404).json({ error: 'Note not found for this visit.' })
    if (out.forbidden) return res.status(403).json({ error: 'Not authorized for this visit.' })

    const durationCol = await visitDurationSelect('v')
    const txStatusCol = await visitTranscriptionStatusSelect('v')
    const result = await pool.query(
      `SELECT
         v.id, v.visit_date, v.visit_time, v.visit_type, v.status,
         ${durationCol}, v.audio_file, ${txStatusCol},
         p.name as patient_name, p.mrn,
         COALESCE(sb.name, s.name) as scribe_name,
         n.final_note, n.ai_draft, n.transcription, n.id as note_id,
         n.status as note_status, n.locked_at
       FROM visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN users s  ON s.id  = v.scribe_id
       LEFT JOIN notes n  ON n.visit_id = v.id
       LEFT JOIN users sb ON sb.id = n.submitted_by
       WHERE v.id = $1 AND v.clinician_id = $2`,
      [id, req.user.id]
    )

    if (!result.rows[0]) return res.status(404).json({ error: 'Visit not found.' })
    res.status(200).json({ visit: result.rows[0] })
  } catch (err) {
    console.error('Lock note error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
}

module.exports = {
  getVisitsByDate, getAllVisits, createVisit,
  updateVisitStatus, endVisit, updateVisit,
  deleteVisit, getVisitHistory, lockNote,
}
