const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const { getVisitForUser } = require('../utils/visitAccess')
const { ensurePatientConsentColumn } = require('../utils/visitSchemaCompat')
const cloudWatchAudit = require('../utils/logger')

const VALID_TYPES = new Set(['privacy_policy', 'terms_of_service', 'phi_processing', 'marketing'])

router.get('/me', protect, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT consent_type, consent_version, granted, granted_at, revoked_at FROM user_consents WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  )
  res.json({ consents: rows })
})

router.post('/me', protect, async (req, res) => {
  const { consentType, consentVersion, granted } = req.body || {}
  if (!VALID_TYPES.has(consentType) || !consentVersion) {
    return res.status(400).json({ error: 'Invalid consentType or consentVersion.' })
  }
  const now = granted ? new Date() : null
  const { rows } = await pool.query(
    `INSERT INTO user_consents (user_id, consent_type, consent_version, granted, ip_address, user_agent, granted_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, consent_type, consent_version)
     DO UPDATE SET granted = EXCLUDED.granted, granted_at = EXCLUDED.granted_at,
                   revoked_at = CASE WHEN EXCLUDED.granted THEN NULL ELSE NOW() END,
                   ip_address = EXCLUDED.ip_address, user_agent = EXCLUDED.user_agent
     RETURNING *`,
    [req.user.id, consentType, consentVersion, !!granted, req.clientIp, req.get('user-agent'), now, granted ? null : new Date()]
  )
  res.json({ consent: rows[0] })
})

/** Clinician attestation that the patient authorized encounter recording. */
router.post('/recording', protect, restrict('clinician'), async (req, res) => {
  try {
    const visitId = parseInt(req.body?.visitId, 10)
    if (!Number.isInteger(visitId)) {
      return res.status(400).json({ error: 'visitId is required.' })
    }

    await ensurePatientConsentColumn()

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    await pool.query(
      'UPDATE visits SET patient_consent_recorded = true WHERE id = $1',
      [visitId],
    )

    void auditLog(
      req.user,
      'PATIENT_RECORDING_CONSENT',
      'visit',
      String(visitId),
      `Patient recording consent recorded (visit ${visitId})`,
      {
        req,
        module_key: 'clinical',
        action_category: 'update',
        status: 'success',
        metadata: {
          visit_date: visit.visit_date || null,
        },
      },
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', String(visitId), 'UPDATE', req.clientIp,
      { action: 'patient_recording_consent' },
    )

    res.json({ visitId, patient_consent_recorded: true })
  } catch (err) {
    console.error('[consent.recording]', err.message)
    res.status(500).json({ error: 'Could not record patient consent.' })
  }
})

/** Clinician withdraws patient recording consent (blocks further audio uploads). */
router.post('/recording/revoke', protect, restrict('clinician'), async (req, res) => {
  try {
    const visitId = parseInt(req.body?.visitId, 10)
    if (!Number.isInteger(visitId)) {
      return res.status(400).json({ error: 'visitId is required.' })
    }

    await ensurePatientConsentColumn()

    const visit = await getVisitForUser(visitId, req.user)
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found or not yours.' })
    }

    if (!visit.patient_consent_recorded) {
      return res.status(400).json({ error: 'Recording consent was not recorded for this visit.' })
    }

    await pool.query(
      'UPDATE visits SET patient_consent_recorded = false WHERE id = $1',
      [visitId],
    )

    const hasAudio = Boolean(visit.audio_file && String(visit.audio_file).trim())

    void auditLog(
      req.user,
      'PATIENT_RECORDING_CONSENT_REVOKED',
      'visit',
      String(visitId),
      `Patient recording consent revoked (visit ${visitId})`,
      {
        req,
        module_key: 'clinical',
        action_category: 'update',
        status: 'success',
        metadata: {
          visit_date: visit.visit_date || null,
          had_audio: hasAudio,
        },
      },
    ).catch(reportAuditFailure)

    cloudWatchAudit.logDataAccess(
      req.user.id, req.user.role, 'visit', String(visitId), 'UPDATE', req.clientIp,
      { action: 'patient_recording_consent_revoked', had_audio: hasAudio },
    )

    res.json({
      visitId,
      patient_consent_recorded: false,
      had_audio: hasAudio,
      message: hasAudio
        ? 'Consent revoked. Existing audio was not deleted; contact an admin for patient erasure if required.'
        : 'Consent revoked. Further audio uploads are blocked until consent is recorded again.',
    })
  } catch (err) {
    console.error('[consent.recording.revoke]', err.message)
    res.status(500).json({ error: 'Could not revoke patient recording consent.' })
  }
})

module.exports = router