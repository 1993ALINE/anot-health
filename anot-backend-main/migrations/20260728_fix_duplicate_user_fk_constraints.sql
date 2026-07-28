-- Fixes duplicate/conflicting foreign key constraints on columns referencing users(id).
--
-- visits.clinician_id had TWO FK constraints simultaneously: the intended
-- `fk_visits_clinician` (ON DELETE RESTRICT — clinicians with clinical history
-- must be deactivated, never deleted) and a stray auto-named
-- `visits_clinician_id_fkey` (ON DELETE CASCADE) from before that constraint
-- existed. A later migration's "IF NOT EXISTS" check only looked for the
-- specific name `fk_visits_clinician` and missed the pre-existing one, so both
-- ended up live at once — which constraint actually fires on DELETE is
-- Postgres trigger-order-dependent, not something application code should
-- rely on. Drop the stray CASCADE one; keep only the intended RESTRICT.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_clinician_id_fkey') THEN
    ALTER TABLE visits DROP CONSTRAINT visits_clinician_id_fkey;
  END IF;
END $$;

-- notes.ehr_uploaded_by (added for the Tebra EHR upload tracking column) had
-- no ON DELETE action, which defaults to NO ACTION (blocks deletion) —
-- inconsistent with submitted_by/locked_by, which both SET NULL so scribes
-- remain fully deletable. Replace with the same SET NULL pattern.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_ehr_uploaded_by_fkey') THEN
    ALTER TABLE notes DROP CONSTRAINT notes_ehr_uploaded_by_fkey;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_notes_ehr_uploaded_by') THEN
    ALTER TABLE notes
      ADD CONSTRAINT fk_notes_ehr_uploaded_by
      FOREIGN KEY (ehr_uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- notes.locked_by and notes.submitted_by also each had a duplicate stray
-- auto-named constraint alongside the intended `fk_notes_*` one. Both
-- resolved to the same net effect (SET NULL), so this is pure cleanup, not a
-- behavior change — but two FK constraints on one column is confusing and
-- risks a repeat of the visits.clinician_id situation on a future migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_locked_by_fkey') THEN
    ALTER TABLE notes DROP CONSTRAINT notes_locked_by_fkey;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_submitted_by_fkey') THEN
    ALTER TABLE notes DROP CONSTRAINT notes_submitted_by_fkey;
  END IF;
END $$;
