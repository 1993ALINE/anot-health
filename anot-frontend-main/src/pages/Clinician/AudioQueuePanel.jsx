import { useCallback, useEffect, useState } from 'react'
import * as offlineAudioQueue from '../../utils/offlineAudioQueue'
import { getQueueStatus, retryFailedUploads } from '../../utils/offlineSyncManager'

function formatTime(ts) {
  if (!ts) {return '—'}
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

function statusLabel(status) {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'uploading':
      return 'Uploading'
    case 'uploaded':
      return 'Uploaded'
    case 'failed':
      return 'Failed'
    default:
      return status || 'Unknown'
  }
}

export default function AudioQueuePanel({ onClose, showToast, onQueueChange }) {
  const [queue, setQueue] = useState([])
  const [retrying, setRetrying] = useState(false)

  const loadQueue = useCallback(async () => {
    const status = await getQueueStatus()
    setQueue(status.queue || [])
    onQueueChange?.()
  }, [onQueueChange])

  useEffect(() => {
    loadQueue()
    const onChange = () => loadQueue()
    window.addEventListener('offline-queue-changed', onChange)
    return () => window.removeEventListener('offline-queue-changed', onChange)
  }, [loadQueue])

  const handleDelete = async (id) => {
    try {
      await offlineAudioQueue.removeFromQueue(id)
      showToast?.('Recording removed from queue')
      await loadQueue()
    } catch {
      showToast?.('Could not remove recording', 'error')
    }
  }

  const handleRetryAll = async () => {
    setRetrying(true)
    try {
      const result = await retryFailedUploads()
      if (result.failed > 0) {
        showToast?.('Some uploads still failed — try again later', 'error')
      } else if (result.uploaded > 0) {
        showToast?.('Queued recordings uploaded')
      } else {
        showToast?.('No failed uploads to retry')
      }
      await loadQueue()
    } catch {
      showToast?.('Retry failed', 'error')
    } finally {
      setRetrying(false)
    }
  }

  const failedCount = queue.filter((item) => item.status === 'failed').length

  return (
    <div className="cl-audio-queue-panel" role="dialog" aria-label="Offline audio queue">
      <div className="cl-audio-queue-panel__header">
        <strong>Offline recordings</strong>
        <button type="button" className="cl-audio-queue-panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {failedCount > 0 ? (
        <div className="cl-audio-queue-panel__actions">
          <button type="button" className="btn btn-sm" disabled={retrying} onClick={handleRetryAll}>
            {retrying ? 'Retrying…' : `Retry failed (${failedCount})`}
          </button>
        </div>
      ) : null}

      {queue.length === 0 ? (
        <p className="cl-audio-queue-panel__empty">No recordings waiting to upload.</p>
      ) : (
        <ul className="cl-audio-queue-panel__list">
          {queue.map((item) => (
            <li key={item.id} className={`cl-audio-queue-panel__item cl-audio-queue-panel__item--${item.status}`}>
              <div className="cl-audio-queue-panel__meta">
                <span className="cl-audio-queue-panel__name">
                  {item.patientName || item.metadata?.patientName || `Visit #${item.visitId}`}
                </span>
                <span className="cl-audio-queue-panel__time">{formatTime(item.timestamp)}</span>
              </div>
              <div className="cl-audio-queue-panel__row">
                <span className={`cl-audio-queue-panel__status cl-audio-queue-panel__status--${item.status}`}>
                  {statusLabel(item.status)}
                </span>
                <button
                  type="button"
                  className="btn btn-sm cl-audio-queue-panel__delete"
                  onClick={() => handleDelete(item.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
