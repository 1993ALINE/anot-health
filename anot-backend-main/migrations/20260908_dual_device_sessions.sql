-- Dual concurrent sessions per user account (Desktop + Mobile)
-- Enables a clinician/staff to maintain one active desktop session and one active mobile session simultaneously.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_mobile_session_id TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_mobile_active_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_active_mobile_session ON users(active_mobile_session_id) WHERE active_mobile_session_id IS NOT NULL;
