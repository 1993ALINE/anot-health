import * as offlineAudioQueue from './offlineAudioQueue'
import { visitsAPI } from '../services/api'

const MAX_RETRIES = 5
const BASE_BACKOFF_MS = 1000

let onlineListener = null
let swMessageListener = null
let syncing = false
let onUploadSuccess = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffMs(retryCount) {
  return BASE_BACKOFF_MS * 2 ** Math.max(0, retryCount - 1)
}

async function uploadQueueItem(item) {
  if (item.mode === 'append') {
    await visitsAPI.appendAudio(item.visitId, item.audioBlob)
    return
  }

  await visitsAPI.uploadAudio(item.visitId, item.audioBlob)
  if (item.durationSeconds != null) {
    await visitsAPI.endVisit(item.visitId, item.durationSeconds)
  }
}

export function setOfflineUploadSuccessHandler(handler) {
  onUploadSuccess = handler
}

export async function requestBackgroundSync() {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    if ('sync' in reg) {
      await reg.sync.register('sync-audio-queue')
    }
  } catch {
    /* Background Sync may be unavailable */
  }
}

export function startOnlineListener(onOnline) {
  const handleOnline = async () => {
    window.dispatchEvent(new CustomEvent('offline-status-changed', { detail: { online: true } }))
    try {
      await uploadQueuedAudio()
      onOnline?.()
    } catch (error) {
      console.error('[OfflineSync] Sync failed:', error?.message || 'unknown')
    }
  }

  const handleOffline = () => {
    window.dispatchEvent(new CustomEvent('offline-status-changed', { detail: { online: false } }))
  }

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  onlineListener = handleOnline

  if ('serviceWorker' in navigator) {
    swMessageListener = (event) => {
      if (event.data?.type === 'SYNC_QUEUE' && event.data?.action === 'uploadQueuedAudio') {
        uploadQueuedAudio().catch((err) => console.error('[OfflineSync] Background upload failed:', err?.message || 'unknown'))
      }
    }
    navigator.serviceWorker.addEventListener('message', swMessageListener)
  }

  offlineAudioQueue.initDB().catch(() => {})
}

export function stopOnlineListener() {
  if (onlineListener) {
    window.removeEventListener('online', onlineListener)
    onlineListener = null
  }
  if (swMessageListener && 'serviceWorker' in navigator) {
    navigator.serviceWorker.removeEventListener('message', swMessageListener)
    swMessageListener = null
  }
}

export async function uploadQueuedAudio() {
  if (!navigator.onLine || syncing) return { uploaded: 0, failed: 0 }

  syncing = true
  window.dispatchEvent(new CustomEvent('offline-sync-started'))

  let uploaded = 0
  let failed = 0

  try {
    const queue = await offlineAudioQueue.getQueue()
    const pending = queue
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.timestamp - b.timestamp)

    for (const item of pending) {
      const retryCount = item.retryCount || 0
      if (retryCount > 0) {
        await sleep(backoffMs(retryCount))
      }

      try {
        await offlineAudioQueue.updateQueueItemStatus(item.id, 'uploading')
        await uploadQueueItem(item)
        await offlineAudioQueue.removeFromQueue(item.id)
        uploaded += 1
        onUploadSuccess?.(item)
      } catch (error) {
        console.error('[OfflineSync] Queued audio upload failed:', error?.message || 'unknown')
        const nextRetry = retryCount + 1
        if (nextRetry < MAX_RETRIES) {
          await offlineAudioQueue.updateQueueItem(item.id, {
            status: 'pending',
            retryCount: nextRetry,
          })
        } else {
          await offlineAudioQueue.updateQueueItem(item.id, {
            status: 'failed',
            retryCount: nextRetry,
          })
          failed += 1
        }
      }
    }
  } finally {
    syncing = false
    window.dispatchEvent(new CustomEvent('offline-sync-finished'))
    window.dispatchEvent(new CustomEvent('offline-queue-changed'))
  }

  return { uploaded, failed }
}

export async function retryFailedUploads() {
  const queue = await offlineAudioQueue.getQueue()
  const failed = queue.filter((item) => item.status === 'failed')

  for (const item of failed) {
    await offlineAudioQueue.updateQueueItem(item.id, {
      status: 'pending',
      retryCount: 0,
    })
  }

  return uploadQueuedAudio()
}

export async function getQueueStatus() {
  const queue = await offlineAudioQueue.getQueue()
  return {
    total: queue.length,
    pending: queue.filter((i) => i.status === 'pending').length,
    uploading: queue.filter((i) => i.status === 'uploading').length,
    uploaded: queue.filter((i) => i.status === 'uploaded').length,
    failed: queue.filter((i) => i.status === 'failed').length,
    queue,
  }
}
