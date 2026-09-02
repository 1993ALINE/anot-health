-- Single concurrent session per user account
-- Tracks the current active session ID and last activity timestamp for each user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_active_session ON users(active_session_id) WHERE active_session_id IS NOT NULL;
