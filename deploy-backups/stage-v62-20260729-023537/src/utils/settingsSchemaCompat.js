const pool = require('../config/db')
const { columnExists } = require('./schemaDdl')

let columnCache = null
let columnCacheAt = 0
const CACHE_MS = 30_000

async function getSystemSettingsColumns() {
  const now = Date.now()
  if (columnCache && now - columnCacheAt < CACHE_MS) return columnCache
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'system_settings'`,
  )
  columnCache = new Set(rows.map((r) => r.column_name))
  columnCacheAt = now
  return columnCache
}

function invalidateSettingsColumnCache() {
  columnCache = null
}

/** UPDATE only columns that exist (local DB may lack AI/audit columns until postgres migration). */
async function updateSystemSettingsRow(fields) {
  const cols = await getSystemSettingsColumns()
  const entries = Object.entries(fields).filter(([key]) => cols.has(key))
  if (entries.length === 0) {
    throw new Error('No writable columns on system_settings')
  }
  const sets = entries.map(([key], i) => `${key} = $${i + 1}`)
  const values = entries.map(([, val]) => val)
  const sql = `UPDATE system_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1 RETURNING *`
  return pool.query(sql, values)
}

module.exports = {
  getSystemSettingsColumns,
  invalidateSettingsColumnCache,
  updateSystemSettingsRow,
  columnExists,
}
