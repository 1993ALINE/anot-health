-- Per-account login lockout after repeated failed attempts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ;
