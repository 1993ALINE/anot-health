import { useEffect, useRef, useState, useCallback, createElement } from 'react'
import { createPortal } from 'react-dom'
import { authAPI } from '../services/api'

/**
 * HIPAA-compliant idle session timeout.
 *
 * Warns the user after 13 minutes of inactivity and automatically logs them
 * out after a further 2 minutes (15 minutes total). Any tracked user activity
 * resets the timer and dismisses the warning. While the warning is shown the
 * modal displays a live countdown and the exact expiry time, and the user can
 * click "Stay Logged In" to extend the session.
 *
 * @param {boolean} enabled - Only run while a user is logged in.
 * @param {{ isBusy?: () => boolean }} [options] - `isBusy` is consulted when the
 *   warning or logout would fire; returning true counts as activity and resets
 *   the timer. Used so an in-progress encounter recording (which generates no
 *   mouse/keyboard events) is never destroyed by an idle logout.
 * @returns {React.ReactNode} The warning modal (portaled to <body>) or null.
 */

const TOTAL_MS = 15 * 60 * 1000 // 15 minutes total inactivity → logout
const WARNING_MS = 2 * 60 * 1000 // warning shows 2 minutes before logout
const IDLE_BEFORE_WARNING_MS = TOTAL_MS - WARNING_MS // 13 minutes

// Toggle verbose debugging while testing the idle timer.
const DEBUG = false

const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click']

async function handleLogout() {
  try {
    if (authAPI && typeof authAPI.logout === 'function') {
      await authAPI.logout()
    }
  } catch {
    /* ignore — still clear local session and redirect */
  }
  try {
    // Remove only the session keys. localStorage.clear() would also wipe
    // user customizations that survive an explicit logout (note templates,
    // branding cache), making idle logout destructive in a way normal
    // logout is not.
    localStorage.removeItem('token')
    localStorage.removeItem('user')
  } catch {
    /* ignore storage access errors */
  }
  window.location.href = '/login'
}

function formatClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function useSessionTimeout(enabled = true, options = {}) {
  const [showWarning, setShowWarning] = useState(false)
  const [expiresAt, setExpiresAt] = useState(null)
  const [remaining, setRemaining] = useState(WARNING_MS)
  const resetTimerRef = useRef(() => {})
  const isBusyRef = useRef(options.isBusy)
  isBusyRef.current = options.isBusy

  useEffect(() => {
    if (DEBUG) console.log('[SessionTimeout] hook running. enabled =', enabled)
    if (!enabled) {
      setShowWarning(false)
      return undefined
    }

    let timeoutId
    let warningId
    let heartbeatId
    let loggedOut = false
    let warningAt = 0

    const resetTimer = () => {
      if (loggedOut) return
      clearTimeout(timeoutId)
      clearTimeout(warningId)
      setShowWarning((prev) => (prev ? false : prev))
      setExpiresAt(null)
      warningAt = Date.now() + IDLE_BEFORE_WARNING_MS
      if (DEBUG) console.log('[SessionTimeout] timer reset at', new Date().toLocaleTimeString())

      warningId = setTimeout(() => {
        if (isBusyRef.current?.()) {
          if (DEBUG) console.log('[SessionTimeout] busy (e.g. recording) — timer reset instead of warning')
          resetTimer()
          return
        }
        if (DEBUG) console.log('[SessionTimeout] ⚠️ WARNING modal shown')
        setExpiresAt(Date.now() + WARNING_MS)
        setRemaining(WARNING_MS)
        setShowWarning(true)
      }, IDLE_BEFORE_WARNING_MS)

      timeoutId = setTimeout(() => {
        // Never destroy in-flight work (an active recording holds unsaved
        // audio in memory; a hard navigation would lose the whole encounter).
        if (isBusyRef.current?.()) {
          if (DEBUG) console.log('[SessionTimeout] busy — logout deferred, timer reset')
          resetTimer()
          return
        }
        loggedOut = true
        if (DEBUG) console.log('[SessionTimeout] 🚪 LOGOUT triggered (inactivity)')
        handleLogout()
      }, TOTAL_MS)
    }

    resetTimerRef.current = resetTimer
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()

    // Heartbeat: confirms the timer is counting down while idle.
    if (DEBUG) {
      heartbeatId = setInterval(() => {
        if (loggedOut) return
        const secsToWarning = Math.max(0, Math.round((warningAt - Date.now()) / 1000))
        console.log(`[SessionTimeout] counting… ${secsToWarning}s until warning`)
      }, 1000)
    }

    return () => {
      clearTimeout(timeoutId)
      clearTimeout(warningId)
      clearInterval(heartbeatId)
      events.forEach((e) => window.removeEventListener(e, resetTimer, { passive: true }))
    }
  }, [enabled])

  // Live countdown while the warning modal is visible.
  useEffect(() => {
    if (!showWarning || !expiresAt) return undefined
    const tick = () => setRemaining(expiresAt - Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [showWarning, expiresAt])

  const stayLoggedIn = useCallback(() => {
    setShowWarning(false)
    resetTimerRef.current()
  }, [])

  if (!enabled || !showWarning) return null

  const overlay = createElement('div', {
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.5)',
      zIndex: 9998,
    },
  })

  const icon = createElement(
    'div',
    { style: { fontSize: 48, lineHeight: 1, color: '#F59E0B', marginBottom: 12 } },
    '⚠️',
  )

  const title = createElement(
    'h2',
    {
      id: 'session-timeout-title',
      style: {
        margin: '0 0 8px',
        fontSize: 20,
        fontWeight: 700,
        color: '#111827',
      },
    },
    'Session Expiring Soon',
  )

  const body = createElement(
    'p',
    {
      style: {
        margin: '0 0 16px',
        fontSize: 14,
        lineHeight: 1.5,
        color: '#4B5563',
      },
    },
    'Your session will expire in 2 minutes due to inactivity. Click to stay logged in.',
  )

  const countdown = createElement(
    'div',
    {
      style: {
        fontSize: 34,
        fontWeight: 700,
        color: remaining <= 30000 ? '#DC2626' : '#111827',
        fontVariantNumeric: 'tabular-nums',
        marginBottom: 4,
      },
    },
    formatCountdown(remaining),
  )

  const expiryNote = createElement(
    'div',
    {
      style: {
        fontSize: 12,
        color: '#6B7280',
        marginBottom: 24,
      },
    },
    expiresAt ? `Session expires at ${formatClock(expiresAt)}` : '',
  )

  const button = createElement(
    'button',
    {
      type: 'button',
      onClick: stayLoggedIn,
      style: {
        width: '100%',
        background: '#4F46E5',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        padding: 12,
        fontWeight: 600,
        fontSize: 15,
        cursor: 'pointer',
      },
    },
    'Stay Logged In',
  )

  const modal = createElement(
    'div',
    {
      role: 'alertdialog',
      'aria-modal': true,
      'aria-labelledby': 'session-timeout-title',
      style: {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'white',
        borderRadius: 12,
        padding: 32,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        zIndex: 9999,
        textAlign: 'center',
        maxWidth: 400,
        width: 'calc(100% - 32px)',
      },
    },
    icon,
    title,
    body,
    countdown,
    expiryNote,
    button,
  )

  return createPortal(createElement('div', null, overlay, modal), document.body)
}

export default useSessionTimeout
