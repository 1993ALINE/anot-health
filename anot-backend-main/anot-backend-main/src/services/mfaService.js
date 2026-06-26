const crypto = require('crypto')
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
 *   - 'ENROLLMENT_REQUIRED' — PHI role without MFA enrolled
 *   - true — PHI role with MFA enabled (TOTP challenge at login)
 */
function loginRequiresMfa(user) {
  const hasPhi = PHI_ROLES.has(user?.role)
  if (!hasPhi) return false
  if (!user?.mfa_enabled) return 'ENROLLMENT_REQUIRED'
  return true
}

module.exports = {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  PHI_ROLES,
  adminRequiresMfa,
  resolveMfaSecret,
  encryptMfaSecret,
  loginRequiresMfa,
}
