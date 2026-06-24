const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect } = require('../middleware/auth')

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

module.exports = router