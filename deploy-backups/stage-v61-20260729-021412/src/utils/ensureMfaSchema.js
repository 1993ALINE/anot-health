const { addColumnIfMissing, addIndexIfMissing } = require('./schemaDdl')
const pool = require('../config/db')

let ready = false

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  )
  return rows.length > 0
}

/** Idempotent MFA OTP schema — safe when SQL migration has not run yet. */
async function ensureMfaSchema() {
  if (ready) return

  await addColumnIfMissing('users', 'mfa_method', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(10)')
  await addColumnIfMissing('users', 'mfa_destination', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_destination TEXT')

  if (!(await tableExists('mfa_tokens'))) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mfa_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        purpose VARCHAR(32) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consumed_at TIMESTAMPTZ
      )
    `)
  }

  await addIndexIfMissing(
    'idx_mfa_tokens_user_purpose',
    `CREATE INDEX IF NOT EXISTS idx_mfa_tokens_user_purpose
       ON mfa_tokens (user_id, purpose, created_at DESC)`,
  )

  ready = true
}

module.exports = { ensureMfaSchema, tableExists: tableExists }
