const { addColumnIfMissing, addIndexIfMissing } = require('./schemaDdl')
const { invalidateUserColumnCache } = require('./userColumns')

let ready = false

const PROFILE_COLUMNS = [
    { name: 'avatar_data_url', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data_url TEXT' },
    { name: 'personal_info', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_info TEXT' },
    { name: 'admin_modules', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_modules JSONB DEFAULT NULL' },
    { name: 'rate_per_note', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_per_note NUMERIC(10, 2)' },
    // Forces a password change on next login (temp passwords, admin resets, seeds).
    { name: 'force_password_change', ddl: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false' },
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
    invalidateUserColumnCache()
    ready = true
}

module.exports = { ensureUserProfileSchema }
