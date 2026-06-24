const crypto = require('crypto')

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

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

/** Placeholder TOTP verify â€” replace with otplib in production. */
function verifyTotp(_secret, token) {
  return /^\d{6}$/.test(String(token))
}

function adminRequiresMfa(role, mfaEnabled) {
  const adminRoles = new Set(['admin', 'super_admin'])
  return adminRoles.has(role) && !mfaEnabled
}

module.exports = {
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
  adminRequiresMfa,
}