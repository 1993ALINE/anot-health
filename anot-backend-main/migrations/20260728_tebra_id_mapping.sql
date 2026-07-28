-- External ID mapping for Tebra EHR sync (patients/visits/notes/users).
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS tebra_patient_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS patients_tebra_patient_id_idx
  ON patients (tebra_patient_id) WHERE tebra_patient_id IS NOT NULL;

ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS tebra_appointment_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS visits_tebra_appointment_id_idx
  ON visits (tebra_appointment_id) WHERE tebra_appointment_id IS NOT NULL;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS tebra_encounter_id VARCHAR(64);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tebra_provider_id VARCHAR(64);
