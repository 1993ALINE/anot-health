-- Anthropic AI note generation settings (encrypted API key at rest).
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS anthropic_api_key_enc TEXT;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS anthropic_enabled BOOLEAN DEFAULT true;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS anthropic_model VARCHAR(100) DEFAULT 'claude-haiku-4-5';
