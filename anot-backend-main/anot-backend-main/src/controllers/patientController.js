const { sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const cloudWatchAudit = require('../utils/logger')
const { deleteAudio, dbPathToKey } = require('../services/s3Storage')

const UPLOAD_PATH_RE = /^\/uploads\/[\w.\-]+$/

function collectAudioPathsFromVisits(rows) {
    const paths = []
    for (const row of rows) {
        const raw = row.audio_file
        if (!raw) continue
        for (const rel of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
            if (UPLOAD_PATH_RE.test(rel)) paths.push(rel)
        }
    }
    return paths
}

async function purgePatientAudioFromS3(audioPaths, req, patientId) {
    for (const rel of audioPaths) {
        const key = dbPathToKey(rel)
        await deleteAudio(key)
        await auditLog(
            req.user,
            'PHI_AUDIO_DELETED',
            'audio',
            key,
            `Deleted S3 audio during patient erasure (patient id ${patientId})`,
            {
                req,
                module_key: 'clinical',
                action_category: 'delete',
                status: 'success',
                metadata: { patient_id: patientId, s3_key: key, audio_path: rel },
            },
        ).catch(reportAuditFailure)
        cloudWatchAudit.logDataAccess(
            req.user.id,
            req.user.role,
            'audio',
            key,
            'DELETE',
            req.clientIp,
            { patient_id: patientId, reason: 'patient_erasure' },
        )
    }
}

// ─── GET ALL PATIENTS ─────────────────────────────────────────────────────────

const getAllPatients = async (req, res) => {
    try {
        const { role, id } = req.user
        let result
        if (role === 'admin' || role === 'super_admin' || role === 'qps') {
            result = await pool.query(`SELECT * FROM patients ORDER BY name ASC`)
        } else if (role === 'clinician') {
            result = await pool.query(
                `SELECT DISTINCT p.* FROM patients p
                 INNER JOIN visits v ON v.patient_id = p.id
                 WHERE v.clinician_id = $1
                 ORDER BY p.name ASC`,
                [id]
            )
        } else if (role === 'scribe') {
            result = await pool.query(
                `SELECT DISTINCT p.* FROM patients p
                 INNER JOIN visits v ON v.patient_id = p.id
                 WHERE v.scribe_id = $1
                    OR v.clinician_id IN (
                        SELECT clinician_id FROM scribe_assignments WHERE scribe_id = $1
                    )
                 ORDER BY p.name ASC`,
                [id]
            )
        } else {
            return res.status(403).json({ error: 'Not authorized.' })
        }

        await auditLog(req.user, 'PATIENTS_VIEWED', 'patient', null,
            `Viewed ${result.rows.length} patient(s)`,
            { req, module_key: 'clinical', action_category: 'read' }).catch(reportAuditFailure)

        res.status(200).json({ patients: result.rows })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
    }
}

// ─── CREATE PATIENT ───────────────────────────────────────────────────────────

const createPatient = async (req, res) => {
    try {
        const { name, mrn, date_of_birth } = req.body

        if (!name || !mrn) {
            return res.status(400).json({ error: 'Name and MRN are required.' })
        }

        const normalizedMrn = mrn.trim().toUpperCase()

        if (date_of_birth) {
            // Accept ISO-8601 date (YYYY-MM-DD); reject anything else so we
            // surface a 400 instead of a 500 from PG's invalid-syntax error.
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth) ||
                Number.isNaN(Date.parse(date_of_birth))) {
                return res.status(400).json({ error: 'date_of_birth must be in YYYY-MM-DD format.' })
            }
        }

        // Check MRN is unique (compare normalized MRN so casing matches INSERT)
        const existing = await pool.query(
            'SELECT id, name, mrn, date_of_birth FROM patients WHERE mrn = $1',
            [normalizedMrn],
        )
        if (existing.rows.length > 0) {
            return res.status(409).json({
                error: 'A patient with this MRN already exists.',
                patient: { id: existing.rows[0].id },
            })
        }

        const result = await pool.query(
            `INSERT INTO patients (name, mrn, date_of_birth)
             VALUES ($1, $2, $3)
                 RETURNING *`,
            [name.trim(), normalizedMrn, date_of_birth || null]
        )

        const newPatient = result.rows[0]
        await auditLog(req.user, 'PATIENT_CREATED', 'patient', newPatient.id,
            `Created patient record (id ${newPatient.id})`,
            { req, module_key: 'clinical', action_category: 'create', metadata: { patient_id: newPatient.id } }).catch(reportAuditFailure)

        res.status(201).json({
            message: 'Patient created successfully.',
            patient: newPatient,
        })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
    }
}

