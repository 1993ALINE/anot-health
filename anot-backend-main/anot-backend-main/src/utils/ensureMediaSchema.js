const pool = require('../config/db')

let done = false

/** Idempotent DDL for AI/media columns (shared by settings + runtime). */
async function ensureMediaAndAiSchema() {
  if (done) return
  const alters = [
    `ALTER TABLE visits ADD COLUMN IF NOT EXISTS transcription_status VARCHAR(32)`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_enabled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_api_key_enc TEXT`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_model VARCHAR(64) NOT NULL DEFAULT 'nova-2'`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_language VARCHAR(32) NOT NULL DEFAULT 'en-US'`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_webhook_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_auto_transcribe_on_upload BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_enabled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_target_format VARCHAR(8) NOT NULL DEFAULT 'mp3'`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_compression INTEGER NOT NULL DEFAULT 5`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_max_upload_mb INTEGER NOT NULL DEFAULT 100`,
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_preprocess_before_transcribe BOOLEAN NOT NULL DEFAULT true`,
  ]
  for (const sql of alters) await pool.query(sql)
  done = true
}

module.exports = { ensureMediaAndAiSchema }
