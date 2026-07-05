/**
 * Transcription status polling for long-running Deepgram jobs (30+ minute audio).
 * Polls GET /api/notes/visit/:visitId which includes transcription_status.
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

/** Fetch transcription note for a visit (GET — no body, no Content-Length issues). */
export async function getTranscription(visitId, signal) {
  const data = await notesAPI.getByVisit(visitId, signal)
  return data?.note ?? data
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
      const note = await withTimeout(
        (signal) => getTranscription(visitId, signal),
        POLL_REQUEST_TIMEOUT_MS,
      )
      const status = note?.transcription_status || 'unknown'
      onProgress?.({ status, note })

      if (status === 'completed') {
        return { status: 'completed', note }
      }
      if (status === 'failed') {
        throw new Error('Transcription failed')
      }

      await sleep(pollInterval)
    } catch (error) {
      if (isAbortError(error)) {
        // Per-request timeout — retry on next loop iteration
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