// ─── GET SINGLE PATIENT ───────────────────────────────────────────────────────

const getPatient = async (req, res) => {
    try {
        const { id } = req.params
        const { role, id: uid } = req.user
        let result
        if (role === 'admin' || role === 'super_admin' || role === 'qps') {
            result = await pool.query('SELECT * FROM patients WHERE id = $1', [id])
        } else if (role === 'clinician') {
            result = await pool.query(
                `SELECT p.* FROM patients p
                 WHERE p.id = $1 AND EXISTS (
                   SELECT 1 FROM visits v WHERE v.patient_id = p.id AND v.clinician_id = $2
                 )`,
                [id, uid],
            )
        } else if (role === 'scribe') {
            result = await pool.query(
                `SELECT p.* FROM patients p
                 WHERE p.id = $1 AND EXISTS (
                   SELECT 1 FROM visits v
                   WHERE v.patient_id = p.id
                     AND (v.scribe_id = $2 OR v.clinician_id IN (
                       SELECT clinician_id FROM scribe_assignments WHERE scribe_id = $2
                     ))
                 )`,
                [id, uid],
            )
        } else {
            return res.status(403).json({ error: 'Not authorized.' })
        }
        if (!result.rows[0]) {
            return res.status(404).json({ error: 'Patient not found.' })
        }

        const patient = result.rows[0]
        await auditLog(req.user, 'PATIENT_VIEWED', 'patient', patient.id,
            `Viewed patient record (id ${patient.id})`,
            { req, module_key: 'clinical', action_category: 'read' }).catch(reportAuditFailure)

        res.status(200).json({ patient })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
    }
}

// ─── DELETE PATIENT (HIPAA right to erasure — admin only) ─────────────────────

const deletePatient = async (req, res) => {
    try {
        const { id } = req.params
        const patientId = parseInt(id, 10)
        if (!Number.isFinite(patientId)) {
            return res.status(400).json({ error: 'Invalid patient id.' })
        }

        const existing = await pool.query('SELECT id, name, mrn FROM patients WHERE id = $1', [patientId])
        if (!existing.rows[0]) {
            return res.status(404).json({ error: 'Patient not found.' })
        }

        const visitAudio = await pool.query(
            'SELECT audio_file FROM visits WHERE patient_id = $1',
            [patientId],
        )
        const audioPaths = collectAudioPathsFromVisits(visitAudio.rows)

        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            const visitIds = await client.query('SELECT id FROM visits WHERE patient_id = $1', [patientId])
            const ids = visitIds.rows.map((r) => r.id)
            if (ids.length > 0) {
                await client.query('DELETE FROM notes WHERE visit_id = ANY($1::int[])', [ids])
                await client.query('DELETE FROM visits WHERE patient_id = $1', [patientId])
            }
            await client.query('DELETE FROM patients WHERE id = $1', [patientId])
            await client.query('COMMIT')
        } catch (txErr) {
            await client.query('ROLLBACK')
            throw txErr
        } finally {
            client.release()
        }

        // Best-effort S3 purge after DB commit — same pattern as visit deletion.
        await purgePatientAudioFromS3(audioPaths, req, patientId)

        await auditLog(
            req.user,
            'PATIENT_DELETED',
            'patient',
            String(patientId),
            `Deleted patient record (id ${patientId})`,
            {
                req,
                module_key: 'clinical',
                action_category: 'delete',
                status: 'success',
                metadata: { patient_id: patientId, audio_files_purged: audioPaths.length },
            },
        ).catch(reportAuditFailure)

        res.status(204).send()
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'patient.delete', req })
    }
}

module.exports = { getAllPatients, createPatient, getPatient, deletePatient, collectAudioPathsFromVisits }