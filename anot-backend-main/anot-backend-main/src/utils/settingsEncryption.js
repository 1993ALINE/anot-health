const crypto = require('crypto')

let warnedMissingKey = false

function keyBuf() {
  const key = process.env.SETTINGS_ENCRYPTION_KEY
  if (!key) {
    // Never fall back to JWT_SECRET (key reuse) — fail closed in production.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be set in production')
    }
    if (!warnedMissingKey) {
      console.warn('[⚠️] SETTINGS_ENCRYPTION_KEY not set, using temporary dev-only key')
      warnedMissingKey = true
    }
    // Stable dev-only key so values stay decryptable across restarts in dev.
    return crypto.createHash('sha256').update('anot-dev-settings-key', 'utf8').digest()
  }
  return crypto.createHash('sha256').update(String(key), 'utf8').digest()
}

/** AES-256-GCM; returns base64(iv+tag+ciphertext) or null */
function encryptString(plain) {
  if (plain == null || String(plain).length === 0) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf(), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

function decryptString(blob) {
  if (!blob) return null
  try {
    const buf = Buffer.from(String(blob), 'base64')
    if (buf.length < 28) return null
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (err) {
    console.error('[settingsEncryption] Decryption failed:', err.message)
    console.error('[settingsEncryption] Check that SETTINGS_ENCRYPTION_KEY matches the key used during encryption')
    return null
  }
}

module.exports = { encryptString, decryptString }
