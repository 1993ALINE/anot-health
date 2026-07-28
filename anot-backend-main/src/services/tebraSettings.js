const pool = require('../config/db')
const { addColumnIfMissing } = require('../utils/schemaDdl')
const { encryptString, decryptString } = require('../utils/settingsEncryption')

const TEBRA_COLUMNS = [
  { name: 'tebra_enabled', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tebra_enabled BOOLEAN DEFAULT false` },
  { name: 'tebra_customer_key_enc', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tebra_customer_key_enc TEXT` },
  { name: 'tebra_user_enc', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tebra_user_enc TEXT` },
  { name: 'tebra_password_enc', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tebra_password_enc TEXT` },
  { name: 'tebra_practice_id', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS tebra_practice_id VARCHAR(64)` },
]

let schemaEnsured = false

/** Idempotent DDL for Tebra settings columns — kept isolated from the shared AI/media schema. */
async function ensureTebraSchema() {
  if (schemaEnsured) return
  for (const col of TEBRA_COLUMNS) {
    await addColumnIfMissing('system_settings', col.name, col.ddl)
  }
  schemaEnsured = true
}

let cache = { at: 0, value: null }
const TTL_MS = 4000

function safeDecrypt(encrypted, label) {
  if (!encrypted) return null
  try {
    return decryptString(encrypted, label)
  } catch (err) {
    console.warn(`[tebraSettings] Skipping ${label}: ${err.message}`)
    return null
  }
}

function rowToRuntime(row) {
  return {
    tebra_enabled: !!row?.tebra_enabled,
    tebra_customer_key: safeDecrypt(row?.tebra_customer_key_enc, 'tebra_customer_key_enc'),
    tebra_user: safeDecrypt(row?.tebra_user_enc, 'tebra_user_enc'),
    tebra_password: safeDecrypt(row?.tebra_password_enc, 'tebra_password_enc'),
    tebra_practice_id: row?.tebra_practice_id || null,
  }
}

/** Load Tebra settings (decrypted), cached briefly like loadAiSettings(). */
async function loadTebraSettings() {
  const now = Date.now()
  if (cache.value && now - cache.at < TTL_MS) return cache.value

  await ensureTebraSchema()
  const result = await pool.query('SELECT * FROM system_settings WHERE id = 1')
  const value = rowToRuntime(result.rows[0])
  cache = { at: now, value }
  return value
}

function invalidateTebraSettingsCache() {
  cache = { at: 0, value: null }
}

/** Persist Tebra settings; only overwrites a credential when a non-empty value is supplied. */
async function saveTebraSettings(payload = {}) {
  await ensureTebraSchema()
  const cur = (await pool.query('SELECT * FROM system_settings WHERE id = 1')).rows[0] || {}

  const tebra_enabled = payload.tebra_enabled !== undefined ? !!payload.tebra_enabled : !!cur.tebra_enabled

  let tebra_customer_key_enc = cur.tebra_customer_key_enc || null
  if (payload.tebra_clear_credentials === true) {
    tebra_customer_key_enc = null
  } else if (payload.tebra_customer_key != null && String(payload.tebra_customer_key).trim()) {
    tebra_customer_key_enc = encryptString(String(payload.tebra_customer_key).trim())
  }

  let tebra_user_enc = cur.tebra_user_enc || null
  if (payload.tebra_clear_credentials === true) {
    tebra_user_enc = null
  } else if (payload.tebra_user != null && String(payload.tebra_user).trim()) {
    tebra_user_enc = encryptString(String(payload.tebra_user).trim())
  }

  let tebra_password_enc = cur.tebra_password_enc || null
  if (payload.tebra_clear_credentials === true) {
    tebra_password_enc = null
  } else if (payload.tebra_password != null && String(payload.tebra_password).trim()) {
    tebra_password_enc = encryptString(String(payload.tebra_password).trim())
  }

  const tebra_practice_id = payload.tebra_clear_credentials === true
    ? null
    : (payload.tebra_practice_id !== undefined ? String(payload.tebra_practice_id).trim().slice(0, 64) || null : (cur.tebra_practice_id || null))

  await pool.query(
    `UPDATE system_settings
        SET tebra_enabled = $1,
            tebra_customer_key_enc = $2,
            tebra_user_enc = $3,
            tebra_password_enc = $4,
            tebra_practice_id = $5,
            updated_at = NOW()
      WHERE id = 1`,
    [tebra_enabled, tebra_customer_key_enc, tebra_user_enc, tebra_password_enc, tebra_practice_id],
  )

  invalidateTebraSettingsCache()
  return loadTebraSettings()
}

/** Public-safe view — never returns decrypted secrets, only whether they're set. */
function toPublicView(settings) {
  return {
    tebra_enabled: settings.tebra_enabled,
    tebra_customer_key_set: !!settings.tebra_customer_key,
    tebra_user_set: !!settings.tebra_user,
    tebra_password_set: !!settings.tebra_password,
    tebra_practice_id: settings.tebra_practice_id,
  }
}

module.exports = {
  ensureTebraSchema,
  loadTebraSettings,
  invalidateTebraSettingsCache,
  saveTebraSettings,
  toPublicView,
}
