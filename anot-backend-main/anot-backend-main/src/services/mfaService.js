const crypto = require('crypto')
const QRCode = require('qrcode')
const { authenticator } = require('otplib')
const { encryptString, decryptString } = require('../utils/settingsEncryption')

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

authenticator.options = { window: 1 }

function generateSecret(length = 20) {
  const bytes = crypto.randomBytes(length)
  let secret = ''
  for (let i = 0; i < bytes.length; i++) {
    secret += BASE32[bytes[i] % 32]
  }
  return secret.slice(0, 32)
}

function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase()
  )
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex')
}

/** Verify and consume a one-time recovery code at login. */
async function verifyRecoveryCode(user, plainCode, pool) {
  if (!user?.id || !plainCode) return false
  let hashes = user.mfa_recovery_codes
  if (typeof hashes === 'string') {
    try { hashes = JSON.parse(hashes) } catch { return false }
  }
  if (!Array.isArray(hashes) || hashes.length === 0) return false

  const submitted = hashRecoveryCode(String(plainCode).trim().toUpperCase())
  const idx = hashes.findIndex((h) => h === submitted)
  if (idx < 0) return false

  const remaining = hashes.filter((_, i) => i !== idx)
  await pool.query(
    'UPDATE users SET mfa_recovery_codes = $1 WHERE id = $2',
    [JSON.stringify(remaining), user.id],
  )
  await pool.query(
    'INSERT INTO mfa_recovery_code_usage (user_id, code_hash) VALUES ($1, $2)',
    [user.id, submitted],
  )
  return true
}

/** RFC 6238 TOTP verification against the user's base32 secret. */
function verifyTotp(secret, token) {
  if (!secret || !/^\d{6}$/.test(String(token))) {
    return false
  }
  try {
    return authenticator.verify({ token: String(token), secret: String(secret) })
  } catch {
    return false
  }
}

const PHI_ROLES = new Set(['clinician', 'scribe', 'qps', 'super_admin', 'admin'])

function adminRequiresMfa(role, mfaEnabled) {
  return PHI_ROLES.has(role) && !mfaEnabled
}

/** Resolve MFA secret from DB row — prefers encrypted column, falls back to legacy plaintext. */
function resolveMfaSecret(row) {
  if (!row) return null
  if (row.mfa_secret_encrypted) {
    return decryptString(row.mfa_secret_encrypted, 'mfa_secret')
  }
  return row.mfa_secret || null
}

/** Persist MFA secret encrypted at rest (AES-256-GCM). */
function encryptMfaSecret(plainSecret) {
  return encryptString(plainSecret)
}

/**
 * Resolve MFA requirement at login for PHI-access roles.
 * @returns {false|'ENROLLMENT_REQUIRED'|true}
 *   - false — role has no PHI access (MFA not required)
 *   - 'ENROLLMENT_REQUIRED' — PHI role without MFA fully enrolled
 *   - true — PHI role with MFA enabled and a stored secret (TOTP at login)
 */
function isMfaEnabledFlag(value) {
  return value === true || value === 't' || value === 1 || value === '1'
}

function userHasStoredMfaSecret(user) {
  if (!user) return false
  if (user.mfa_secret_encrypted) return true
  if (user.mfa_secret) return true
  return false
}

function isMfaFullyEnrolled(user) {
  return isMfaEnabledFlag(user?.mfa_enabled) && userHasStoredMfaSecret(user)
}

function loginRequiresMfa(user) {
  const hasPhi = PHI_ROLES.has(user?.role)
  if (!hasPhi) return false
  if (!isMfaFullyEnrolled(user)) return 'ENROLLMENT_REQUIRED'
  return true
}

/** Build standard otpauth:// URI for authenticator apps. */
function buildOtpauthUrl(email, secret) {
  const label = email || 'user'
  return authenticator.keyuri(label, 'Anot', secret)
}

/** PNG data URL suitable for <img src={...}> (CSP img-src data:). */
async function generateQrCodeDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 200,
  })
}

module.exports = {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
  PHI_ROLES,
  adminRequiresMfa,
  resolveMfaSecret,
  encryptMfaSecret,
  loginRequiresMfa,
  isMfaFullyEnrolled,
  buildOtpauthUrl,
  generateQrCodeDataUrl,
}
