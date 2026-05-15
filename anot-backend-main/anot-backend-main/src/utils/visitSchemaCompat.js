const pool = require('../config/db')
const { columnExists } = require('./schemaDdl')

let hasDurationSeconds = null
let hasTranscriptionStatus = null

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

/** No-op when visits.transcription_status column is missing (old local DB). */
async function setVisitTranscriptionStatus(visitId, status) {
  if (!(await visitHasTranscriptionStatus())) return
  await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, [status, visitId])
}

module.exports = {
  visitDurationSelect,
  visitTranscriptionStatusSelect,
  visitHasDurationSeconds,
  visitHasTranscriptionStatus,
  setVisitTranscriptionStatus,
}
