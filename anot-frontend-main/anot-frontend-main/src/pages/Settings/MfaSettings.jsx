import { useCallback, useEffect, useState } from 'react'
import { isLikelyNetworkFailure, mfaAPI } from '../../services/api'

export default function MfaSettings({ showToast }) {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(null)
  const [method, setMethod] = useState('email')
  const [destination, setDestination] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('idle')
  const [submitting, setSubmitting] = useState(false)

  const loadStatus = useCallback(async ({ showSpinner = false } = {}) => {
    if (showSpinner) {
      setLoading(true)
    }
    try {
      const data = await mfaAPI.getStatus()
      setStatus(data)
      if (data.mfaMethod) {
        setMethod(data.mfaMethod)
      }
    } catch (err) {
      showToast?.(err?.message || 'Could not load MFA settings.', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await mfaAPI.getStatus()
        if (cancelled) {
          return
        }
        setStatus(data)
        if (data.mfaMethod) {
          setMethod(data.mfaMethod)
        }
      } catch (err) {
        if (!cancelled) {
          showToast?.(err?.message || 'Could not load MFA settings.', 'error')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showToast])

  const handleSetup = async (e) => {
    e.preventDefault()
    if (!destination.trim()) {
      showToast?.('Enter an email address or phone number.', 'error')
      return
    }
    setSubmitting(true)
    try {
      const data = await mfaAPI.setup(method, destination.trim())
      setStep('verify')
      setCode('')
      showToast?.(`Code sent to ${data.destinationMasked || 'your device'}.`)
    } catch (err) {
      showToast?.(err?.message || 'Could not start MFA setup.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerify = async (e) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code.trim())) {
      showToast?.('Enter the 6-digit verification code.', 'error')
      return
    }
    setSubmitting(true)
    try {
      await mfaAPI.verifyCode(code.trim())
      setStep('idle')
      setCode('')
      setDestination('')
      await loadStatus({ showSpinner: true })
      showToast?.('Two-factor authentication enabled.')
    } catch (err) {
      if (isLikelyNetworkFailure(err)) {
        showToast?.('Cannot reach the server.', 'error')
      } else {
        showToast?.(err?.message || 'Verification failed.', 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleResend = async () => {
    setSubmitting(true)
    try {
      const data = await mfaAPI.sendCode('settings')
      showToast?.(`Code resent to ${data.destinationMasked || 'your device'}.`)
    } catch (err) {
      showToast?.(err?.message || 'Could not resend code.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDisable = async () => {
    if (!status?.canDisable) {
      showToast?.('MFA cannot be disabled for accounts with PHI access.', 'error')
      return
    }
    setSubmitting(true)
    try {
      if (step !== 'disable') {
        await mfaAPI.disable()
        setStep('disable')
        showToast?.('Enter the code we sent to confirm disabling MFA.')
        return
      }
      if (!/^\d{6}$/.test(code.trim())) {
        showToast?.('Enter the 6-digit verification code.', 'error')
        return
      }
      await mfaAPI.disable(code.trim())
      setStep('idle')
      setCode('')
      await loadStatus({ showSpinner: true })
      showToast?.('Two-factor authentication disabled.')
    } catch (err) {
      showToast?.(err?.message || 'Could not disable MFA.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="pm-loading">Loading MFA settings…</div>
  }

  return (
    <div className="pm-card pm-card--nested">
      <header className="pm-header pm-header--compact">
        <div className="pm-header-body">
          <p className="pm-eyebrow">Security</p>
          <h3 className="pm-title">Two-factor authentication</h3>
          <p className="pm-subtitle">
            Receive a 6-digit code by email or SMS each time you sign in. No authenticator app required.
          </p>
        </div>
      </header>

      {status?.mfaEnabled ? (
        <div className="pm-mfa-status">
          <p>
            <strong>Status:</strong> Enabled via {status.mfaMethod === 'sms' ? 'SMS' : 'email'}
            {status.mfaDestinationMasked ? ` (${status.mfaDestinationMasked})` : ''}
          </p>
          {status.canDisable ? (
            step === 'disable' ? (
              <form onSubmit={(e) => { e.preventDefault(); void handleDisable() }} className="pm-mfa-form">
                <label className="pm-label" htmlFor="mfa-disable-code">Confirmation code</label>
                <input
                  id="mfa-disable-code"
                  className="pm-input"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <div className="pm-actions pm-actions--inline">
                  <button type="button" className="pm-btn pm-btn--ghost" onClick={handleResend} disabled={submitting}>
                    Resend code
                  </button>
                  <button type="submit" className="pm-btn pm-btn--danger" disabled={submitting || code.length !== 6}>
                    Confirm disable
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => void handleDisable()} disabled={submitting}>
                Disable MFA
              </button>
            )
          ) : (
            <p className="pm-hint">Required for your role — MFA cannot be disabled.</p>
          )}
        </div>
      ) : (
        <div className="pm-mfa-setup">
          {step === 'verify' ? (
            <form onSubmit={handleVerify} className="pm-mfa-form">
              <p className="pm-hint">Enter the 6-digit code we sent to confirm setup.</p>
              <label className="pm-label" htmlFor="mfa-setup-code">Verification code</label>
              <input
                id="mfa-setup-code"
                className="pm-input pm-input--code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <div className="pm-actions pm-actions--inline">
                <button type="button" className="pm-btn pm-btn--ghost" onClick={handleResend} disabled={submitting}>
                  Resend code
                </button>
                <button type="submit" className="pm-btn" disabled={submitting || code.length !== 6}>
                  Enable MFA
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSetup} className="pm-mfa-form">
              <fieldset className="pm-fieldset">
                <legend className="pm-label">Delivery method</legend>
                <label className="pm-radio">
                  <input type="radio" name="mfa-settings-method" value="email" checked={method === 'email'} onChange={() => setMethod('email')} />
                  Email
                </label>
                <label className="pm-radio">
                  <input type="radio" name="mfa-settings-method" value="sms" checked={method === 'sms'} onChange={() => setMethod('sms')} />
                  SMS
                </label>
              </fieldset>
              <label className="pm-label" htmlFor="mfa-settings-dest">
                {method === 'email' ? 'Email address' : 'Phone number'}
              </label>
              <input
                id="mfa-settings-dest"
                className="pm-input"
                type={method === 'email' ? 'email' : 'tel'}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder={method === 'email' ? 'you@healthsystem.org' : '+1 555 123 4567'}
              />
              <div className="pm-actions">
                <button type="submit" className="pm-btn" disabled={submitting || !destination.trim()}>
                  {submitting ? 'Sending…' : 'Send verification code'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
