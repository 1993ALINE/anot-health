-- HIPAA hardening for audit_logs: make the table append-only and raise the
-- retention floor to 7 years.
--
-- NOTE ON ENFORCEMENT MODEL:
-- The application connects to PostgreSQL as the table OWNER (e.g. neondb_owner).
-- In PostgreSQL the table owner implicitly bypasses GRANT/REVOKE privilege
-- checks, so `REVOKE DELETE/UPDATE/TRUNCATE ... FROM <owner>` does NOT actually
-- prevent the app from deleting audit rows. Triggers, however, fire regardless
-- of role — including for the owner — so we enforce append-only with triggers.
--
-- The retention purge is the single sanctioned deleter. It opts in for its own
-- transaction via the `anot.allow_audit_purge` GUC, which the trigger checks.

-- ── Defense-in-depth: drop privileges for non-owner roles (no-op for owner) ──
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;

-- ── Block UPDATE always; block DELETE unless the retention purge opted in ──
CREATE OR REPLACE FUNCTION audit_logs_enforce_append_only()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit_logs is append-only: UPDATE is not permitted';
    END IF;
    -- DELETE path: only the retention job may proceed.
    IF current_setting('anot.allow_audit_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_logs is append-only: DELETE is only permitted via the retention purge';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_enforce_append_only();

-- ── Row triggers do not fire on TRUNCATE; block it with a statement trigger ──
CREATE OR REPLACE FUNCTION audit_logs_block_truncate()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_truncate();

-- ── Retention: 7-year default, 6-year floor, 10-year cap ──
-- New installs default to 7 years. One-time correction: bump any value below
-- the 7-year target (e.g. the stale 365-day default) up to 2555, cap at 3650.
ALTER TABLE system_settings
    ALTER COLUMN audit_retention_days SET DEFAULT 2555;

UPDATE system_settings
    SET audit_retention_days = LEAST(GREATEST(COALESCE(audit_retention_days, 2555), 2555), 3650)
    WHERE id = 1;
