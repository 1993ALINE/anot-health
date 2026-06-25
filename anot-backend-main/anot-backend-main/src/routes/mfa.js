const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect } = require('../middleware/auth')
const {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  resolveMfaSecret,
  encryptMfaSecret,
} = require('../services/mfaService')

router.post('/setup', protect, async (req, res) => {
  const secret = generateSecret()
  const codes = generateRecoveryCodes()
  const hashed = codes.map(hashRecoveryCode)
  const encrypted = encryptMfaSecret(secret)
  if (!encrypted) {
    return res.status(503).json({ error: 'MFA setup unavailable — encryption key not configured.' })
  }
  await pool.query(
    'UPDATE users SET mfa_secret_encrypted = $1, mfa_recovery_codes = $2 WHERE id = $3',
    [encrypted, JSON.stringify(hashed), req.user.id]
  )
  res.json({
    secret,
    otpauthUrl: `otpauth://totp/Anot:${req.user.email}?secret=${secret}&issuer=Anot`,
    recoveryCodes: codes,
  })
})

router.post('/verify', protect, async (req, res) => {
  const { token } = req.body || {}
  const { rows } = await pool.query(
    'SELECT mfa_secret, mfa_secret_encrypted FROM users WHERE id = $1',
    [req.user.id]
  )
  const secret = resolveMfaSecret(rows[0])
  if (!secret || !verifyTotp(secret, token)) {
    return res.status(401).json({ error: 'Invalid MFA token.' })
  }
  await pool.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [req.user.id])
  res.json({ mfaEnabled: true })
})

router.post('/disable', protect, async (req, res) => {
  const { token } = req.body || {}
  const { rows } = await pool.query(
    'SELECT mfa_secret, mfa_secret_encrypted, role FROM users WHERE id = $1',
    [req.user.id]
  )
  const u = rows[0]
  if (['admin', 'super_admin'].includes(u.role)) {
    return res.status(403).json({ error: 'Admin accounts cannot disable MFA.' })
  }
  const secret = resolveMfaSecret(u)
  if (!verifyTotp(secret, token)) {
    return res.status(401).json({ error: 'Invalid MFA token.' })
  }
  await pool.query(
    'UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_secret_encrypted = NULL, mfa_recovery_codes = $2 WHERE id = $1',
    [req.user.id, '[]']
  )
  res.json({ mfaEnabled: false })
})

module.exports = router
