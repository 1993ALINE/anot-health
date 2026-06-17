-- Performance optimization: Add missing indexes for frequently queried columns
-- Run: node scripts/runMigrations.js

-- CRITICAL: users.email is used on EVERY login
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Critical: notes.visit_id is used in almost every note query
CREATE INDEX IF NOT EXISTS idx_notes_visit_id ON notes (visit_id);

-- Scribe assignments lookups
CREATE INDEX IF NOT EXISTS idx_scribe_assignments_clinician_id ON scribe_assignments (clinician_id);
CREATE INDEX IF NOT EXISTS idx_scribe_assignments_scribe_id ON scribe_assignments (scribe_id);

-- Date range queries on visits
CREATE INDEX IF NOT EXISTS idx_visits_visit_date ON visits (visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits (status);

-- Composite index for common query pattern: clinician + date
CREATE INDEX IF NOT EXISTS idx_visits_clinician_date ON visits (clinician_id, visit_date DESC);

-- Notes sorting and filtering
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes (updated_at DESC);

-- Grades lookup by note
CREATE INDEX IF NOT EXISTS idx_grades_note_id ON grades (note_id);
