import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { consentAPI, isLikelyNetworkFailure } from '../services/api'

/**
 * Patient recording consent gate before audio capture.
 * Clinician must confirm the patient authorized recording before the mic starts.
 * Portaled to document.body so stacking context / overflow never hides the dialog.
 */
export default function PatientConsentModal({ visit, onConfirmed, onCancel }) {
  const [checked, setChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef(null)

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting, onCancel])

  const handleConfirm = async () => {
    if (!checked || submitting || !visit?.id) { return }
    setSubmitting(true)
    setError('')
    try {
      await consentAPI.recordRecording(visit.id)
      onConfirmed?.(visit)
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        setError('Cannot reach the server. Please check your connection and try again.')
      } else {
        setError(err?.message || 'Could not record patient consent. Please try again.')
      }
      setSubmitting(false)
    }
  }

  const patientLabel = visit?.patient_name || 'this patient'

  const modal = (
    <div className="portal-modal-overlay" role="presentation" onClick={() => !submitting && onCancel?.()}>
      <div
        ref={dialogRef}
        className="portal-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="patient-consent-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="portal-modal__close"
          aria-label="Close consent dialog"
          disabled={submitting}
          onClick={() => onCancel?.()}
        >
          ×
        </button>
        <div style={S.header}>
          <div style={S.badge} aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </div>
          <div>
            <h2 id="patient-consent-title" style={S.title}>Patient recording consent</h2>
            <p style={S.subtitle}>
              Confirm authorization before starting audio for {patientLabel}.
            </p>
          </div>
        </div>

        <p style={S.body}>
          Before recording this encounter, confirm that the patient has been informed that
          audio will be captured for clinical documentation and has agreed to be recorded.
        </p>

        {error ? (
          <p style={S.error} role="alert">{error}</p>
        ) : null}

        <label style={S.checkboxRow}>
          <input
            type="checkbox"
            className="portal-modal__checkbox"
            checked={checked}
            onChange={(e) => {
              setChecked(e.target.checked)
              if (error) { setError('') }
            }}
            style={S.checkbox}
            disabled={submitting}
          />
          <span>Patient authorizes recording</span>
        </label>

        <div className="portal-modal__actions" style={S.actions}>
          <button
            type="button"
            className="portal-modal__btn portal-modal__btn--ghost"
            onClick={() => onCancel?.()}
            disabled={submitting}
            style={S.cancelButton}
          >
            Cancel
          </button>
          <button
            type="button"
            className="portal-modal__btn portal-modal__btn--primary"
            onClick={handleConfirm}
            disabled={!checked || submitting}
            style={{
              ...S.confirmButton,
              ...(!checked || submitting ? S.confirmButtonDisabled : {}),
            }}
          >
            {submitting ? 'Saving…' : 'Start recording'}
          </button>
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') { return modal }
  return createPortal(modal, document.body)
}

const S = {
  header: { display: 'flex', gap: 14, marginBottom: 16 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 10,
    background: '#ecfdf5',
    color: '#059669',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  title: { margin: 0, fontSize: 20, fontWeight: 600, color: '#0f172a' },
  subtitle: { margin: '4px 0 0', fontSize: 14, color: '#64748b' },
  body: { margin: '0 0 16px', fontSize: 14, lineHeight: 1.55, color: '#334155' },
  error: { color: '#dc2626', fontSize: 13, margin: '0 0 12px' },
  checkboxRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    fontSize: 14,
    fontWeight: 500,
    color: '#1e293b',
    cursor: 'pointer',
    marginBottom: 20,
  },
  checkbox: { marginTop: 2, width: 16, height: 16, flexShrink: 0 },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelButton: {
    padding: '11px 16px',
    fontSize: 14,
    fontWeight: 600,
    color: '#475569',
    background: '#f1f5f9',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  confirmButton: {
    padding: '11px 18px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: 'linear-gradient(135deg,#16A34A,#15803D)',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  confirmButtonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
}
