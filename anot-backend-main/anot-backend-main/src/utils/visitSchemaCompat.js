const pool = require('../config/db')
const { addColumnIfMissing, columnExists } = require('./schemaDdl')

let hasDurationSeconds = null
let hasTranscriptionStatus = null
let hasPatientConsentRecorded = null

async function visitDurationSelect(alias = 'v') {
  if (hasDurationSeconds === null) {
    hasDurationSeconds = await columnExists('visits', 'duration_seconds')
  }
  return hasDurationSeconds ? `${alias}.duration_seconds` : `NULL::integer AS duration_seconds`
}

async function visitTranscriptionStatusSelect(alias = 'v') {
  if (hasTranscriptionStatus === null) {
    hasTranscriptionStatus = await columnExists('visits', 'transcription_status')
  }
  return hasTranscriptionStatus
    ? `${alias}.transcription_status`
    : `NULL::varchar AS transcription_status`
}

async function visitHasDurationSeconds() {
  if (hasDurationSeconds === null) {
    hasDurationSeconds = await columnExists('visits', 'duration_seconds')
  }
  return hasDurationSeconds
}

async function visitHasTranscriptionStatus() {
  if (hasTranscriptionStatus === null) {
    hasTranscriptionStatus = await columnExists('visits', 'transcription_status')
  }
  return hasTranscriptionStatus
}

async function visitPatientConsentRecordedSelect(alias = 'v') {
  if (hasPatientConsentRecorded === null) {
    hasPatientConsentRecorded = await columnExists('visits', 'patient_consent_recorded')
  }
  return hasPatientConsentRecorded
    ? `${alias}.patient_consent_recorded`
    : `false AS patient_consent_recorded`
}

async function visitHasPatientConsentRecorded() {
  if (hasPatientConsentRecorded === null) {
    hasPatientConsentRecorded = await columnExists('visits', 'patient_consent_recorded')
  }
  return hasPatientConsentRecorded
}

/** Idempotent DDL for visits.patient_consent_recorded (local DBs without migration). */
async function ensurePatientConsentColumn() {
  await addColumnIfMissing(
    'visits',
    'patient_consent_recorded',
    'ALTER TABLE visits ADD COLUMN IF NOT EXISTS patient_consent_recorded BOOLEAN NOT NULL DEFAULT false',
  )
  hasPatientConsentRecorded = true
}

/** No-op when visits.transcription_status column is missing (old local DB). */
async function setVisitTranscriptionStatus(visitId, status) {
  if (!(await visitHasTranscriptionStatus())) return
  await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, [status, visitId])
}

/**
 * Atomically claim transcription for a visit: flips transcription_status to
 * 'processing' only if no other pipeline already holds it. Returns false when
 * the claim is lost, so concurrent triggers (auto-on-upload + manual button)
 * can't run the Deepgram/Anthropic pipeline twice for the same visit.
 * Always succeeds on legacy schemas without the column (no guard possible).
 */
async function claimVisitTranscription(visitId) {
  if (!(await visitHasTranscriptionStatus())) return true
  const { rows } = await pool.query(
    `UPDATE visits
        SET transcription_status = 'processing'
      WHERE id = $1
        AND (transcription_status IS NULL OR transcription_status <> 'processing')
      RETURNING id`,
    [visitId]
  )
  return rows.length > 0
}

module.exports = {
  visitDurationSelect,
  visitTranscriptionStatusSelect,
  visitPatientConsentRecordedSelect,
  visitHasDurationSeconds,
  visitHasTranscriptionStatus,
  visitHasPatientConsentRecorded,
  ensurePatientConsentColumn,
  setVisitTranscriptionStatus,
  claimVisitTranscription,
}
