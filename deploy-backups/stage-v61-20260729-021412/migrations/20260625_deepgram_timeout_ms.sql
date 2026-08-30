-- Transcription timeout (admin-configurable, 5–300 seconds stored as ms)
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS deepgram_timeout_ms INTEGER NOT NULL DEFAULT 30000;

UPDATE system_settings
SET deepgram_timeout_ms = GREATEST(5000, LEAST(COALESCE(deepgram_timeout_ms, 30000), 300000))
WHERE id = 1;
