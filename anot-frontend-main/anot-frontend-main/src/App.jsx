import { useEffect, useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login/index'
import { authAPI } from './services/api'
import { hasValidSession, getStoredUserRaw } from './utils/sessionAuth'
import { getCurrentUser } from './utils/getCurrentUser'

// Code-split each portal so the initial load only ships the login + shell.
// Each portal is a large bundle (recorder, charts, editors) only needed once
// the user reaches that role's dashboard.
const Clinician = lazy(() => import('./pages/Clinician/index'))
const Scribe = lazy(() => import('./pages/Scribe/index'))
const QPS = lazy(() => import('./pages/QPS/index'))
const Admin = lazy(() => import('./pages/Admin/index'))

function PortalLoading() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
      Loading…
    </div>
  )
}
import { dashboardPathForRole, roleMatchesPortal } from './auth/dashboardPaths'
import { applyBrandingToDocument, getCachedBranding, refreshBranding } from './services/branding'
import { SplashGate } from './splash/SplashGate'
import { useReleaseSplash } from './splash/useReleaseSplash'
import {
  startOnlineListener,
  stopOnlineListener,
  uploadQueuedAudio,
} from './utils/offlineSyncManager'

/** `/` → dashboard if already signed in, otherwise login. */
function RootHome() {
  const releaseSplash = useReleaseSplash()
  const hasSession = hasValidSession() && !!getStoredUserRaw()
  const [target, setTarget] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!hasSession) {
      releaseSplash()
      return
    }
    let cancelled = false
    authAPI
      .getMe()
      .then(() => {
        if (cancelled) { return }
        const user = authAPI.getCurrentUser()
        const path = dashboardPathForRole(user?.role)
        if (path) {
          setTarget(path)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (cancelled) { return }
        authAPI.logout()
        setFailed(true)
      })
      .finally(() => {
        if (!cancelled) { releaseSplash() }
      })
    return () => {
      cancelled = true
    }
  }, [hasSession, releaseSplash])

  if (!hasSession || failed) { return <Navigate to="/login" replace /> }
  if (!target) { return null }
  return <Navigate to={target} replace />
}

// ─── PROTECTED ROUTE ─────────────────────────────────────────────────────────
// Verifies the JWT with the server, then ensures this URL matches the user’s role.
// Boot splash (#anot-splash) stays until verified !== null — no second full-screen loader.

function ProtectedRoute({ element, allowedRole }) {
  const releaseSplash = useReleaseSplash()
  const hasSession = hasValidSession() && !!getStoredUserRaw()
  const [verified, setVerified] = useState(() => (hasSession ? null : false))

  useEffect(() => {
    if (!hasSession) {return}
    let cancelled = false
    authAPI
      .getMe()
      .then(() => {
        if (!cancelled) {setVerified(true)}
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[App] Session verification failed:', err?.message || 'unknown')
          authAPI.logout()
          setVerified(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hasSession])

  useEffect(() => {
    if (verified !== null) {releaseSplash()}
  }, [verified, releaseSplash])

  if (!hasSession || verified === false) {
    return <Navigate to="/login" replace />
  }

  if (verified !== true) {
    return null
  }

  const parsedUser = getCurrentUser()
  if (!parsedUser?.role) {
    authAPI.logout()
    return <Navigate to="/login" replace />
  }

  if (!roleMatchesPortal(parsedUser.role, allowedRole)) {
    const path = dashboardPathForRole(parsedUser.role)
    if (!path) {
      authAPI.logout()
      return <Navigate to="/login" replace />
    }
    return <Navigate to={path} replace />
  }

  return element
}

// ─── APP ─────────────────────────────────────────────────────────────────────

function App() {
  useEffect(() => {
    applyBrandingToDocument(getCachedBranding())
    refreshBranding().catch(() => {})
  }, [])

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch((err) => {
        console.warn('[App] Service worker registration failed:', err?.message || 'unknown')
      })
    }

    startOnlineListener(async () => {
      await uploadQueuedAudio()
    })

    return () => stopOnlineListener()
  }, [])

  return (
    <BrowserRouter>
      <SplashGate>
        <Suspense fallback={<PortalLoading />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<RootHome />} />

            <Route
              path="/clinician"
              element={<ProtectedRoute element={<Clinician />} allowedRole="clinician" />}
            />
            <Route
              path="/scribe"
              element={<ProtectedRoute element={<Scribe />} allowedRole="scribe" />}
            />
            <Route
              path="/qps"
              element={<ProtectedRoute element={<QPS />} allowedRole="qps" />}
            />
            <Route
              path="/admin"
              element={<ProtectedRoute element={<Admin />} allowedRole="admin" />}
            />

            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Suspense>
      </SplashGate>
    </BrowserRouter>
  )
}

export default App
