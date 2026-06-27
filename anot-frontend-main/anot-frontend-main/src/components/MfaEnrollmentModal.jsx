import { useEffect, useRef, useState } from 'react'
import { isLikelyNetworkFailure, mfaAPI } from '../services/api'

/**
 * Mandatory MFA enrollment gate at login for PHI-access roles.
 * Cannot be dismissed — user must scan QR / enter secret and confirm TOTP.
 */
export default function MfaEnrollmentModal({ temporaryToken, onEnrolled }) {
  const [step, setStep] = useState('loading')
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    mfaAPI
      .setupWithToken(temporaryToken)
      .then((data) => {
        if (cancelled) {
          return
        }
        setSetup(data)
        setStep('scan')
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        setError(err?.message || 'Could not start MFA setup. Please sign in again.')
        setStep('error')
      })
    return () => {
      cancelled = true
    }
  }, [temporaryToken])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
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

  useEffect(() => {
    if (step === 'confirm') {
      inputRef.current?.focus()
    }
  }, [step])

  const handleConfirm = async (e) => {
    e.preventDefault()
    if (submitting || !/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const data = await mfaAPI.verifyWithToken(temporaryToken, code.trim())
      onEnrolled?.(data.user)
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

  const qrSrc = setup?.qrCode || null

  return (
    <div className="portal-modal-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="portal-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mfa-enroll-title"
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
            <h2 id="mfa-enroll-title" style={S.title}>Set up two-factor authentication</h2>
            <p style={S.subtitle}>
              MFA is required for PHI access. Scan the QR code with your authenticator app, then enter a code to confirm.
            </p>
          </div>
        </div>

        {step === 'loading' ? (
          <p style={S.loading}>Preparing your authenticator setup…</p>
        ) : null}

        {step === 'error' ? (
          <p style={S.error} role="alert">{error}</p>
        ) : null}

        {step === 'scan' && setup ? (
          <>
            {qrSrc ? (
              <div className="portal-modal__qr" style={S.qrWrap}>
                <img src={qrSrc} alt="QR code for authenticator app" width={200} height={200} style={S.qr} />
              </div>
            ) : (
              <p className="portal-modal__error" style={S.error} role="alert">QR code unavailable — use the manual key below.</p>
            )}
            <p style={S.hint}>
              Can&apos;t scan? Enter this key manually:{' '}
              <code className="portal-modal__secret" style={S.secret}>{setup.secret}</code>
            </p>
            {setup.recoveryCodes?.length ? (
              <div style={S.recovery}>
                <p style={S.recoveryTitle}>Save these recovery codes in a secure place:</p>
                <ul style={S.recoveryList}>
                  {setup.recoveryCodes.map((c) => (
                    <li key={c} style={S.recoveryCode}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button
              type="button"
              className="portal-modal__btn portal-modal__btn--indigo"
              style={S.button}
              onClick={() => {
                setStep('confirm')
                setError('')
              }}
            >
              I&apos;ve added the account — continue
            </button>
          </>
        ) : null}

        {step === 'confirm' ? (
          <form onSubmit={handleConfirm}>
            <label htmlFor="mfa-enroll-code" style={S.label}>Confirm with a 6-digit code</label>
            <input
              ref={inputRef}
              id="mfa-enroll-code"
              className="portal-modal__input"
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
              <p className="portal-modal__error" style={S.error} role="alert">{error}</p>
            ) : null}
            <button
              type="submit"
              className="portal-modal__btn portal-modal__btn--indigo"
              style={S.button}
              disabled={submitting || code.length !== 6}
            >
              {submitting ? 'Verifying…' : 'Complete setup and sign in'}
            </button>
          </form>
        ) : null}
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
    maxWidth: 440,
    width: '100%',
    padding: '28px 24px',
    boxShadow: '0 24px 48px rgba(0,0,0,0.18)',
    outline: 'none',
    maxHeight: '90vh',
    overflowY: 'auto',
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
  subtitle: { margin: '4px 0 0', fontSize: 14, color: '#64748b', lineHeight: 1.45 },
  loading: { fontSize: 14, color: '#64748b', margin: '8px 0 0' },
  qrWrap: { display: 'flex', justifyContent: 'center', margin: '16px 0' },
  qr: { border: '1px solid #e2e8f0', borderRadius: 8 },
  hint: { fontSize: 13, color: '#475569', margin: '12px 0', lineHeight: 1.5 },
  secret: {
    display: 'inline-block',
    marginTop: 4,
    padding: '4px 8px',
    background: '#f1f5f9',
    borderRadius: 4,
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12,
    wordBreak: 'break-all',
  },
  recovery: {
    margin: '16px 0',
    padding: 12,
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 8,
  },
  recoveryTitle: { margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#92400e' },
  recoveryList: { margin: 0, padding: '0 0 0 20px' },
  recoveryCode: { fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#78350f' },
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
