const crypto = require('crypto')
const { sendMfaEmail, sendMfaSms } = require('./mfaDelivery')

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5
const PHI_ROLES = new Set(['clinician', 'scribe', 'qps', 'super_admin', 'admin'])

/** When true, MFA enrollment/verification gates are skipped (login + protected routes). */
function isMfaDisabled() {
  const raw = process.env.MFA_DISABLED
  const disabled = String(raw || '').trim().toLowerCase() === 'true'
  if (!disabled) {
    console.log('[mfaService.isMfaDisabled] MFA_DISABLED:', raw, '→ gates active')
  }
  return disabled
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000))
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex')
}

function isMfaEnabledFlag(value) {
  return value === true || value === 't' || value === 1 || value === '1'
}

function normalizeMethod(method) {
  const m = String(method || '').toLowerCase().trim()
  return m === 'email' || m === 'sms' ? m : null
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim()
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.startsWith('1') && digits.length === 11 ? `+${digits}` : `+1${digits.slice(-10)}`
}

function maskDestination(method, destination) {
  if (!destination) return ''
  if (method === 'email') {
    const [local, domain] = String(destination).split('@')
    if (!domain) return '***'
    const maskedLocal = local.length <= 2 ? `${local[0] || ''}*` : `${local.slice(0, 2)}***`
    return `${maskedLocal}@${domain}`
  }
  const digits = String(destination).replace(/\D/g, '')
  if (digits.length < 4) return '***'
  return `***-***-${digits.slice(-4)}`
}

function validateDestination(method, destination) {
  const m = normalizeMethod(method)
  if (!m) return { ok: false, error: 'MFA method must be email or sms.' }
  if (m === 'email') {
    const email = normalizeEmail(destination)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Enter a valid email address for MFA.' }
    }
    return { ok: true, method: m, destination: email }
  }
  const phone = normalizePhone(destination)
  if (!phone) {
    return { ok: false, error: 'Enter a valid phone number for SMS MFA.' }
  }
  return { ok: true, method: m, destination: phone }
}

function isMfaFullyEnrolled(user) {
  return (
    isMfaEnabledFlag(user?.mfa_enabled) &&
    normalizeMethod(user?.mfa_method) &&
    String(user?.mfa_destination || '').trim()
  )
}

function adminRequiresMfa(role, mfaEnabled) {
  if (isMfaDisabled()) return false
  return PHI_ROLES.has(role) && !mfaEnabled
}

/**
 * @returns {false|'ENROLLMENT_REQUIRED'|true}
 */
function loginRequiresMfa(user) {
  if (isMfaDisabled()) {
    console.log('[mfaService.loginRequiresMfa] MFA bypass active — skipping MFA for', user?.email || user?.id)
    return false
  }
  const hasPhi = PHI_ROLES.has(user?.role)
  if (!hasPhi) return false
  if (!isMfaFullyEnrolled(user)) {
    console.log('[mfaService.loginRequiresMfa] enrollment required for', user?.email || user?.id, { role: user?.role })
    return 'ENROLLMENT_REQUIRED'
  }
  console.log('[mfaService.loginRequiresMfa] verification required for', user?.email || user?.id)
  return true
}

async function invalidateActiveTokens(pool, userId, purpose) {
  await pool.query(
    `UPDATE mfa_tokens
     SET consumed_at = NOW()
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  )
}

async function createMfaToken(pool, userId, purpose) {
  const code = generateCode()
  const codeHash = hashCode(code)
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)

  await invalidateActiveTokens(pool, userId, purpose)

  await pool.query(
    `INSERT INTO mfa_tokens (user_id, code_hash, purpose, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, codeHash, purpose, expiresAt, MAX_ATTEMPTS],
  )

  return { code, expiresAt }
}

async function sendCodeToUser(user, code) {
  const method = normalizeMethod(user.mfa_method)
  const destination = user.mfa_destination
  if (!method || !destination) {
    return { sent: false, reason: 'MFA destination not configured' }
  }
  if (method === 'email') {
    return sendMfaEmail(destination, code)
  }
  return sendMfaSms(destination, code)
}

async function issueAndSendCode(pool, user, purpose) {
  const { code } = await createMfaToken(pool, user.id, purpose)
  const delivery = await sendCodeToUser(user, code)
  return {
    ...delivery,
    destinationMasked: maskDestination(user.mfa_method, user.mfa_destination),
    method: user.mfa_method,
  }
}

async function verifyMfaCode(pool, userId, purpose, plainCode) {
  if (!/^\d{6}$/.test(String(plainCode || '').trim())) {
    return { ok: false, error: 'Invalid verification code.' }
  }

  const { rows } = await pool.query(
    `SELECT id, code_hash, expires_at, attempts, max_attempts
     FROM mfa_tokens
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, purpose],
  )

  const token = rows[0]
  if (!token) {
    return { ok: false, error: 'No active verification code. Request a new code.' }
  }

  if (new Date(token.expires_at) <= new Date()) {
    return { ok: false, error: 'Verification code expired. Request a new code.', expired: true }
  }

  if (token.attempts >= token.max_attempts) {
    return { ok: false, error: 'Too many failed attempts. Request a new code.', locked: true }
  }

  const submitted = hashCode(plainCode)
  if (submitted !== token.code_hash) {
    const usedAttempts = token.attempts + 1
    await pool.query('UPDATE mfa_tokens SET attempts = attempts + 1 WHERE id = $1', [token.id])
    const remaining = token.max_attempts - usedAttempts
    if (remaining <= 0) {
      return { ok: false, error: 'Too many failed attempts. Request a new code.', locked: true }
    }
    return { ok: false, error: 'Invalid verification code.', attemptsRemaining: remaining }
  }

  await pool.query('UPDATE mfa_tokens SET consumed_at = NOW() WHERE id = $1', [token.id])
  return { ok: true }
}

module.exports = {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  PHI_ROLES,
  generateCode,
  hashCode,
  normalizeMethod,
  normalizeEmail,
  normalizePhone,
  maskDestination,
  validateDestination,
  isMfaFullyEnrolled,
  adminRequiresMfa,
  loginRequiresMfa,
  createMfaToken,
  sendCodeToUser,
  issueAndSendCode,
  verifyMfaCode,
  invalidateActiveTokens,
  isMfaDisabled,
}
