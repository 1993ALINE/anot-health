-- Super Admin role support + per-admin module access (JSON array of module keys; NULL = all grantable modules).
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_modules JSONB DEFAULT NULL;

COMMENT ON COLUMN users.admin_modules IS 'For role=admin only: array of allowed admin-portal module keys. NULL means all modules except the Admins tab (super-admin only). Super Admin rows ignore this column.';

UPDATE users SET status = 'inactive' WHERE role = 'receptionist';
