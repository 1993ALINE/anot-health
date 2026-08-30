-- Replace TOTP/QR MFA with email/SMS one-time codes.
-- Existing TOTP enrollments must re-enroll via the new flow.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'mfa_secret'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'mfa_secret_encrypted'
  ) THEN
    UPDATE users
    SET mfa_enabled = false
    WHERE mfa_secret IS NOT NULL
       OR mfa_secret_encrypted IS NOT NULL
       OR mfa_enabled = true;
  ELSE
    UPDATE users SET mfa_enabled = false WHERE mfa_enabled = true;
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_destination TEXT;

ALTER TABLE users DROP COLUMN IF EXISTS mfa_secret;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_secret_encrypted;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_recovery_codes;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_enforced_at;

DROP TABLE IF EXISTS mfa_recovery_code_usage;

CREATE TABLE IF NOT EXISTS mfa_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mfa_tokens_user_purpose
  ON mfa_tokens (user_id, purpose, created_at DESC);
