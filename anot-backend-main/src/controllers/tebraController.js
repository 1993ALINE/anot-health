const { sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const { loadTebraSettings } = require('../services/tebraSettings')
const tebraService = require('../services/tebraService')
const { ALLOWED_VISIT_TYPES } = require('../utils/visitTypes')

function requireTebraCredentials(res, settings) {
  const credentials = tebraService.resolveTebraCredentials(settings)
  if (!settings.tebra_enabled) {
    res.status(409).json({ error: 'Tebra integration is not enabled. Configure it in Admin → Settings first.' })
    return null
  }
  if (!credentials) {
    res.status(409).json({ error: 'Tebra credentials are not configured.' })
    return null
  }
  return credentials
}

// ─── SYNC PATIENTS FROM TEBRA ──────────────────────────────────────────────
// Admin-triggered pull: matches Tebra patients to local rows by MRN (chart
// number), creating any that don't already exist, and stamping tebra_patient_id.

const syncPatients = async (req, res) => {
  try {
    const settings = await loadTebraSettings()
    const credentials = requireTebraCredentials(res, settings)
    if (!credentials) return

    const { updatedSince } = req.body || {}
    const tebraPatients = await tebraService.pullPatients({ updatedSince }, credentials)

    let created = 0
    let matched = 0
    for (const tp of tebraPatients) {
      const mrn = String(tp.ChartNumber || '').trim().toUpperCase()
      const tebraId = String(tp.PatientID || '').trim()
      if (!mrn || !tebraId) continue

      const existing = await pool.query('SELECT id, tebra_patient_id FROM patients WHERE mrn = $1', [mrn])
      if (existing.rows[0]) {
        if (existing.rows[0].tebra_patient_id !== tebraId) {
          await pool.query('UPDATE patients SET tebra_patient_id = $1 WHERE id = $2', [tebraId, existing.rows[0].id])
        }
        matched += 1
        continue
      }

      const name = [tp.FirstName, tp.LastName].filter(Boolean).join(' ').trim() || mrn
      await pool.query(
        `INSERT INTO patients (name, mrn, date_of_birth, tebra_patient_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mrn) DO NOTHING`,
        [name, mrn, tp.DateofBirth || null, tebraId],
      )
      created += 1
    }

    await auditLog(req.user, 'TEBRA_PATIENTS_SYNCED', 'patient', null,
      `Synced patients from Tebra (created ${created}, matched ${matched})`,
      { req, module_key: 'integration', action_category: 'update', metadata: { created, matched } })
      .catch(reportAuditFailure)

    res.status(200).json({ message: 'Patient sync complete.', created, matched, total: tebraPatients.length })
  } catch (err) {
    sendHttpError(res, 502, err, { context: 'tebra.syncPatients', req })
  }
}

// ─── SYNC APPOINTMENTS FROM TEBRA ──────────────────────────────────────────
// Admin-triggered pull per mapped clinician (users.tebra_provider_id) for a
// date range; creates/updates visits matched by tebra_appointment_id.

const syncAppointments = async (req, res) => {
  try {
    const settings = await loadTebraSettings()
    const credentials = requireTebraCredentials(res, settings)
    if (!credentials) return

    const { date_from, date_to } = req.body || {}
    if (!date_from || !date_to) {
      return res.status(400).json({ error: 'date_from and date_to are required (YYYY-MM-DD).' })
    }

    const providers = await pool.query(
      `SELECT id, tebra_provider_id FROM users WHERE tebra_provider_id IS NOT NULL AND role = 'clinician'`,
    )

    let created = 0
    let updated = 0
    for (const provider of providers.rows) {
      const appts = await tebraService.pullAppointments(
        { providerId: provider.tebra_provider_id, dateFrom: date_from, dateTo: date_to },
        credentials,
      )

      for (const appt of appts) {
        const tebraApptId = String(appt.AppointmentID || '').trim()
        if (!tebraApptId) continue

        const patientRow = await pool.query('SELECT id FROM patients WHERE tebra_patient_id = $1', [String(appt.PatientID || '')])
        if (!patientRow.rows[0]) continue // patient must be synced first

        const visitDate = String(appt.StartDate || '').slice(0, 10)
        const visitTime = String(appt.StartTime || '00:00').slice(0, 5)
        const visitType = ALLOWED_VISIT_TYPES.includes(appt.AppointmentType) ? appt.AppointmentType : 'Other'

        const existing = await pool.query('SELECT id FROM visits WHERE tebra_appointment_id = $1', [tebraApptId])
        if (existing.rows[0]) {
          await pool.query(
            `UPDATE visits SET visit_date = $1, visit_time = $2, visit_type = $3 WHERE id = $4`,
            [visitDate, visitTime, visitType, existing.rows[0].id],
          )
          updated += 1
        } else {
          await pool.query(
            `INSERT INTO visits (patient_id, clinician_id, visit_date, visit_time, visit_type, status, tebra_appointment_id)
             VALUES ($1, $2, $3, $4, $5, 'upcoming', $6)`,
            [patientRow.rows[0].id, provider.id, visitDate, visitTime, visitType, tebraApptId],
          )
          created += 1
        }
      }
    }

    await auditLog(req.user, 'TEBRA_APPOINTMENTS_SYNCED', 'visit', null,
      `Synced appointments from Tebra (created ${created}, updated ${updated})`,
      { req, module_key: 'integration', action_category: 'update', metadata: { created, updated } })
      .catch(reportAuditFailure)

    res.status(200).json({ message: 'Appointment sync complete.', created, updated })
  } catch (err) {
    sendHttpError(res, 502, err, { context: 'tebra.syncAppointments', req })
  }
}

// ─── STATUS ─────────────────────────────────────────────────────────────────

const getTebraStatus = async (req, res) => {
  try {
    const settings = await loadTebraSettings()
    res.status(200).json({
      enabled: settings.tebra_enabled,
      configured: !!tebraService.resolveTebraCredentials(settings),
      circuit: tebraService.getTebraCircuitStatus(),
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'tebra.getStatus', req })
  }
}

module.exports = { syncPatients, syncAppointments, getTebraStatus }
