import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login/index'
import Clinician from './pages/Clinician/index'
import Scribe from './pages/Scribe/index'
import QPS from './pages/QPS/index'
import Admin from './pages/Admin/index'
import { authAPI } from './services/api'
import { dashboardPathForRole, roleMatchesPortal } from './auth/dashboardPaths'
import { applyBrandingToDocument, getCachedBranding, refreshBranding } from './services/branding'
import { SplashGate, useReleaseSplash } from './splash/SplashGate'

/** `/` → dashboard if already signed in, otherwise login. */
function RootHome() {
  const token = localStorage.getItem('token')
  const raw = localStorage.getItem('user')
  if (!token || !raw) return <Navigate to="/login" replace />
  const path = (() => {
    try {
      return dashboardPathForRole(JSON.parse(raw).role)
    } catch {
      return null
    }
  })()
  if (!path) return <Navigate to="/login" replace />
  return <Navigate to={path} replace />
}

// ─── PROTECTED ROUTE ─────────────────────────────────────────────────────────
// Verifies the JWT with the server, then ensures this URL matches the user’s role.
// Boot splash (#anot-splash) stays until verified !== null — no second full-screen loader.

function ProtectedRoute({ element, allowedRole }) {
  const releaseSplash = useReleaseSplash()
  const hasSession = !!localStorage.getItem('token') && !!localStorage.getItem('user')
  const [verified, setVerified] = useState(() => (hasSession ? null : false))

  useEffect(() => {
    if (!hasSession) return
    let cancelled = false
    authAPI
      .getMe()
      .then(() => {
        if (!cancelled) setVerified(true)
      })
      .catch(() => {
        if (!cancelled) {
          authAPI.logout()
          setVerified(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hasSession])

  useEffect(() => {
    if (verified !== null) releaseSplash()
  }, [verified, releaseSplash])

  if (!hasSession || verified === false) {
    return <Navigate to="/login" replace />
  }

  if (verified !== true) {
    return null
  }

  let parsedUser
  try {
    parsedUser = JSON.parse(localStorage.getItem('user') || '{}')
  } catch {
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

  return (
    <BrowserRouter>
      <SplashGate>
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
      </SplashGate>
    </BrowserRouter>
  )
}

export default App
