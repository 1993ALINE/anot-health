import { useEffect, useRef, useState } from 'react'
import { authAPI, isLikelyNetworkFailure, mfaAPI } from '../services/api'

/**
 * Mandatory MFA enrollment gate at login for PHI-access roles.
 * User chooses email or SMS, receives a 6-digit code, and confirms to enroll.
 */
export default function MfaEnrollmentModal({ temporaryToken, onEnrolled }) {
  const [step, setStep] = useState('choose')
  const [method, setMethod] = useState('email')
  const [destination, setDestination] = useState('')
  const [destinationMasked, setDestinationMasked] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const inputRef = useRef(null)

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

  const handleSendCode = async (e) => {
    e?.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const data = await mfaAPI.setupWithToken(temporaryToken, method, destination.trim())
      setDestinationMasked(data.destinationMasked || '')
      setStep('confirm')
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        setError('Cannot reach the server. Please check your connection and try again.')
      } else {
        setError(err?.message || 'Could not send verification code.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleResend = async () => {
    setResending(true)
    setError('')
    try {
      const data = await mfaAPI.sendCodeWithToken(temporaryToken)
      setDestinationMasked(data.destinationMasked || destinationMasked)
    } catch (err) {
      setError(err?.message || 'Could not resend code.')
    } finally {
      setResending(false)
    }
  }

  const handleConfirm = async (e) => {
    e.preventDefault()
    if (submitting || !/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit verification code.')
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
        setError('Invalid code. Check your email or phone and try again.')
        setCode('')
      } else {
        setError(err?.message || 'Verification failed. Please try again.')
      }
      setSubmitting(false)
    }
  }

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
              MFA is required for PHI access. Choose email or SMS — we&apos;ll send a 6-digit code each time you sign in.
            </p>
          </div>
        </div>

        {step === 'choose' ? (
          <form onSubmit={handleSendCode}>
            <fieldset style={S.fieldset}>
              <legend style={S.legend}>Delivery method</legend>
              <label style={S.radioLabel}>
                <input
                  type="radio"
                  name="mfa-method"
                  value="email"
                  checked={method === 'email'}
                  onChange={() => setMethod('email')}
                />
                Email
              </label>
              <label style={S.radioLabel}>
                <input
                  type="radio"
                  name="mfa-method"
                  value="sms"
                  checked={method === 'sms'}
                  onChange={() => setMethod('sms')}
                />
                SMS text message
              </label>
            </fieldset>

            <label htmlFor="mfa-enroll-dest" style={S.label}>
              {method === 'email' ? 'Email address' : 'Mobile phone number'}
            </label>
            <input
              id="mfa-enroll-dest"
              className="portal-modal__input"
              type={method === 'email' ? 'email' : 'tel'}
              autoComplete={method === 'email' ? 'email' : 'tel'}
              placeholder={method === 'email' ? 'you@healthsystem.org' : '+1 555 123 4567'}
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value)
                if (error) { setError('') }
              }}
              style={S.destInput}
              disabled={submitting}
            />

            {error ? (
              <p className="portal-modal__error" style={S.error} role="alert">{error}</p>
            ) : null}

            <button
              type="submit"
              className="portal-modal__btn portal-modal__btn--indigo"
              style={S.button}
              disabled={submitting || !destination.trim()}
            >
              {submitting ? 'Sending code…' : 'Send verification code'}
            </button>
          </form>
        ) : null}

        {step === 'confirm' ? (
          <form onSubmit={handleConfirm}>
            <p style={S.hint}>
              Enter the 6-digit code sent to{' '}
              <strong>{destinationMasked || (method === 'email' ? 'your email' : 'your phone')}</strong>.
            </p>
            <label htmlFor="mfa-enroll-code" style={S.label}>Verification code</label>
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
              type="button"
              className="portal-modal__btn portal-modal__btn--ghost"
              style={S.resendBtn}
              onClick={handleResend}
              disabled={resending || submitting}
            >
              {resending ? 'Sending…' : 'Resend code'}
            </button>
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
  fieldset: { border: 'none', padding: 0, margin: '0 0 16px' },
  legend: { fontSize: 13, fontWeight: 500, color: '#334155', marginBottom: 8 },
  radioLabel: { display: 'block', fontSize: 14, color: '#475569', marginBottom: 8, cursor: 'pointer' },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#334155', marginBottom: 8 },
  destInput: {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 15,
    padding: '12px 16px',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
  },
  hint: { fontSize: 13, color: '#475569', margin: '0 0 16px', lineHeight: 1.5 },
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
  resendBtn: {
    width: '100%',
    marginTop: 12,
    padding: '10px 16px',
    fontSize: 14,
    fontWeight: 500,
    color: '#4338ca',
    background: 'transparent',
    border: '1px solid #c7d2fe',
    borderRadius: 8,
    cursor: 'pointer',
  },
  button: {
    width: '100%',
    marginTop: 12,
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
