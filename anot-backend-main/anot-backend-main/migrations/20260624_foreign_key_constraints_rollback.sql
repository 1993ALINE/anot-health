-- Rollback FK constraints added by fix-foreign-keys.ps1
ALTER TABLE visits DROP CONSTRAINT IF EXISTS fk_visits_clinician;
ALTER TABLE visits DROP CONSTRAINT IF EXISTS fk_visits_scribe;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS fk_notes_submitted_by;
ALTER TABLE notes DROP CONSTRAINT IF EXISTS fk_notes_locked_by;