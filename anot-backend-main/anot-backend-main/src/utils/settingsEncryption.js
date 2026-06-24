const crypto = require('crypto')

let warnedMissingKey = false
const loggedDecryptFailures = new Set()

function keyBuf({ allowDevFallback = true } = {}) {
  const key = process.env.SETTINGS_ENCRYPTION_KEY
  if (!key) {
    if (process.env.NODE_ENV === 'production' && !allowDevFallback) {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be set in production')
    }
    if (process.env.NODE_ENV === 'production') {
      if (!warnedMissingKey) {
        console.warn('[settingsEncryption] SETTINGS_ENCRYPTION_KEY not set — encrypted settings cannot be decrypted')
        warnedMissingKey = true
      }
      return null
    }
    if (!warnedMissingKey) {
      console.warn('[settingsEncryption] SETTINGS_ENCRYPTION_KEY not set, using temporary dev-only key')
      warnedMissingKey = true
    }
    return crypto.createHash('sha256').update('anot-dev-settings-key', 'utf8').digest()
  }
  return crypto.createHash('sha256').update(String(key), 'utf8').digest()
}

function logDecryptFailure(label, err) {
  const key = label || 'value'
  if (loggedDecryptFailures.has(key)) return
  loggedDecryptFailures.add(key)
  console.error(`[settingsEncryption] Decryption failed for ${key}:`, err.message)
  console.error('[settingsEncryption] Check that SETTINGS_ENCRYPTION_KEY matches the key used during encryption')
  console.warn('[settingsEncryption] Skipping corrupted setting — app will continue without this value')
}

/** AES-256-GCM; returns base64(iv+tag+ciphertext) or null */
function encryptString(plain) {
  if (plain == null || String(plain).length === 0) return null
  try {
    const key = keyBuf({ allowDevFallback: false })
    if (!key) {
      console.error('[settingsEncryption] Cannot encrypt: SETTINGS_ENCRYPTION_KEY is not configured')
      return null
    }
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc]).toString('base64')
  } catch (err) {
    console.error('[settingsEncryption] Encryption failed:', err.message)
    return null
  }
}

function decryptString(blob, label = 'encrypted setting') {
  if (!blob) return null
  try {
    const key = keyBuf()
    if (!key) return null

    const buf = Buffer.from(String(blob), 'base64')
    if (buf.length < 28) return null
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (err) {
    logDecryptFailure(label, err)
    return null
  }
}

/** Returns true when ciphertext is present and decrypts with the current key. */
function canDecrypt(blob) {
  if (!blob || String(blob).trim().length === 0) return true
  try {
    const key = keyBuf()
    if (!key) return false

    const buf = Buffer.from(String(blob), 'base64')
    if (buf.length < 28) return false
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    Buffer.concat([decipher.update(data), decipher.final()])
    return true
  } catch {
    return false
  }
}

module.exports = { encryptString, decryptString, canDecrypt }
