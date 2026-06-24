import { useCallback, useEffect, useRef, useState } from 'react'
import { adminAPI } from '../../services/api'
import './systemHealth.css'

const REFRESH_INTERVAL_MS = 30 * 1000

const COMPONENT_META = [
  { key: 'database', label: 'Database' },
  { key: 'deepgram', label: 'Deepgram' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 's3', label: 'S3' },
]

const STATUS_LABEL = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
}

function fmtTimestamp(iso) {
  if (!iso) {return '—'}
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '—'
  }
}

function fmtNumber(n) {
  if (n === null || n === undefined) {return '—'}
  return Number(n).toLocaleString('en-US')
}

function ComponentCard({ label, data }) {
  const ok = data?.status === 'ok'
  return (
    <div className={`sysh-comp-card sysh-comp-card--${ok ? 'ok' : 'error'}`}>
      <div className="sysh-comp-head">
        <span className="sysh-comp-name">{label}</span>
        <span className="sysh-comp-icon" aria-hidden>{ok ? '✅' : '⚠️'}</span>
      </div>
      <span className={`sysh-pill sysh-pill--${ok ? 'ok' : 'error'}`}>
        {ok ? 'Operational' : 'Error'}
      </span>
      <div className="sysh-comp-latency">
        <b>{data?.latency_ms !== null && data?.latency_ms !== undefined ? data.latency_ms : '—'}</b>
        <span>ms latency</span>
      </div>
      <div className="sysh-comp-msg">{data?.message || '—'}</div>
      <div className="sysh-comp-foot">Last tested {data?.lastTest || '—'}</div>
    </div>
  )
}

function MetricCard({ label, value, alert }) {
  return (
    <div className="sysh-metric-card">
      <span className={`sysh-metric-value${alert ? ' sysh-metric-value--alert' : ''}`}>
        {fmtNumber(value)}
      </span>
      <span className="sysh-metric-label">{label}</span>
    </div>
  )
}

export default function SystemHealth({ showToast }) {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastFetched, setLastFetched] = useState(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const fetchHealth = useCallback(async (manual = false) => {
    if (inFlight.current) {return}
    inFlight.current = true
    if (mounted.current) {
      setLoading(true)
      if (manual) {setError(null)}
    }
    try {
      const data = await adminAPI.getSystemHealth()
      if (!mounted.current) {return}
      setHealth(data)
      setError(null)
      setLastFetched(Date.now())
    } catch (err) {
      if (!mounted.current) {return}
      setError(err.message || 'Failed to load system health')
      if (manual && typeof showToast === 'function') {
        showToast(`Failed to refresh system health: ${err.message}`, 'error')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {setLoading(false)}
    }
  }, [showToast])

  useEffect(() => {
    fetchHealth(false)
    const id = setInterval(() => fetchHealth(false), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchHealth])

  const status = health?.status || 'healthy'
  const statusLabel = STATUS_LABEL[status] || 'Unknown'

  return (
    <div className="sysh-root">
      <div className="sysh-bar">
        <div className="sysh-bar__meta">
          {loading && <span className="sysh-spinner sysh-spinner--dark" aria-hidden />}
          <span>
            {lastFetched
              ? `Updated ${fmtTimestamp(new Date(lastFetched).toISOString())} · auto-refreshes every 30s`
              : 'Loading system health…'}
          </span>
        </div>
        <button
          type="button"
          className="sysh-refresh-btn"
          onClick={() => fetchHealth(true)}
          disabled={loading}
        >
          {loading ? <span className="sysh-spinner" aria-hidden /> : null}
          {loading ? 'Loading…' : 'Refresh Now'}
        </button>
      </div>

      {error && !health && (
        <div className="sysh-error">⚠ {error}</div>
      )}

      {!health && !error && (
        <>
          <div className="sysh-skeleton" style={{ height: 128 }} />
          <div className="sysh-grid">
            {COMPONENT_META.map((c) => (
              <div key={c.key} className="sysh-skeleton" style={{ height: 150 }} />
            ))}
          </div>
        </>
      )}

      {health && (
        <>
          <div className={`sysh-status-card sysh-status-card--${status}`}>
            <div className={`sysh-orb sysh-orb--${status}`} aria-hidden />
            <div className="sysh-status-text">
              <span className="sysh-status-label">{statusLabel}</span>
              <span className="sysh-status-sub">
                Last updated {fmtTimestamp(health.lastUpdated)}
              </span>
            </div>
          </div>

          <section>
            <h3 className="sysh-section-title">Components</h3>
            <div className="sysh-grid">
              {COMPONENT_META.map((c) => (
                <ComponentCard key={c.key} label={c.label} data={health.components?.[c.key]} />
              ))}
            </div>
          </section>

          <section>
            <h3 className="sysh-section-title">Metrics</h3>
            <div className="sysh-metrics">
              <MetricCard label="Total Users" value={health.metrics?.totalUsers} />
              <MetricCard label="Active Sessions" value={health.metrics?.activeSessions} />
              <MetricCard
                label="Errors (24h)"
                value={health.metrics?.errorsLast24h}
                alert={Number(health.metrics?.errorsLast24h) > 0}
              />
              <MetricCard label="API Calls (24h)" value={health.metrics?.apiCallsLast24h} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
