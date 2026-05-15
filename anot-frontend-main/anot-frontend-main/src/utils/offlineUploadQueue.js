const STORAGE_KEY = 'anot_pending_audio_uploads'

function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve(base64)
    }
    reader.onerror = () => reject(new Error('Failed to read recording'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType || 'audio/webm' })
}

/** Queue a failed visit audio upload for retry when back online. */
export async function queueAudioUpload({ visitId, blob, mode = 'primary' }) {
  if (!visitId || !blob?.size) return
  const base64 = await blobToBase64(blob)
  const queue = readQueue()
  queue.push({
    id: `${visitId}-${mode}-${Date.now()}`,
    visitId,
    mode,
    mimeType: blob.type || 'audio/webm',
    base64,
    createdAt: new Date().toISOString(),
  })
  writeQueue(queue)
}

let flushing = false

/** Retry queued uploads (call after successful upload attempt or on `online`). */
export async function flushPendingAudioUploads({ uploadPrimary, uploadAppend, onSuccess, onError }) {
  if (flushing || !navigator.onLine) return { flushed: 0, remaining: readQueue().length }
  flushing = true
  let flushed = 0
  try {
    let queue = readQueue()
    const keep = []
    for (const item of queue) {
      try {
        const blob = base64ToBlob(item.base64, item.mimeType)
        if (item.mode === 'append') {
          await uploadAppend(item.visitId, blob)
        } else {
          await uploadPrimary(item.visitId, blob)
        }
        flushed += 1
        onSuccess?.(item)
      } catch (err) {
        keep.push(item)
        onError?.(item, err)
      }
    }
    writeQueue(keep)
    return { flushed, remaining: keep.length }
  } finally {
    flushing = false
  }
}

export function pendingUploadCount() {
  return readQueue().length
}

export function installOfflineUploadFlush(flushFn) {
  const run = () => {
    flushFn().catch(() => {})
  }
  window.addEventListener('online', run)
  run()
  return () => window.removeEventListener('online', run)
}
