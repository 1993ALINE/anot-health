const { addIndexIfMissing } = require('./schemaDdl')

let ready = false

async function ensureClinicianTemplatesSchema() {
    if (ready) return
    await require('../config/db').query(`
        CREATE TABLE IF NOT EXISTS clinician_templates (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            template_id VARCHAR(64) NOT NULL,
            name VARCHAR(255) NOT NULL,
            icon VARCHAR(16),
            color VARCHAR(32),
            accent VARCHAR(32),
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, template_id)
        )
    `)
    await addIndexIfMissing(
        'idx_clinician_templates_user_id',
        'CREATE INDEX IF NOT EXISTS idx_clinician_templates_user_id ON clinician_templates(user_id)',
    )
    ready = true
}

module.exports = { ensureClinicianTemplatesSchema }
