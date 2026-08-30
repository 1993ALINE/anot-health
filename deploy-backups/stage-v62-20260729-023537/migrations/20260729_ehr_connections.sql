-- Multi-EHR integration framework. Replaces the single-Tebra-only schema
-- (never deployed) with a generic connections table so additional EHR
-- systems can be added later without further migrations.

CREATE TABLE IF NOT EXISTS ehr_connections (
  id               SERIAL PRIMARY KEY,
  ehr_type         VARCHAR(32) NOT NULL,
  name             VARCHAR(128) NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  credentials_enc  TEXT,
  config           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A clinician's notes route to whichever EHR connection they're assigned to;
-- NULL means no EHR configured for that clinician (upload stays a no-op flag).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ehr_connection_id INTEGER REFERENCES ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ehr_provider_id VARCHAR(64);

-- Multiple clinicians commonly share one EHR connection's credentials (one
-- practice-wide login), each with their own external provider id — that's
-- fully supported. This constraint only guards against *misconfiguration*:
-- two clinicians accidentally given the same provider id under the same
-- connection, which would otherwise silently mix their schedules/patients.
CREATE UNIQUE INDEX IF NOT EXISTS users_ehr_connection_provider_idx
  ON users (ehr_connection_id, ehr_provider_id)
  WHERE ehr_connection_id IS NOT NULL AND ehr_provider_id IS NOT NULL;

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS ehr_connection_id INTEGER REFERENCES ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS ehr_appointment_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS visits_ehr_appointment_id_idx
  ON visits (ehr_connection_id, ehr_appointment_id) WHERE ehr_appointment_id IS NOT NULL;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS ehr_encounter_id VARCHAR(64);

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS ehr_connection_id INTEGER REFERENCES ehr_connections(id) ON DELETE SET NULL;

-- A patient can have a different external chart ID per EHR connection
-- (e.g. seen by clinicians on two different systems).
CREATE TABLE IF NOT EXISTS patient_ehr_ids (
  patient_id         INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ehr_connection_id  INTEGER NOT NULL REFERENCES ehr_connections(id) ON DELETE CASCADE,
  external_patient_id VARCHAR(64) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (patient_id, ehr_connection_id)
);

CREATE INDEX IF NOT EXISTS patient_ehr_ids_lookup_idx
  ON patient_ehr_ids (ehr_connection_id, external_patient_id);
