/**
 * Transcription status polling for long-running Deepgram jobs (30+ minute audio).
 * Polls GET /api/visits for transcription_status (works before a note row exists).
 * Fetches full note via GET /api/notes/visit/:visitId once transcription completes.
 */
import { notesAPI, visitsAPI, isAbortError } from './api'

/** Max wait for a single transcription job (default 30 min). */
export const MAX_POLL_WAIT_MS = parseInt(
  import.meta.env.VITE_TRANSCRIPTION_MAX_POLL_MS || '1800000',
  10,
)

/** Interval between status polls (default 10 s). */
export const POLL_INTERVAL_MS = parseInt(
  import.meta.env.VITE_TRANSCRIPTION_POLL_INTERVAL_MS || '10000',
  10,
)

/** Per-request fetch timeout during polling (default 30 s). */
const POLL_REQUEST_TIMEOUT_MS = parseInt(
  import.meta.env.VITE_TRANSCRIPTION_POLL_REQUEST_TIMEOUT_MS || '30000',
  10,
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return promise(controller.signal).finally(() => clearTimeout(timer))
}

/** Visit-level transcription status (note row may not exist yet). */
async function getVisitTranscriptionStatus(visitId, signal) {
  const data = await visitsAPI.getAll(null, null, signal)
  const visit = (data?.visits || []).find((v) => String(v.id) === String(visitId))
  if (!visit) {
    const err = new Error('Visit not found')
    err.status = 404
    throw err
  }
  return visit
}

/** Fetch note for a visit; falls back to visit-level status when note row is absent. */
export async function getTranscription(visitId, signal) {
  try {
    const data = await notesAPI.getByVisit(visitId, signal)
    return data?.note ?? data
  } catch (err) {
    if (err?.status !== 404) {throw err}
    const visit = await getVisitTranscriptionStatus(visitId, signal)
    return {
      visit_id: parseInt(visitId, 10),
      transcription_status: visit.transcription_status || 'unknown',
      status: 'pending',
      transcription: null,
      ai_draft: null,
      final_note: null,
      audio_file: visit.audio_file,
    }
  }
}

/**
 * Poll until transcription completes, fails, or maxWaitTime is exceeded.
 * @returns {Promise<{ status: string, note: object|null }>}
 */
export async function pollTranscriptionStatus(visitId, {
  maxWaitTime = MAX_POLL_WAIT_MS,
  pollInterval = POLL_INTERVAL_MS,
  onProgress,
} = {}) {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const visit = await withTimeout(
        (signal) => getVisitTranscriptionStatus(visitId, signal),
        POLL_REQUEST_TIMEOUT_MS,
      )
      const status = visit.transcription_status || 'unknown'
      onProgress?.({ status, note: null })

      if (status === 'completed') {
        const note = await getTranscription(visitId)
        return { status: 'completed', note }
      }
      if (status === 'failed') {
        throw new Error('Transcription failed')
      }

      await sleep(pollInterval)
    } catch (error) {
      if (isAbortError(error)) {
        console.warn('[transcription] Poll request timed out, retrying…')
        await sleep(5000)
        continue
      }
      if (error?.status === 411) {
        console.warn('[transcription] 411 error — retrying…')
        await sleep(5000)
        continue
      }
      console.error('[transcription] Poll error:', error)
      await sleep(5000)
    }
  }

  throw new Error('Transcription timeout (>30 min)')
}

/** Queue server-side transcription (POST with empty JSON body to avoid 411). */
export async function queueTranscription(visitId) {
  return visitsAPI.runTranscription(visitId)
}
