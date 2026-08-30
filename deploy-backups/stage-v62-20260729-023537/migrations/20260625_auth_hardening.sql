-- JWT revocation + encrypted MFA secrets (H2/H3)
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_encrypted TEXT;

-- Plaintext mfa_secret retained for 30-day migration lag; drop in a future migration.
