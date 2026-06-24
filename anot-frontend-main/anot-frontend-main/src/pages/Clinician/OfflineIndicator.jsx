import { useCallback, useEffect, useState } from 'react'
import { getQueueStatus } from '../../utils/offlineSyncManager'
import AudioQueuePanel from './AudioQueuePanel'

export default function OfflineIndicator({ showToast }) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [counts, setCounts] = useState({ pending: 0, failed: 0, total: 0 })
  const [panelOpen, setPanelOpen] = useState(false)

  const refreshCounts = useCallback(async () => {
    try {
      const status = await getQueueStatus()
      setCounts({
        pending: status.pending + status.uploading,
        failed: status.failed,
        total: status.total,
      })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    refreshCounts()

    const onStatus = (e) => {
      if (typeof e.detail?.online === 'boolean') {setOnline(e.detail.online)}
    }
    const onQueue = () => refreshCounts()
    const onSyncStart = () => setSyncing(true)
    const onSyncEnd = () => {
      setSyncing(false)
      refreshCounts()
    }
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)

    window.addEventListener('offline-status-changed', onStatus)
    window.addEventListener('offline-queue-changed', onQueue)
    window.addEventListener('offline-sync-started', onSyncStart)
    window.addEventListener('offline-sync-finished', onSyncEnd)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      window.removeEventListener('offline-status-changed', onStatus)
      window.removeEventListener('offline-queue-changed', onQueue)
      window.removeEventListener('offline-sync-started', onSyncStart)
      window.removeEventListener('offline-sync-finished', onSyncEnd)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [refreshCounts])

  const pendingLabel = counts.pending === 1 ? '1 recording pending' : `${counts.pending} recordings pending`

  let label = 'Connected'
  if (syncing) {label = 'Syncing…'}
  else if (!online) {label = counts.pending > 0 ? `Offline (${pendingLabel})` : 'Offline'}
  else if (counts.pending > 0) {label = `Sync pending (${counts.pending})`}

  return (
    <>
      <button
        type="button"
        className={`cl-offline-indicator${online ? ' cl-offline-indicator--online' : ' cl-offline-indicator--offline'}${syncing ? ' cl-offline-indicator--syncing' : ''}`}
        onClick={() => setPanelOpen((open) => !open)}
        title={panelOpen ? 'Hide upload queue' : 'Show upload queue'}
        aria-live="polite"
      >
        <span className="cl-offline-indicator__dot" aria-hidden />
        <span className="cl-offline-indicator__text">{label}</span>
      </button>

      {panelOpen ? (
        <AudioQueuePanel
          onClose={() => setPanelOpen(false)}
          showToast={showToast}
          onQueueChange={refreshCounts}
        />
      ) : null}
    </>
  )
}
