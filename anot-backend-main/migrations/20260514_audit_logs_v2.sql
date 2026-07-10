-- Extended audit trail: IP, device, status, module, categories, metadata.
-- Run once on deploy; auditLogger also self-heals missing columns in dev.

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER,
    user_name TEXT,
    user_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'success';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS module_key VARCHAR(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_category VARCHAR(48);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_path VARCHAR(512);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs (status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_module_key ON audit_logs (module_key);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_category ON audit_logs (action_category);
