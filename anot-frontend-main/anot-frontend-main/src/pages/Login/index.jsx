import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './login.css'
import { API_BASE, authAPI, isLikelyNetworkFailure } from '../../services/api'
import { fetchCsrfToken } from '../../utils/csrf'
import { dashboardPathForRole } from '../../auth/dashboardPaths'
import { DEFAULT_BRAND_LOGO_SRC, useBranding } from '../../services/branding'
import { useReleaseSplash } from '../../splash/useReleaseSplash'
import { hasValidSession } from '../../utils/sessionAuth'
import PhiTrainingModal from '../../components/PhiTrainingModal'
import PasswordChangeModal from '../../components/PasswordChangeModal'
import MfaChallengeModal from '../../components/MfaChallengeModal'

function networkErrorMessage() {
  const isLocalApi = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1')
  if (isLocalApi) {
    return 'Cannot reach the API. Start the backend (port 5000), e.g. from the backend folder: npm run dev. On Windows, the app calls http://127.0.0.1:5000 — ensure nothing else blocks that.'
  }
  return 'Service temporarily unavailable. Please refresh the page in a few seconds.'
}

function humanizeAuthError(err) {
  if (isLikelyNetworkFailure(err)) {return networkErrorMessage()}
  const msg = err?.message || ''
  return msg || 'Sign-in failed.'
}

/**
 * Distinctive “badge portrait” toggle: hex frame + bust, diamond eyes to peek,
 * curved privacy visor when concealing (not a generic user glyph).
 */
function PasswordVisibilityIcon({ passwordVisible }) {
  const svg = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    className: 'login-page__pass-avatar',
  }
  const sw = 1.45
  const hex = (
    <path
      d="M12 3.2 18.4 6.95V17.05L12 20.8 5.6 17.05V6.95L12 3.2z"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinejoin="round"
      opacity={0.38}
    />
  )
  const head = <ellipse cx="12" cy="9.35" rx="3.35" ry="3.55" stroke="currentColor" strokeWidth={sw} />
  const shoulders = (
    <path
      d="M5.35 18.9c2.05-3.25 4.45-4.85 6.65-4.85s4.6 1.6 6.65 4.85"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
    />
  )
  if (passwordVisible) {
    return (
      <svg {...svg}>
        {hex}
        {head}
        {shoulders}
        <path
          d="M6.85 8.05c1.45-.85 3.35-1.3 5.15-1.3s3.7.45 5.15 1.3l1 1.95c-1.55.95-3.55 1.45-6.15 1.45s-4.6-.5-6.15-1.45l1-1.95z"
          fill="currentColor"
          opacity={0.9}
        />
        <path d="M12 5.15v1.05" stroke="currentColor" strokeWidth={1.05} strokeLinecap="round" opacity={0.5} />
      </svg>
    )
  }
  return (
    <svg {...svg}>
      {hex}
      {head}
      {shoulders}
      <path d="M9.85 8.5 10.55 9.2 9.85 9.9 9.15 9.2 9.85 8.5z" fill="currentColor" />
      <path d="M14.15 8.5 14.85 9.2 14.15 9.9 13.45 9.2 14.15 8.5z" fill="currentColor" />
      <path
        d="M10.4 11.55c.48.4 1 .62 1.6.62s1.12-.22 1.6-.62"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
      />
      <path d="M16.6 5.35 17.35 6.1 16.6 6.85 15.85 6.1 16.6 5.35z" fill="currentColor" opacity={0.55} />
    </svg>
  )
}

function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function IconPulse() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

function IconUsers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function IconMail() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  )
}

function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

const HERO_PRODUCT = 'Clinical documentation platform'
const HERO_HEADLINE = 'Documentation that keeps pace with care.'

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function TypewriterLine({ text, className, reducedMotion }) {
  const [len, setLen] = useState(0)
  const shown = reducedMotion ? text.length : len
  const done = shown >= text.length

  useEffect(() => {
    if (reducedMotion) {return}
    let cancelled = false
    let tid = null

    const step = (i) => {
      if (cancelled) {return}
      setLen(i)
      if (i >= text.length) {return}
      const delay = 26 + Math.floor(Math.random() * 20)
      tid = window.setTimeout(() => step(i + 1), delay)
    }

    tid = window.setTimeout(() => step(1), 380)
    return () => {
      cancelled = true
      if (tid) {window.clearTimeout(tid)}
    }
  }, [text, reducedMotion])

  return (
    <p className={className} aria-label={text}>
      <span className="login-page__type-text">{text.slice(0, shown)}</span>
      {!done ? <span className="login-page__type-caret" aria-hidden /> : null}
    </p>
  )
}

