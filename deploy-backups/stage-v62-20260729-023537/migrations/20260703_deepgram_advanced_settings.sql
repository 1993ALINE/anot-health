-- Deepgram advanced transcription settings (Admin → Settings → Deepgram → Advanced).

ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_profanity_filter BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_punctuate BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_numerals BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_redact_pii BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_remove_filler_words BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS deepgram_custom_vocabulary JSONB NOT NULL DEFAULT '[]'::jsonb;
