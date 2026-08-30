const pool = require('../config/db')
const { encryptString, decryptString } = require('../utils/settingsEncryption')
const { getDriver, listSupportedTypes } = require('./ehrDrivers')

function decryptCredentials(credentialsEnc, label) {
  if (!credentialsEnc) return null
  const json = decryptString(credentialsEnc, label)
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch (err) {
    console.warn(`[ehrConnectionsService] Failed to parse decrypted credentials for ${label}: ${err.message}`)
    return null
  }
}

function encryptCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return null
  return encryptString(JSON.stringify(credentials))
}

/** True when every field the driver's type requires has a non-empty value. */
function hasCompleteCredentials(ehrType, credentials) {
  if (!credentials) return false
  const driver = getDriver(ehrType)
  return driver.credentialFields.every(({ key }) => String(credentials[key] || '').trim().length > 0)
}

function toPublicView(row) {
  return {
    id: row.id,
    ehr_type: row.ehr_type,
    name: row.name,
    enabled: row.enabled,
    credentials_set: !!row.credentials_enc,
    config: row.config || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function listConnections() {
  const { rows } = await pool.query('SELECT * FROM ehr_connections ORDER BY name ASC')
  return rows.map(toPublicView)
}

/** Internal use only — includes decrypted credentials for driver calls. Never send this to the client. */
async function getConnection(id) {
  const { rows } = await pool.query('SELECT * FROM ehr_connections WHERE id = $1', [id])
  const row = rows[0]
  if (!row) return null
  return { ...row, credentials: decryptCredentials(row.credentials_enc, `ehr_connection:${id}`) }
}

async function createConnection({ ehr_type, name, enabled, credentials, config }) {
  getDriver(ehr_type) // throws for unknown types
  if (!name || !String(name).trim()) {
    throw new Error('Connection name is required.')
  }
  const credentialsEnc = encryptCredentials(credentials)
  const { rows } = await pool.query(
    `INSERT INTO ehr_connections (ehr_type, name, enabled, credentials_enc, config)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [ehr_type, String(name).trim(), !!enabled, credentialsEnc, config ? JSON.stringify(config) : null],
  )
  return toPublicView(rows[0])
}

async function updateConnection(id, payload = {}) {
  const current = await getConnection(id)
  if (!current) return null

  const name = payload.name !== undefined ? String(payload.name).trim() || current.name : current.name
  const enabled = payload.enabled !== undefined ? !!payload.enabled : current.enabled

  let credentials = current.credentials
  if (payload.credentials && typeof payload.credentials === 'object') {
    const driver = getDriver(current.ehr_type)
    const merged = { ...(current.credentials || {}) }
    for (const { key } of driver.credentialFields) {
      const incoming = payload.credentials[key]
      if (incoming != null && String(incoming).trim()) {
        merged[key] = String(incoming).trim()
      }
    }
    credentials = merged
  }
  if (payload.clear_credentials === true) {
    credentials = null
  }

  const { rows } = await pool.query(
    `UPDATE ehr_connections
        SET name = $1, enabled = $2, credentials_enc = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [name, enabled, encryptCredentials(credentials), id],
  )
  return toPublicView(rows[0])
}

async function deleteConnection(id) {
  // users.ehr_connection_id / visits.ehr_connection_id / notes.ehr_connection_id are
  // ON DELETE SET NULL, so removing a connection just unassigns clinicians rather
  // than blocking or cascading into clinical data.
  await pool.query('DELETE FROM ehr_connections WHERE id = $1', [id])
}

module.exports = {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  toPublicView,
  hasCompleteCredentials,
  listSupportedTypes,
}
