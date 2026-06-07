// Pending audio uploads are kept in memory ONLY. Audio recordings are PHI and
// must never be persisted to localStorage (or any other on-disk browser store),
// where they would survive logout and be readable by anything on the device.
// The trade-off: a queued upload does not survive a full page reload.
const queue = []

/** Queue a failed visit audio upload for retry when back online. */
export async function queueAudioUpload({ visitId, blob, mode = 'primary' }) {
  if (!visitId || !blob?.size) return
  queue.push({
    id: `${visitId}-${mode}-${Date.now()}`,
    visitId,
    mode,
    blob,
    createdAt: new Date().toISOString(),
  })
}

let flushing = false

/** Retry queued uploads (call after successful upload attempt or on `online`). */
export async function flushPendingAudioUploads({ uploadPrimary, uploadAppend, onSuccess, onError }) {
  if (flushing || !navigator.onLine) return { flushed: 0, remaining: queue.length }
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
  window.addEventListener('online', run)
  run()
  return () => window.removeEventListener('online', run)
}
