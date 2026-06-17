-- Columns expected by the API but missing from early local bootstraps.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rate_per_note NUMERIC(10, 2);

ALTER TABLE visits ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER NOT NULL DEFAULT 365;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_api_key_enc TEXT;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_model VARCHAR(64) NOT NULL DEFAULT 'nova-2';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_language VARCHAR(32) NOT NULL DEFAULT 'en-US';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_webhook_url TEXT NOT NULL DEFAULT '';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_auto_transcribe_on_upload BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_target_format VARCHAR(8) NOT NULL DEFAULT 'mp3';
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_compression INTEGER NOT NULL DEFAULT 5;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_max_upload_mb INTEGER NOT NULL DEFAULT 100;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS ffmpeg_preprocess_before_transcribe BOOLEAN NOT NULL DEFAULT true;

UPDATE system_settings
SET audit_retention_days = GREATEST(30, LEAST(COALESCE(audit_retention_days, 365), 3650))
WHERE id = 1;
