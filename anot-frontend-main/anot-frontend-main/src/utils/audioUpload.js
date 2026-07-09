/** Client-side max before upload (backend limit is 500 MB). */
export const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024

/** Soft duration threshold — UI warns at 30 min; backend supports up to ~60 min within 500 MB. */
export const LONG_RECORDING_WARN_SECONDS = 30 * 60

export const UPLOAD_MAX_RETRIES = 3
export const UPLOAD_RETRY_DELAY_MS = 2000

/**
 * Strip codec parameters (e.g. `audio/webm;codecs=opus` → `audio/webm`).
 * Browsers send the full MediaRecorder MIME in multipart uploads; the API
 * allow-list only accepts base types.
 */
export function normalizeAudioMime(type) {
  if (!type || typeof type !== 'string') { return 'audio/webm' }
  const base = type.split(';')[0].trim().toLowerCase()
  const allowed = new Set([
    'audio/webm',
    'audio/ogg',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/x-m4a',
    'audio/flac',
    'audio/opus',
  ])
  return allowed.has(base) ? base : 'audio/webm'
}

export function extensionForMime(mime) {
  if (mime.includes('mp4') || mime.includes('m4a')) { return 'mp4' }
  if (mime.includes('ogg') || mime.includes('opus')) { return 'ogg' }
  if (mime.includes('mpeg') || mime.includes('mp3')) { return 'mp3' }
  if (mime.includes('wav')) { return 'wav' }
  return 'webm'
}

/** Re-wrap blob so FormData sends a base MIME type the API accepts. */
export function normalizeAudioBlob(blob) {
  if (!blob?.size) { return blob }
  const mime = normalizeAudioMime(blob.type)
  if (blob.type === mime) { return blob }
  return new Blob([blob], { type: mime })
}

export function validateAudioBlobSize(blob, maxBytes = MAX_AUDIO_UPLOAD_BYTES) {
  if (!blob?.size) {
    return { ok: false, error: 'Recording is empty. Try recording again.' }
  }
  if (blob.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024))
    return { ok: false, error: `Audio file too large (>${mb} MB). Try a shorter recording.` }
  }
  return { ok: true }
}

export function formatUploadError(err) {
  const status = err?.status
  const serverMsg = err?.payload?.error

  if (status === 413) {
    return serverMsg || 'Upload failed: file is too large. Try a shorter recording.'
  }
  if (status === 400) {
    return serverMsg ? `Upload failed: ${serverMsg}` : 'Upload failed: invalid audio format.'
  }
  if (status === 403) {
    return serverMsg || 'Upload failed: patient consent is required before uploading audio.'
  }
  if (status === 404) {
    return serverMsg || 'Upload failed: visit not found. Refresh the schedule and try again.'
  }
  if (status === 429) {
    return 'Upload failed: too many requests. Retrying…'
  }
  if (status >= 500) {
    return serverMsg || 'Upload failed: server error. Retrying…'
  }
  if (err?.message && !['Invalid request', 'Something went wrong'].includes(err.message)) {
    return err.message
  }
  return 'Upload failed. Check your connection and try again.'
}

/**
 * Retry transient upload failures (5xx, network, 429).
 * Does not retry 400/403/404.
 */
export async function uploadWithRetry(uploadFn, {
  maxRetries = UPLOAD_MAX_RETRIES,
  delayMs = UPLOAD_RETRY_DELAY_MS,
  onRetry,
} = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await uploadFn()
    } catch (err) {
      lastErr = err
      const noRetry = err?.status === 400 || err?.status === 403 || err?.status === 404
      if (noRetry || attempt >= maxRetries) { break }
      onRetry?.(attempt, err)
      await new Promise((r) => setTimeout(r, delayMs * attempt))
    }
  }
  throw lastErr
}
