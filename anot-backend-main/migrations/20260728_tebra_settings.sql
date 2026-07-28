-- Tebra EHR integration settings (encrypted credentials at rest).
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS tebra_enabled BOOLEAN DEFAULT false;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS tebra_customer_key_enc TEXT;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS tebra_user_enc TEXT;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS tebra_password_enc TEXT;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS tebra_practice_id VARCHAR(64);
