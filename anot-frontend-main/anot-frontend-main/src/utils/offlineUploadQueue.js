// Pending audio uploads are kept in memory ONLY. Audio recordings are PHI and
// must never be persisted to localStorage (or any other on-disk browser store),
// where they would survive logout and be readable by anything on the device.
// The trade-off: a queued upload does not survive a full page reload — which is
// why installOfflineUploadFlush also warns on beforeunload while items remain.
const queue = []

// Retry cadence while items are pending. Upload failures are usually NOT
// offline events (server 500, proxy timeout), so waiting for the `online`
// event alone would leave items stuck in memory forever.
const RETRY_INTERVAL_MS = 45 * 1000

/**
 * Queue a failed visit audio upload for retry.
 * `durationSeconds` (primary mode) lets the flush handler finish the
 * end-visit call once the audio finally lands.
 */
export async function queueAudioUpload({ visitId, blob, mode = 'primary', durationSeconds = null }) {
  if (!visitId || !blob?.size) {return}
  queue.push({
    id: `${visitId}-${mode}-${Date.now()}`,
    visitId,
    mode,
    blob,
    durationSeconds,
    createdAt: new Date().toISOString(),
  })
}

let flushing = false

/** Retry queued uploads (called periodically, on `online`, and on mount). */
export async function flushPendingAudioUploads({ uploadPrimary, uploadAppend, onSuccess, onError }) {
  if (flushing || !navigator.onLine) {return { flushed: 0, remaining: queue.length }}
  flushing = true
  let flushed = 0
  try {
    const pending = queue.splice(0, queue.length)
    const keep = []
    for (const item of pending) {
      try {
        if (item.mode === 'append') {
          await uploadAppend(item.visitId, item.blob)
        } else {
          await uploadPrimary(item.visitId, item.blob)
        }
        flushed += 1
        onSuccess?.(item)
      } catch (err) {
        keep.push(item)
        onError?.(item, err)
      }
    }
    queue.push(...keep)
    return { flushed, remaining: keep.length }
  } finally {
    flushing = false
  }
}

export function pendingUploadCount() {
  return queue.length
}

export function installOfflineUploadFlush(flushFn) {
  const run = () => {
    flushFn().catch(() => {})
  }
  // The queue is memory-only (PHI must not hit disk), so a reload silently
  // destroys any pending recording — make the browser ask first.
  const warnBeforeUnload = (e) => {
    if (queue.length > 0) {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  window.addEventListener('online', run)
  window.addEventListener('beforeunload', warnBeforeUnload)
  const intervalId = setInterval(() => {
    if (queue.length > 0) {run()}
  }, RETRY_INTERVAL_MS)
  run()
  return () => {
    window.removeEventListener('online', run)
    window.removeEventListener('beforeunload', warnBeforeUnload)
    clearInterval(intervalId)
  }
}
