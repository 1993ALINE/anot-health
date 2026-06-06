-- Fresh local PostgreSQL bootstrap for Anot (dev only).
-- Run: psql -U postgres -h 127.0.0.1 -d anot_dev -f scripts/bootstrap-local-schema.sql

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role VARCHAR(32) NOT NULL,
  specialty TEXT,
  phone TEXT,
  npi TEXT,
  license TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  avatar_data_url TEXT,
  personal_info TEXT,
  admin_modules JSONB DEFAULT NULL,
  rate_per_note NUMERIC(10, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mrn TEXT NOT NULL UNIQUE,
  date_of_birth DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scribe_assignments (
  id SERIAL PRIMARY KEY,
  clinician_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scribe_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinician_id, scribe_id)
);

CREATE TABLE IF NOT EXISTS visits (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  scribe_id INTEGER REFERENCES users(id),
  visit_date DATE NOT NULL,
  visit_time TEXT NOT NULL,
  visit_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'upcoming',
  duration_seconds INTEGER,
  audio_file TEXT,
  transcription_status VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_visit_type_check;
ALTER TABLE visits ADD CONSTRAINT visits_visit_type_check CHECK (
  visit_type::text = ANY (
    ARRAY['Follow-up'::text, 'New Patient'::text, 'Virtual Visit'::text, 'Other'::text]
  )
);

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  visit_id INTEGER NOT NULL UNIQUE REFERENCES visits(id) ON DELETE CASCADE,
  transcription TEXT,
  ai_draft TEXT,
  final_note TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  submitted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grades (
  id SERIAL PRIMARY KEY,
  note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  qps_id INTEGER NOT NULL REFERENCES users(id),
  accuracy INTEGER NOT NULL,
  completeness INTEGER NOT NULL,
  terminology INTEGER NOT NULL,
  formatting INTEGER NOT NULL,
  overall_score INTEGER NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visits_clinician ON visits (clinician_id);
CREATE INDEX IF NOT EXISTS idx_visits_scribe ON visits (scribe_id);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits (patient_id);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes (status);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES users(id);
