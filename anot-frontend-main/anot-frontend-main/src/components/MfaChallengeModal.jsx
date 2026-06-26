import { useEffect, useRef, useState } from 'react'
import { authAPI, isLikelyNetworkFailure } from '../services/api'

/**
 * MFA verification gate at login.
 * Shown when the server responds with `requireMfa: true` after password (and
 * optional PHI training) verification. Mandatory — no dismiss without TOTP.
 */
export default function MfaChallengeModal({ temporaryToken, onVerified }) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    inputRef.current?.focus()
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (submitting || !/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const data = await authAPI.verifyMfaLogin(temporaryToken, code.trim())
      onVerified?.(data.user)
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        setError('Cannot reach the server. Please check your connection and try again.')
      } else if (err?.status === 401) {
        setError('Invalid code. Check your authenticator app and try again.')
        setCode('')
      } else {
        setError(err?.message || 'Verification failed. Please try again.')
      }
      setSubmitting(false)
    }
  }

  return (
    <div style={S.overlay} role="presentation">
      <div
        ref={dialogRef}
        style={S.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mfa-title"
        tabIndex={-1}
      >
        <div style={S.header}>
          <div style={S.badge} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div>
            <h2 id="mfa-title" style={S.title}>Two-factor authentication</h2>
            <p style={S.subtitle}>Enter the 6-digit code from your authenticator app.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="mfa-code" style={S.label}>Authenticator code</label>
          <input
            ref={inputRef}
            id="mfa-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              if (error) { setError('') }
            }}
            style={S.input}
            disabled={submitting}
            aria-invalid={!!error}
          />

          {error ? (
            <p style={S.error} role="alert">{error}</p>
          ) : null}

          <button type="submit" style={S.button} disabled={submitting || code.length !== 6}>
            {submitting ? 'Verifying…' : 'Verify and continue'}
          </button>
        </form>
      </div>
    </div>
  )
}

const S = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
    padding: 16,
  },
  dialog: {
    background: '#fff',
    borderRadius: 12,
    maxWidth: 420,
    width: '100%',
    padding: '28px 24px',
    boxShadow: '0 24px 48px rgba(0,0,0,0.18)',
    outline: 'none',
  },
  header: { display: 'flex', gap: 14, marginBottom: 20 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: '#eef2ff',
    color: '#4338ca',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  title: { margin: 0, fontSize: 20, fontWeight: 600, color: '#0f172a' },
  subtitle: { margin: '4px 0 0', fontSize: 14, color: '#64748b' },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#334155', marginBottom: 8 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 24,
    letterSpacing: '0.35em',
    textAlign: 'center',
    padding: '12px 16px',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    fontFamily: 'ui-monospace, monospace',
  },
  error: { color: '#dc2626', fontSize: 13, margin: '12px 0 0' },
  button: {
    width: '100%',
    marginTop: 20,
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    background: '#4338ca',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
}
