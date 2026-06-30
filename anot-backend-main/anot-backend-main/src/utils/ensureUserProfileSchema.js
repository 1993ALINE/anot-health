const { addColumnIfMissing, addIndexIfMissing } = require('./schemaDdl')
const { invalidateUserColumnCache } = require('./userColumns')
const { ensureMfaSchema } = require('./ensureMfaSchema')

let ready = false

const PROFILE_COLUMNS = [
    { name: 'avatar_data_url', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data_url TEXT' },
    { name: 'personal_info', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_info TEXT' },
    { name: 'admin_modules', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_modules JSONB DEFAULT NULL' },
    { name: 'rate_per_note', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_per_note NUMERIC(10, 2)' },
    // Forces a password change on next login (temp passwords, admin resets, seeds).
    { name: 'force_password_change', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false' },
    // Gates first access behind the PHI awareness training acknowledgment (HIPAA workforce training).
    { name: 'phi_training_acknowledged', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS phi_training_acknowledged BOOLEAN NOT NULL DEFAULT false' },
    { name: 'phi_training_acknowledged_at', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS phi_training_acknowledged_at TIMESTAMPTZ' },
    { name: 'phi_training_version', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS phi_training_version INTEGER NOT NULL DEFAULT 1' },
    { name: 'token_version', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0' },
    { name: 'mfa_enabled', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false' },
    { name: 'mfa_method', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(10)' },
    { name: 'mfa_destination', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_destination TEXT' },
    { name: 'failed_login_attempts', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0' },
    { name: 'locked_until', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ' },
    { name: 'last_failed_login_at', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ' },
]

const PROFILE_INDEXES = [
    {
        name: 'idx_users_force_password_change',
        ddl: 'CREATE INDEX IF NOT EXISTS idx_users_force_password_change ON users(force_password_change) WHERE force_password_change = true',
    },
]

/** Idempotent profile columns on users — skips ALTER when columns already exist. */
async function ensureUserProfileSchema() {
    if (ready) return
    for (const col of PROFILE_COLUMNS) {
        await addColumnIfMissing('users', col.name, col.ddl)
    }
    for (const idx of PROFILE_INDEXES) {
        await addIndexIfMissing(idx.name, idx.ddl)
    }
    await ensureMfaSchema()
    invalidateUserColumnCache()
    ready = true
}

module.exports = { ensureUserProfileSchema }
