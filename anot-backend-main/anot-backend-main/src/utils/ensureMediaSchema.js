const pool = require('../config/db')
const { addColumnIfMissing } = require('./schemaDdl')

let done = false

const MEDIA_COLUMNS = [
    { table: 'visits', name: 'duration_seconds', ddl: `ALTER TABLE visits ADD COLUMN IF NOT EXISTS duration_seconds INTEGER` },
    { table: 'visits', name: 'transcription_status', ddl: `ALTER TABLE visits ADD COLUMN IF NOT EXISTS transcription_status VARCHAR(32)` },
    { table: 'visits', name: 'patient_consent_recorded', ddl: `ALTER TABLE visits ADD COLUMN IF NOT EXISTS patient_consent_recorded BOOLEAN NOT NULL DEFAULT false` },
    { table: 'system_settings', name: 'deepgram_enabled', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_enabled BOOLEAN NOT NULL DEFAULT false` },
    { table: 'system_settings', name: 'deepgram_api_key_enc', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_api_key_enc TEXT` },
    { table: 'system_settings', name: 'deepgram_model', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_model VARCHAR(64) NOT NULL DEFAULT 'nova-2'` },
    { table: 'system_settings', name: 'deepgram_language', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_language VARCHAR(32) NOT NULL DEFAULT 'en-US'` },
    { table: 'system_settings', name: 'deepgram_webhook_url', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_webhook_url TEXT NOT NULL DEFAULT ''` },
    { table: 'system_settings', name: 'deepgram_auto_transcribe_on_upload', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_auto_transcribe_on_upload BOOLEAN NOT NULL DEFAULT false` },
    { table: 'system_settings', name: 'ffmpeg_enabled', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_enabled BOOLEAN NOT NULL DEFAULT false` },
    { table: 'system_settings', name: 'ffmpeg_target_format', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_target_format VARCHAR(8) NOT NULL DEFAULT 'mp3'` },
    { table: 'system_settings', name: 'ffmpeg_compression', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_compression INTEGER NOT NULL DEFAULT 5` },
    { table: 'system_settings', name: 'ffmpeg_max_upload_mb', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_max_upload_mb INTEGER NOT NULL DEFAULT 500` },
    { table: 'system_settings', name: 'ffmpeg_preprocess_before_transcribe', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_preprocess_before_transcribe BOOLEAN NOT NULL DEFAULT true` },
    { table: 'system_settings', name: 'anthropic_api_key_enc', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS anthropic_api_key_enc TEXT` },
    { table: 'system_settings', name: 'anthropic_enabled', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS anthropic_enabled BOOLEAN NOT NULL DEFAULT true` },
    { table: 'system_settings', name: 'anthropic_model', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS anthropic_model VARCHAR(100) NOT NULL DEFAULT 'claude-haiku-4-5'` },
    { table: 'system_settings', name: 'deepgram_timeout_ms', ddl: `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_timeout_ms INTEGER NOT NULL DEFAULT 30000` },
]

/** Idempotent DDL for AI/media columns (shared by settings + runtime). */
async function ensureMediaAndAiSchema() {
    if (done) return
    for (const col of MEDIA_COLUMNS) {
        await addColumnIfMissing(col.table, col.name, col.ddl)
    }
    done = true
}

module.exports = { ensureMediaAndAiSchema }
