-- Patient recording consent — clinician attestation before audio capture
ALTER TABLE visits ADD COLUMN IF NOT EXISTS patient_consent_recorded BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_visits_patient_consent_recorded ON visits (patient_consent_recorded)
  WHERE patient_consent_recorded = true;
