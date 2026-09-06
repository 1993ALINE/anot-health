import { useEffect, useMemo, useRef, useState } from 'react'
import { authAPI, isLikelyNetworkFailure } from '../services/api'
import {
  PASSWORD_POLICY_TEXT,
  getPasswordChecks,
  getPasswordStrength,
  validatePassword,
} from '../utils/passwordPolicy'

/**
 * Forced password-change gate.
 *
 * Shown after a successful login when the server responds with
 * `requirePasswordChange: true` (seeded accounts, admin temp-password resets).
 * Like the PHI gate, this modal is mandatory — there is no close button, no
 * backdrop dismissal, and Escape is suppressed. On success we POST the new
 * password using the short-lived temporaryToken; the endpoint returns no
 * session, so the parent re-authenticates with the new password to continue
 * (which may then surface the PHI training gate).
 */
export default function PasswordChangeModal({ temporaryToken, onPasswordChanged, onCancel }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)

  const checks = useMemo(() => getPasswordChecks(newPassword), [newPassword])
  const strength = useMemo(() => getPasswordStrength(newPassword), [newPassword])
  const policy = useMemo(() => validatePassword(newPassword), [newPassword])
  const matches = newPassword.length > 0 && newPassword === confirm
  const canSubmit = policy.valid && matches && !submitting

  // Lock background scroll and suppress Escape while this mandatory gate is open.
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

  const handleSubmit = async (e) => {
    e?.preventDefault?.()
    if (submitting) {return}
    if (!policy.valid) {
      setError(policy.message || PASSWORD_POLICY_TEXT)
      return
    }
    if (!matches) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await authAPI.changePasswordWithToken(temporaryToken, newPassword)
      // The endpoint returns no session — hand the new password back so the
      // parent can re-authenticate and resolve any remaining gates.
      onPasswordChanged?.(newPassword)
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        setError('Cannot reach the server. Please check your connection and try again.')
      } else if (err?.status === 401) {
        setError('Your session expired. Please close this and sign in again.')
      } else {
        setError(err?.message || 'Could not change your password. Please try again.')
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
        aria-labelledby="password-change-title"
        tabIndex={-1}
      >
        <div style={S.header}>
          <div style={S.badge} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div>
            <h2 id="password-change-title" style={S.title}>Set a new password</h2>
            <p style={S.subtitle}>For your security, you must change your password before continuing.</p>
          </div>
        </div>

        <form style={S.body} onSubmit={handleSubmit}>
          <label style={S.label} htmlFor="pcm-new">New password</label>
          <div style={S.inputWrap}>
            <input
              id="pcm-new"
              type={showPass ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value)
                if (error) {setError('')}
              }}
              style={S.input}
              autoComplete="new-password"
              autoFocus
              disabled={submitting}
            />
            <button
              type="button"
              onClick={() => setShowPass((p) => !p)}
              style={S.toggle}
              aria-label={showPass ? 'Hide password' : 'Show password'}
            >
              {showPass ? 'Hide' : 'Show'}
            </button>
          </div>

          {/* Strength meter */}
          <div style={S.meterTrack} aria-hidden>
            <div style={{ ...S.meterFill, width: `${strength.percent}%`, background: strength.color }} />
          </div>
          <div style={{ ...S.meterLabel, color: strength.color }}>{strength.label}</div>

          <label style={S.label} htmlFor="pcm-confirm">Confirm new password</label>
          <input
            id="pcm-confirm"
            type={showPass ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              if (error) {setError('')}
            }}
            style={S.input}
            autoComplete="new-password"
            disabled={submitting}
          />
          {confirm.length > 0 && !matches ? (
            <div style={S.mismatch}>Passwords do not match.</div>
          ) : null}

          {/* Requirement checklist */}
          <ul style={S.checklist}>
            <Requirement ok={checks.length}>At least 12 characters</Requirement>
            <Requirement ok={checks.uppercase}>One uppercase letter</Requirement>
            <Requirement ok={checks.lowercase}>One lowercase letter</Requirement>
            <Requirement ok={checks.number}>One number</Requirement>
            <Requirement ok={checks.special}>One special character</Requirement>
          </ul>

          {error ? (
            <div style={{ margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={S.error} role="alert">{error}</div>
              <button
                type="button"
                onClick={() => (onCancel ? onCancel() : window.location.reload())}
                style={S.secondaryButton}
              >
                Sign in again
              </button>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{ ...S.button, ...(!canSubmit ? S.buttonDisabled : {}) }}
          >
            {submitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Requirement({ ok, children }) {
  return (
    <li style={{ ...S.reqItem, color: ok ? '#16a34a' : '#64748b' }}>
      <span aria-hidden style={S.reqMark}>{ok ? '✓' : '○'}</span>
      <span>{children}</span>
    </li>
  )
}

const S = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.62)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
    zIndex: 1000,
  },
  dialog: {
    width: 'min(460px, 100%)',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 24px 60px rgba(15, 23, 42, 0.35)',
    padding: '28px',
    outline: 'none',
    color: '#0f172a',
  },
  header: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '18px' },
  badge: {
    flex: '0 0 auto',
    width: '44px',
    height: '44px',
    borderRadius: '12px',
    background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { margin: 0, fontSize: '1.25rem', fontWeight: 700 },
  subtitle: { margin: '2px 0 0', fontSize: '0.85rem', color: '#64748b' },
  body: { overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  label: { fontSize: '0.85rem', fontWeight: 600, color: '#1e293b', margin: '6px 0 6px' },
  inputWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '11px 12px',
    borderRadius: '10px',
    border: '1px solid #cbd5e1',
    fontSize: '0.95rem',
    color: '#0f172a',
    outline: 'none',
  },
  toggle: {
    position: 'absolute',
    right: '8px',
    background: 'transparent',
    border: 'none',
    color: '#2563eb',
    fontWeight: 600,
    fontSize: '0.8rem',
    cursor: 'pointer',
    padding: '4px 6px',
  },
  meterTrack: {
    height: '6px',
    borderRadius: '999px',
    background: '#e2e8f0',
    overflow: 'hidden',
    marginTop: '8px',
  },
  meterFill: { height: '100%', borderRadius: '999px', transition: 'width 0.2s ease, background 0.2s ease' },
  meterLabel: { fontSize: '0.78rem', fontWeight: 600, marginTop: '4px' },
  mismatch: { color: '#b91c1c', fontSize: '0.8rem', marginTop: '4px' },
  checklist: { listStyle: 'none', padding: 0, margin: '14px 0 4px', display: 'grid', gap: '4px' },
  reqItem: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '0.82rem' },
  reqMark: { width: '14px', display: 'inline-block', textAlign: 'center', fontWeight: 700 },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    borderRadius: '10px',
    padding: '10px 12px',
    fontSize: '0.85rem',
    margin: '12px 0 0',
  },
  button: {
    width: '100%',
    marginTop: '16px',
    padding: '13px 18px',
    borderRadius: '12px',
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    color: '#ffffff',
    fontSize: '0.98rem',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'opacity 0.15s ease',
  },
  buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  secondaryButton: {
    width: '100%',
    padding: '11px 16px',
    borderRadius: '12px',
    border: '1px solid #cbd5e1',
    background: '#f8fafc',
    color: '#334155',
    fontSize: '0.92rem',
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'background 0.15s ease',
  },
}
