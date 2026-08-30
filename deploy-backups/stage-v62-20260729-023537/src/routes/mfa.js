const express = require('express')
const jwt = require('jsonwebtoken')
const router = express.Router()
const pool = require('../config/db')
const { protect } = require('../middleware/auth')
const { setSessionCookie } = require('../utils/sessionCookie')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const { mfaVerifyLimiter } = require('../middleware/rateLimit')
const {
  validateDestination,
  maskDestination,
  issueAndSendCode,
  verifyMfaCode,
  PHI_ROLES,
  isMfaFullyEnrolled,
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
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
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

async function loadUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId])
  return rows[0] || null
}

function resolveSetupPurpose(req) {
  if (req.user.requireMfaEnrollment === true) return 'setup'
  return 'settings'
}

router.get('/status', protect, async (req, res) => {
  try {
    const user = await loadUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found.' })
    }
    const enrolled = isMfaFullyEnrolled(user)
    res.json({
      mfaEnabled: enrolled,
      mfaMethod: user.mfa_method || null,
      mfaDestinationMasked: enrolled ? maskDestination(user.mfa_method, user.mfa_destination) : null,
      canDisable: enrolled && !PHI_ROLES.has(user.role),
    })
  } catch (err) {
    console.error('[mfa.status]', err.message)
    res.status(500).json({ error: 'Could not load MFA status.' })
  }
})

router.post('/setup', protect, async (req, res) => {
  try {
    const { method, destination } = req.body || {}
    const validated = validateDestination(method, destination)
    if (!validated.ok) {
      return res.status(400).json({ error: validated.error })
    }

    await pool.query(
      `UPDATE users
       SET mfa_method = $1, mfa_destination = $2, mfa_enabled = false
       WHERE id = $3`,
      [validated.method, validated.destination, req.user.id],
    )

    const user = await loadUser(req.user.id)
    const purpose = resolveSetupPurpose(req)
    const delivery = await issueAndSendCode(pool, user, purpose)

    if (!delivery.sent) {
      return res.status(503).json({
        error: delivery.reason || 'Could not send verification code. Contact your administrator.',
      })
    }

    res.json({
      message: 'Verification code sent.',
      method: validated.method,
      destinationMasked: maskDestination(validated.method, validated.destination),
    })
  } catch (err) {
    console.error('[mfa.setup]', err.message)
    res.status(500).json({ error: 'MFA setup failed.' })
  }
})

router.post('/send-code', protect, mfaVerifyLimiter, async (req, res) => {
  try {
    const user = await loadUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found.' })
    }

    let purpose
    if (req.user.requireMfa === true) {
      if (!isMfaFullyEnrolled(user)) {
        return res.status(403).json({ error: 'MFA is not configured for this account.' })
      }
      purpose = 'login'
    } else if (req.user.requireMfaEnrollment === true) {
      if (!user.mfa_method || !user.mfa_destination) {
        return res.status(400).json({ error: 'Choose email or SMS MFA before requesting a code.' })
      }
      purpose = 'setup'
    } else {
      purpose = String(req.body?.purpose || 'settings')
      if (!['setup', 'settings', 'disable'].includes(purpose)) {
        return res.status(400).json({ error: 'Invalid code purpose.' })
      }
      if (purpose !== 'setup' && !isMfaFullyEnrolled(user)) {
        return res.status(400).json({ error: 'MFA is not enabled.' })
      }
    }

    const delivery = await issueAndSendCode(pool, user, purpose)
    if (!delivery.sent) {
      return res.status(503).json({
        error: delivery.reason || 'Could not send verification code.',
      })
    }

    res.json({
      message: 'Verification code sent.',
      method: delivery.method,
      destinationMasked: delivery.destinationMasked,
    })
  } catch (err) {
    console.error('[mfa.send-code]', err.message)
    res.status(500).json({ error: 'Could not send verification code.' })
  }
})

