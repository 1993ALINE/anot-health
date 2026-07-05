-- Unified transcription settings columns (Deepgram Nova-3 Medical).
-- Safe to run multiple times (IF NOT EXISTS / idempotent updates).

ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_language VARCHAR(32) NOT NULL DEFAULT 'en-US';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_medical_specialty VARCHAR(32) NOT NULL DEFAULT 'PRIMARYCARE';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_show_speaker_labels BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_auto_transcribe_on_upload BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS transcribe_timeout_ms INTEGER NOT NULL DEFAULT 300000;

-- Copy legacy Deepgram settings where transcribe columns are still at defaults
UPDATE system_settings SET
  transcribe_enabled = COALESCE(transcribe_enabled, deepgram_enabled, false),
  transcribe_language = COALESCE(NULLIF(transcribe_language, ''), NULLIF(deepgram_language, ''), 'en-US'),
  transcribe_auto_transcribe_on_upload = COALESCE(transcribe_auto_transcribe_on_upload, deepgram_auto_transcribe_on_upload, true),
  transcribe_timeout_ms = COALESCE(NULLIF(transcribe_timeout_ms, 0), NULLIF(deepgram_timeout_ms, 0), 300000)
WHERE id = 1;
