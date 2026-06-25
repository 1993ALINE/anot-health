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

function adminRequiresMfa(role, mfaEnabled) {
  const adminRoles = new Set(['admin', 'super_admin'])
  return adminRoles.has(role) && !mfaEnabled
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

/** True when the account must complete MFA at login before receiving a full session. */
function loginRequiresMfa(user) {
  return user?.mfa_enabled === true
}

module.exports = {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  adminRequiresMfa,
  resolveMfaSecret,
  encryptMfaSecret,
  loginRequiresMfa,
}
