const { sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')

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
                patient: existing.rows[0],
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
            `Created patient: ${newPatient.name}`,
            { req, module_key: 'clinical', action_category: 'create', metadata: { mrn: newPatient.mrn } }).catch(reportAuditFailure)

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
            `Viewed patient: ${patient.name}`,
            { req, module_key: 'clinical', action_category: 'read' }).catch(reportAuditFailure)

        res.status(200).json({ patient })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'undefined', req })
    }
}

module.exports = { getAllPatients, createPatient, getPatient }