function AnimatedHeadline({ text, reduced }) {
  const words = text.split(' ')
  if (reduced) {
    return <h1 className="login-page__headline">{text}</h1>
  }
  return (
    <h1 className="login-page__headline login-page__headline--motion" aria-label={text}>
      {words.map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          {i > 0 ? '\u00A0' : null}
          <span className="login-page__headline-word" style={{ animationDelay: `${820 + i * 88}ms` }}>
            {word}
          </span>
        </Fragment>
      ))}
    </h1>
  )
}

export default function Login() {
  const navigate = useNavigate()
  const branding = useBranding()
  const releaseSplash = useReleaseSplash()
  const [phase, setPhase] = useState(() => (hasValidSession() ? 'session' : 'form'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [phiTrainingToken, setPhiTrainingToken] = useState(null)
  const [passwordChangeToken, setPasswordChangeToken] = useState(null)
  const [mfaToken, setMfaToken] = useState(null)
  const [csrfTokenFetched, setCsrfTokenFetched] = useState(false)
  const csrfReady = phase === 'form' && csrfTokenFetched
  const reducedMotion = usePrefersReducedMotion()

  const goToDashboard = (user) => {
    const path = dashboardPathForRole(user?.role)
    if (!path) {
      authAPI.logout()
      setError('Your account does not have access to this application.')
      return
    }
    navigate(path, { replace: true })
  }

  useEffect(() => {
    if (phase !== 'session') {return}
    let cancelled = false
    authAPI
      .getMe()
      .then(() => {
        if (cancelled) {return}
        const u = authAPI.getCurrentUser()
        const path = dashboardPathForRole(u?.role)
        if (path) {
          navigate(path, { replace: true })
        } else {
          authAPI.logout()
          setPhase('form')
        }
      })
      .catch((err) => {
        if (cancelled) {return}
        authAPI.logout()
        if (isLikelyNetworkFailure(err)) {
          setError(networkErrorMessage())
        } else if (err?.status && err.status !== 401 && err.status !== 403) {
          setError('Could not verify your session. Please sign in again.')
        }
        setPhase('form')
      })
      .finally(() => {
        releaseSplash()
      })
    return () => {
      cancelled = true
    }
  }, [phase, navigate, releaseSplash])

  // Prefetch CSRF token on page load so the cookie is set before login POST.
  useEffect(() => {
    if (phase !== 'form') {
      return
    }
    let cancelled = false
    fetchCsrfToken(API_BASE)
      .then(() => {
        if (!cancelled) { setCsrfTokenFetched(true) }
      })
      .catch(() => {
        if (!cancelled) { setCsrfTokenFetched(true) }
      })
    return () => {
      cancelled = true
    }
  }, [phase])

  // Resolves a successful /auth/login response. The server returns at most one
  // pre-session gate (a temporaryToken instead of a real session): forced
  // password change first, then PHI training. Each is handled by a mandatory
  // modal; only an ungated response carries a real `user` + session token.
  const routeAfterAuth = (data) => {
    if (data.requirePasswordChange) {
      setPasswordChangeToken(data.temporaryToken)
      return
    }
    if (data.requirePhiTraining) {
      setPhiTrainingToken(data.temporaryToken)
      return
    }
    if (data.requireMfa) {
      setMfaToken(data.temporaryToken)
      return
    }
    goToDashboard(data.user)
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    if (!email || !password) {
      setError('Please enter your email and password.')
      return
    }
    setLoading(true)
    try {
      await fetchCsrfToken(API_BASE, { forceRefresh: true })
      const data = await authAPI.login(email.trim(), password)
      routeAfterAuth(data)
    } catch (err) {
      setError(humanizeAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  // After a forced password change there is no session yet (the change-password
  // endpoint returns only a message). Re-authenticate with the new password so
  // the backend can authoritatively resolve the next gate (e.g. PHI training)
  // or hand back a real session.
  const handlePasswordChanged = async (newPassword) => {
    setPasswordChangeToken(null)
    setError('')
    setLoading(true)
    try {
      await fetchCsrfToken(API_BASE, { forceRefresh: true })
      const data = await authAPI.login(email.trim(), newPassword)
      routeAfterAuth(data)
    } catch (err) {
      setError(humanizeAuthError(err))
    } finally {
      setLoading(false)
    }
  }

  if (phase === 'session') {
    return null
  }

  return (
    <div className="login-page">
        <div className="login-page__backdrop" aria-hidden>
        <div className="login-page__mesh" />
        <div className="login-page__pattern" />
        <div className="login-page__orb login-page__orb--a" />
        <div className="login-page__orb login-page__orb--b" />
        <div className="login-page__orb login-page__orb--c" />
      </div>

      <div className="login-page__shell">
        <div className="login-page__grid">
          <header className="login-page__hero">
            <div className="login-page__panel-inner">
              <TypewriterLine text={branding.system_description || HERO_PRODUCT} className="login-page__product login-page__product--hero" reducedMotion={reducedMotion} />

              <AnimatedHeadline text={HERO_HEADLINE} reduced={reducedMotion} />
              <p className="login-page__lede">
                A secure workspace for physicians, scribes, quality teams, and staff — intelligent notes, visit audio, and
                role-aware dashboards in one place.
              </p>

              <div className="login-page__chips">
                <span className="login-page__chip">
                  <IconShield />
                  HIPAA-minded access
                </span>
                <span className="login-page__chip">
                  <IconPulse />
                  Real-time workflows
                </span>
                <span className="login-page__chip">
                  <IconUsers />
                  Built for care teams
                </span>
              </div>

              <p className="login-page__hero-foot">© {new Date().getFullYear()} {branding.system_name || 'Anot'} · Clinical documentation</p>
            </div>
          </header>

          <div className="login-page__aside">
            <div className="login-page__card">
              <div className="login-page__panel-inner">
                <div className="login-page__card-head">
                  <img
                    src={branding.logo_data_url || DEFAULT_BRAND_LOGO_SRC}
                    alt={branding.system_name || 'Anot'}
                    className="login-page__card-logo"
                    width={360}
                    height={134}
                    decoding="async"
                  />
                  <h2 className="login-page__card-title">Welcome to {branding.system_name || 'Anot'}</h2>
                  <p className="login-page__card-sub">
                    Sign in with your work email. We&apos;ll route you to the right dashboard automatically — no role to pick here.
                  </p>
                </div>

                <p className="login-page__hint">
                  <strong className="login-page__hint-label">Tip:</strong> Accounts and roles are managed by your administrator.
                </p>

                <form onSubmit={handleLogin} noValidate aria-busy={loading}>
                  <div className="login-page__field">
                    <label className="login-page__label" htmlFor="login-email">
                      Work email
                    </label>
                    <div className="login-page__input-wrap">
                      <span className="login-page__input-icon">
                        <IconMail />
                      </span>
                      <input
                        id="login-email"
                        className="login-page__input"
                        type="email"
                        placeholder="you@healthsystem.org"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value)
                          if (error) {setError('')}
                        }}
                        autoComplete="email"
                      />
                    </div>
                  </div>

                  <div className="login-page__field">
                    <label className="login-page__label" htmlFor="login-password">
                      Password
                    </label>
                    <div className="login-page__input-wrap">
                      <input
                        id="login-password"
                        className="login-page__input login-page__input--has-toggle"
                        type={showPass ? 'text' : 'password'}
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value)
                          if (error) {setError('')}
                        }}
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        className="login-page__toggle-pass"
                        onClick={() => setShowPass((p) => !p)}
                        title={showPass ? 'Hide password' : 'Show password'}
                        aria-label={showPass ? 'Hide password' : 'Show password'}
                      >
                        <PasswordVisibilityIcon passwordVisible={showPass} />
                      </button>
                    </div>
                  </div>

                  {error ? (
                    <div className="login-page__error" role="alert">
                      <IconAlert />
                      <span>{error}</span>
                    </div>
                  ) : null}

                  <button type="submit" className="login-page__submit" disabled={loading || !csrfReady}>
                    {loading ? 'Signing in…' : `Sign in to ${branding.system_name || 'Anot'}`}
                  </button>
                </form>

                <p className="login-page__footer">
                  Need an account? <strong>{branding.support_contact || 'Contact your administrator'}</strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {passwordChangeToken ? (
        <PasswordChangeModal
          temporaryToken={passwordChangeToken}
          onPasswordChanged={handlePasswordChanged}
        />
      ) : null}

      {phiTrainingToken ? (
        <PhiTrainingModal
          temporaryToken={phiTrainingToken}
          onAcknowledged={(data) => {
            setPhiTrainingToken(null)
            routeAfterAuth(data)
          }}
        />
      ) : null}

      {mfaToken ? (
        <MfaChallengeModal
          temporaryToken={mfaToken}
          onVerified={(user) => {
            setMfaToken(null)
            goToDashboard(user)
          }}
        />
      ) : null}
    </div>
  )
}
