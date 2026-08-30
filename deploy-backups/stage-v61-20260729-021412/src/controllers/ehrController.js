const { sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const ehrConnectionsService = require('../services/ehrConnectionsService')
const { getDriver } = require('../services/ehrDrivers')
const { ALLOWED_VISIT_TYPES } = require('../utils/visitTypes')

async function requireReadyConnection(req, res) {
  const { connectionId } = req.params
  const connection = await ehrConnectionsService.getConnection(connectionId)
  if (!connection) {
    res.status(404).json({ error: 'EHR connection not found.' })
    return null
  }
  if (!connection.enabled) {
    res.status(409).json({ error: 'This EHR connection is not enabled.' })
    return null
  }
  if (!ehrConnectionsService.hasCompleteCredentials(connection.ehr_type, connection.credentials)) {
    res.status(409).json({ error: 'This EHR connection is missing required credentials.' })
    return null
  }
  return connection
}

// ─── SYNC PATIENTS FROM EHR ─────────────────────────────────────────────────
// Admin-triggered pull: matches EHR patients to local rows by MRN (chart
// number), creating any that don't already exist, and mapping external ids
// via patient_ehr_ids.

const syncPatients = async (req, res) => {
  try {
    const connection = await requireReadyConnection(req, res)
    if (!connection) return
    const driver = getDriver(connection.ehr_type)

    const { updatedSince } = req.body || {}
    const ehrPatients = await driver.pullPatients({ updatedSince }, connection.credentials)

    let created = 0
    let matched = 0
    for (const ep of ehrPatients) {
      const mrn = String(ep.ChartNumber || '').trim().toUpperCase()
      const externalId = String(ep.PatientID || '').trim()
      if (!mrn || !externalId) continue

      const existing = await pool.query('SELECT id FROM patients WHERE mrn = $1', [mrn])
      let patientId = existing.rows[0]?.id

      if (!patientId) {
        const name = [ep.FirstName, ep.LastName].filter(Boolean).join(' ').trim() || mrn
        const inserted = await pool.query(
          `INSERT INTO patients (name, mrn, date_of_birth)
           VALUES ($1, $2, $3)
           ON CONFLICT (mrn) DO UPDATE SET mrn = EXCLUDED.mrn
           RETURNING id`,
          [name, mrn, ep.DateofBirth || null],
        )
        patientId = inserted.rows[0].id
        created += 1
      } else {
        matched += 1
      }

      await pool.query(
        `INSERT INTO patient_ehr_ids (patient_id, ehr_connection_id, external_patient_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (patient_id, ehr_connection_id) DO UPDATE SET external_patient_id = EXCLUDED.external_patient_id`,
        [patientId, connection.id, externalId],
      )
    }

    await auditLog(req.user, 'EHR_PATIENTS_SYNCED', 'patient', null,
      `Synced patients from ${connection.name} (created ${created}, matched ${matched})`,
      { req, module_key: 'integration', action_category: 'update', metadata: { connection_id: connection.id, created, matched } })
      .catch(reportAuditFailure)

    res.status(200).json({ message: 'Patient sync complete.', created, matched, total: ehrPatients.length })
  } catch (err) {
    sendHttpError(res, 502, err, { context: 'ehr.syncPatients', req })
  }
}

// ─── SYNC APPOINTMENTS FROM EHR ─────────────────────────────────────────────
// Admin-triggered pull per clinician mapped to this connection (users.ehr_provider_id)
// for a date range; creates/updates visits matched by ehr_appointment_id.

const syncAppointments = async (req, res) => {
  try {
    const connection = await requireReadyConnection(req, res)
    if (!connection) return
    const driver = getDriver(connection.ehr_type)

    const { date_from, date_to } = req.body || {}
    if (!date_from || !date_to) {
      return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD).' })
    }

    const providers = await pool.query(
      `SELECT id, ehr_provider_id FROM users
        WHERE ehr_connection_id = $1 AND ehr_provider_id IS NOT NULL AND role = 'clinician'`,
      [connection.id],
    )

    let created = 0
    let updated = 0
    for (const provider of providers.rows) {
      const appts = await driver.pullAppointments(
        { externalProviderId: provider.ehr_provider_id, dateFrom: date_from, dateTo: date_to },
        connection.credentials,
      )

      for (const appt of appts) {
        const externalApptId = String(appt.AppointmentID || '').trim()
        if (!externalApptId) continue

        const patientRow = await pool.query(
          'SELECT patient_id FROM patient_ehr_ids WHERE ehr_connection_id = $1 AND external_patient_id = $2',
          [connection.id, String(appt.PatientID || '')],
        )
        if (!patientRow.rows[0]) continue // patient must be synced first

        const visitDate = String(appt.StartDate || '').slice(0, 10)
        const visitTime = String(appt.StartTime || '00:00').slice(0, 5)
        const visitType = ALLOWED_VISIT_TYPES.includes(appt.AppointmentType) ? appt.AppointmentType : 'Other'

        const existing = await pool.query(
          'SELECT id FROM visits WHERE ehr_connection_id = $1 AND ehr_appointment_id = $2',
          [connection.id, externalApptId],
        )
        if (existing.rows[0]) {
          await pool.query(
            `UPDATE visits SET visit_date = $1, visit_time = $2, visit_type = $3 WHERE id = $4`,
            [visitDate, visitTime, visitType, existing.rows[0].id],
          )
          updated += 1
        } else {
          await pool.query(
            `INSERT INTO visits (patient_id, clinician_id, visit_date, visit_time, visit_type, status, ehr_connection_id, ehr_appointment_id)
             VALUES ($1, $2, $3, $4, $5, 'upcoming', $6, $7)`,
            [patientRow.rows[0].patient_id, provider.id, visitDate, visitTime, visitType, connection.id, externalApptId],
          )
          created += 1
        }
      }
    }

    await auditLog(req.user, 'EHR_APPOINTMENTS_SYNCED', 'visit', null,
      `Synced appointments from ${connection.name} (created ${created}, updated ${updated})`,
      { req, module_key: 'integration', action_category: 'update', metadata: { connection_id: connection.id, created, updated } })
      .catch(reportAuditFailure)

    res.status(200).json({ message: 'Appointment sync complete.', created, updated })
  } catch (err) {
    sendHttpError(res, 502, err, { context: 'ehr.syncAppointments', req })
  }
}

// ─── STATUS ─────────────────────────────────────────────────────────────────

const getStatus = async (req, res) => {
  try {
    const { connectionId } = req.params
    const connection = await ehrConnectionsService.getConnection(connectionId)
    if (!connection) return res.status(404).json({ error: 'EHR connection not found.' })
    const driver = getDriver(connection.ehr_type)

    res.status(200).json({
      enabled: connection.enabled,
      configured: ehrConnectionsService.hasCompleteCredentials(connection.ehr_type, connection.credentials),
      circuit: driver.getCircuitStatus ? driver.getCircuitStatus() : null,
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'ehr.getStatus', req })
  }
}

module.exports = { syncPatients, syncAppointments, getStatus }