router.post('/verify-code', protect, mfaVerifyLimiter, async (req, res) => {
  try {
    const { code } = req.body || {}
    const user = await loadUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found.' })
    }

    let purpose
    let enableOnSuccess = false
    let disableOnSuccess = false

    if (req.user.requireMfaEnrollment === true) {
      purpose = 'setup'
      enableOnSuccess = true
    } else if (req.body?.purpose === 'disable') {
      if (PHI_ROLES.has(user.role)) {
        return res.status(403).json({ error: 'MFA cannot be disabled for accounts with PHI access.' })
      }
      purpose = 'disable'
      disableOnSuccess = true
    } else {
      purpose = 'settings'
      enableOnSuccess = !isMfaFullyEnrolled(user)
    }

    const result = await verifyMfaCode(pool, user.id, purpose, code)
    if (!result.ok) {
      const status = result.locked ? 429 : 401
      return res.status(status).json({ error: result.error })
    }

    if (disableOnSuccess) {
      await pool.query(
        `UPDATE users
         SET mfa_enabled = false, mfa_method = NULL, mfa_destination = NULL
         WHERE id = $1`,
        [user.id],
      )
      void auditLog(
        { id: user.id, name: user.name, role: user.role },
        'MFA_DISABLED',
        'auth',
        String(user.id),
        'User disabled MFA',
        { req, module_key: 'authentication', status: 'success', action_category: 'authentication' },
      ).catch(reportAuditFailure)
      return res.json({ mfaEnabled: false })
    }

    if (enableOnSuccess) {
      await pool.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [user.id])
    }

    const fresh = await loadUser(user.id)

    if (req.user.requireMfaEnrollment === true) {
      void auditLog(
        { id: fresh.id, name: fresh.name, role: fresh.role },
        'MFA_ENROLLMENT_COMPLETED',
        'auth',
        String(fresh.id),
        'MFA enrolled at login for PHI access',
        { req, module_key: 'authentication', status: 'success', action_category: 'authentication' },
      ).catch(reportAuditFailure)
      const sessionToken = issueSessionToken(fresh)
      setSessionCookie(res, sessionToken)
      return res.json({
        mfaEnabled: true,
        user: toAuthUser(fresh),
      })
    }

    void auditLog(
      { id: fresh.id, name: fresh.name, role: fresh.role },
      'MFA_SETTINGS_UPDATED',
      'auth',
      String(fresh.id),
      'MFA settings verified',
      { req, module_key: 'authentication', status: 'success', action_category: 'authentication' },
    ).catch(reportAuditFailure)

    res.json({
      mfaEnabled: isMfaFullyEnrolled(fresh),
      method: fresh.mfa_method,
      destinationMasked: maskDestination(fresh.mfa_method, fresh.mfa_destination),
    })
  } catch (err) {
    console.error('[mfa.verify-code]', err.message)
    res.status(500).json({ error: 'Verification failed.' })
  }
})

router.post('/disable', protect, async (req, res) => {
  try {
    const user = await loadUser(req.user.id)
    if (!user) {
      return res.status(404).json({ error: 'User not found.' })
    }
    if (PHI_ROLES.has(user.role)) {
      return res.status(403).json({ error: 'MFA cannot be disabled for accounts with PHI access.' })
    }
    if (!isMfaFullyEnrolled(user)) {
      return res.json({ mfaEnabled: false })
    }

    const { code } = req.body || {}
    if (!code) {
      const delivery = await issueAndSendCode(pool, user, 'disable')
      if (!delivery.sent) {
        return res.status(503).json({ error: delivery.reason || 'Could not send verification code.' })
      }
      return res.status(200).json({
        message: 'Verification code sent to confirm MFA disable.',
        destinationMasked: delivery.destinationMasked,
      })
    }

    const result = await verifyMfaCode(pool, user.id, 'disable', code)
    if (!result.ok) {
      const status = result.locked ? 429 : 401
      return res.status(status).json({ error: result.error })
    }

    await pool.query(
      `UPDATE users
       SET mfa_enabled = false, mfa_method = NULL, mfa_destination = NULL
       WHERE id = $1`,
      [user.id],
    )
    res.json({ mfaEnabled: false })
  } catch (err) {
    console.error('[mfa.disable]', err.message)
    res.status(500).json({ error: 'Could not disable MFA.' })
  }
})

module.exports = router
