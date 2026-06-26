const express = require('express')
const jwt = require('jsonwebtoken')
const router = express.Router()
const pool = require('../config/db')
const { protect } = require('../middleware/auth')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  resolveMfaSecret,
  encryptMfaSecret,
  PHI_ROLES,
} = require('../services/mfaService')

function issueSessionToken(user) {
  return jwt.sign(
    {
      id: user.id,
      userId: user.id,
      role: user.role,
      token_version: Number(user.token_version) || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  )
}

function toAuthUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    specialty: user.specialty,
    phone: user.phone,
    npi: user.npi,
    license: user.license,
    status: user.status,
    avatar_data_url: user.avatar_data_url || null,
    personal_info: user.personal_info || null,
    admin_modules: user.admin_modules ?? null,
  }
}

router.post('/setup', protect, async (req, res) => {
  const secret = generateSecret()
  const codes = generateRecoveryCodes()
  const hashed = codes.map(hashRecoveryCode)
  const encrypted = encryptMfaSecret(secret)
  if (!encrypted) {
    return res.status(503).json({ error: 'MFA setup unavailable — encryption key not configured.' })
  }
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id])
  const email = rows[0]?.email || `user-${req.user.id}`
  await pool.query(
    'UPDATE users SET mfa_secret_encrypted = $1, mfa_recovery_codes = $2 WHERE id = $3',
    [encrypted, JSON.stringify(hashed), req.user.id]
  )
  res.json({
    secret,
    otpauthUrl: `otpauth://totp/Anot:${email}?secret=${secret}&issuer=Anot`,
    recoveryCodes: codes,
  })
})

router.post('/verify', protect, async (req, res) => {
  const { token } = req.body || {}
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [req.user.id]
  )
  const user = rows[0]
  const secret = resolveMfaSecret(user)
  if (!secret || !verifyTotp(secret, token)) {
    return res.status(401).json({ error: 'Invalid MFA token.' })
  }
  await pool.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [req.user.id])

  if (req.user.requireMfaEnrollment === true) {
    const fresh = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0]
    void auditLog(
      { id: fresh.id, name: fresh.name, role: fresh.role },
      'MFA_ENROLLMENT_COMPLETED',
      'auth',
      String(fresh.id),
      'MFA enrolled at login for PHI access',
      { req, module_key: 'authentication', status: 'success', action_category: 'authentication' }
    ).catch(reportAuditFailure)
    return res.json({
      mfaEnabled: true,
      token: issueSessionToken(fresh),
      user: toAuthUser(fresh),
    })
  }

  res.json({ mfaEnabled: true })
})

router.post('/disable', protect, async (req, res) => {
  const { token } = req.body || {}
  const { rows } = await pool.query(
    'SELECT mfa_secret, mfa_secret_encrypted, role FROM users WHERE id = $1',
    [req.user.id]
  )
  const u = rows[0]
  if (PHI_ROLES.has(u.role)) {
    return res.status(403).json({ error: 'MFA cannot be disabled for accounts with PHI access.' })
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
