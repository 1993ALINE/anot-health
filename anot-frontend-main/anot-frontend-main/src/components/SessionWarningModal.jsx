import { createPortal } from 'react-dom'

function formatClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function SessionWarningModal({ remaining, expiresAt, onStayLoggedIn }) {
  return createPortal(
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 9998,
        }}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-timeout-title"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'white',
          borderRadius: 12,
          padding: 32,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          zIndex: 9999,
          textAlign: 'center',
          maxWidth: 400,
          width: 'calc(100% - 32px)',
        }}
      >
        <div style={{ fontSize: 48, lineHeight: 1, color: '#F59E0B', marginBottom: 12 }} aria-hidden>⚠️</div>
        <h2
          id="session-timeout-title"
          style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: '#111827' }}
        >
          Session Expiring Soon
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: '#4B5563' }}>
          Your session will expire in 2 minutes due to inactivity. Click to stay logged in.
        </p>
        <div
          style={{
            fontSize: 34,
            fontWeight: 700,
            color: remaining <= 30000 ? '#DC2626' : '#111827',
            fontVariantNumeric: 'tabular-nums',
            marginBottom: 4,
          }}
        >
          {formatCountdown(remaining)}
        </div>
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 24 }}>
          {expiresAt ? `Session expires at ${formatClock(expiresAt)}` : ''}
        </div>
        <button
          type="button"
          onClick={onStayLoggedIn}
          style={{
            width: '100%',
            background: '#4F46E5',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: 12,
            fontWeight: 600,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          Stay Logged In
        </button>
      </div>
    </>,
    document.body,
  )
}
