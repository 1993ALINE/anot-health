import { useEffect, useRef, useState } from 'react'
import { authAPI, isLikelyNetworkFailure } from '../services/api'

/**
 * PHI Awareness Training acknowledgment gate.
 *
 * Shown after a successful login when the server responds with
 * `requirePhiTraining: true`. The user CANNOT dismiss this modal — there is no
 * close button, no backdrop-click, and Escape is suppressed — they must read the
 * training and check the box to enable the "I Acknowledge" button. On
 * acknowledgment we exchange the short-lived temporaryToken for a real session
 * token and hand the resulting user back to the parent via `onAcknowledged`.
 *
 * Content mirrors PHI_TRAINING_ACKNOWLEDGMENT.md.
 */
export default function PhiTrainingModal({ temporaryToken, onAcknowledged }) {
  const [checked, setChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)

  // Lock background scroll and trap focus inside the dialog while it is open.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKeyDown = (e) => {
      // Suppress Escape — this gate is mandatory.
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

  const handleAcknowledge = async () => {
    if (!checked || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const data = await authAPI.acknowledgePhiTraining(temporaryToken)
      onAcknowledged?.(data.user)
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        setError('Cannot reach the server. Please check your connection and try again.')
      } else if (err?.status === 401) {
        setError('Your session expired. Please close this and sign in again.')
      } else {
        setError(err?.message || 'Could not record your acknowledgment. Please try again.')
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
        aria-labelledby="phi-training-title"
        tabIndex={-1}
      >
        <div style={S.header}>
          <div style={S.badge} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <h2 id="phi-training-title" style={S.title}>PHI Awareness Training</h2>
            <p style={S.subtitle}>Please review before your first access. This is required.</p>
          </div>
        </div>

        <div style={S.body}>
          <section style={S.section}>
            <h3 style={S.h3}>What is PHI?</h3>
            <p style={S.p}>
              <strong>PHI</strong> means <strong>Protected Health Information</strong> — any
              information that can identify a patient <em>and</em> relates to their health, care, or
              treatment. On Anot Health this includes <strong>patient encounter audio</strong>,
              <strong> transcripts and AI-generated clinical notes</strong>, and{' '}
              <strong>patient names and details tied to a visit</strong>.
            </p>
          </section>

          <section style={S.section}>
            <h3 style={S.h3}>How Anot Health Protects PHI</h3>
            <ul style={S.ul}>
              <li><strong>Encryption</strong> — audio is stored with AES-256 encryption; the database is encrypted at rest; everything travels over secure (TLS) connections.</li>
              <li><strong>Audit logging</strong> — the system records who did what and when. Logs are append-only (they can&apos;t be quietly edited or deleted) and kept for 7 years.</li>
              <li><strong>Access control</strong> — people get only the access their role needs (admin, super_admin, clinician, scribe).</li>
              <li><strong>Automatic cleanup</strong> — encounter audio is deleted after 90 days.</li>
              <li><strong>Trusted partners</strong> — our transcription and AI partners operate under signed Business Associate Agreements (BAAs).</li>
            </ul>
          </section>

          <section style={S.section}>
            <h3 style={S.h3}>Your Responsibilities</h3>
            <ul style={S.ul}>
              <li>Access only the patient information your job requires (the &quot;minimum necessary&quot; rule).</li>
              <li>Keep your login private — never share your password or let someone use your account.</li>
              <li>Use strong, unique passwords and log out of shared devices.</li>
              <li>Never copy PHI to personal devices, email, or unapproved tools.</li>
              <li>Lock your screen when you step away.</li>
            </ul>
          </section>

          <section style={S.section}>
            <h3 style={S.h3}>If You Suspect a Breach</h3>
            <p style={S.p}>
              A breach is any time PHI may have been seen, taken, or changed by someone who
              shouldn&apos;t have access. <strong>Act fast and don&apos;t investigate alone:</strong> report
              it immediately to <a href="mailto:support@anot.health" style={S.link}>support@anot.health</a>{' '}
              (and <a href="mailto:admin@anot.health" style={S.link}>admin@anot.health</a> for anything
              urgent). Don&apos;t try to fix it quietly, write down what you saw, and preserve evidence.
              Reporting in good faith is always the right call.
            </p>
          </section>
        </div>

        {error ? (
          <div style={S.error} role="alert">{error}</div>
        ) : null}

        <label style={S.checkboxRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={S.checkbox}
            disabled={submitting}
          />
          <span>I acknowledge that I have read and understand Anot Health&apos;s privacy practices</span>
        </label>

        <button
          type="button"
          onClick={handleAcknowledge}
          disabled={!checked || submitting}
          style={{
            ...S.button,
            ...(!checked || submitting ? S.buttonDisabled : {}),
          }}
        >
          {submitting ? 'Recording…' : 'I Acknowledge'}
        </button>
      </div>
    </div>
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
    width: 'min(640px, 100%)',
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
  header: {
    display: 'flex',
    gap: '14px',
    alignItems: 'center',
    marginBottom: '18px',
  },
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
  body: {
    overflowY: 'auto',
    paddingRight: '6px',
    margin: '0 -4px 4px',
    paddingLeft: '4px',
  },
  section: { marginBottom: '16px' },
  h3: { margin: '0 0 6px', fontSize: '0.95rem', fontWeight: 700, color: '#1e293b' },
  p: { margin: 0, fontSize: '0.9rem', lineHeight: 1.55, color: '#334155' },
  ul: { margin: '0', paddingLeft: '18px', fontSize: '0.9rem', lineHeight: 1.55, color: '#334155' },
  link: { color: '#2563eb', fontWeight: 600, textDecoration: 'none' },
  error: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#b91c1c',
    borderRadius: '10px',
    padding: '10px 12px',
    fontSize: '0.85rem',
    marginBottom: '12px',
  },
  checkboxRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-start',
    fontSize: '0.9rem',
    color: '#1e293b',
    padding: '14px 0',
    borderTop: '1px solid #e2e8f0',
    cursor: 'pointer',
    lineHeight: 1.4,
  },
  checkbox: { marginTop: '2px', width: '18px', height: '18px', flex: '0 0 auto', cursor: 'pointer' },
  button: {
    width: '100%',
    padding: '13px 18px',
    borderRadius: '12px',
    border: 'none',
    background: 'linear-gradient(135deg, #0ea5e9, #2563eb)',
    color: '#ffffff',
    fontSize: '0.98rem',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'opacity 0.15s ease, transform 0.05s ease',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
