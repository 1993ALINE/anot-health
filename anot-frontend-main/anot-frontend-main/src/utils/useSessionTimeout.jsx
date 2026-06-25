import { useEffect, useRef, useState, useCallback } from 'react'
import { authAPI } from '../services/api'
import { clearSession } from '../utils/sessionAuth'
import SessionWarningModal from '../components/SessionWarningModal'

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
    clearSession()
  } catch {
    /* ignore storage access errors */
  }
  window.location.href = '/login'
}

function clearSessionTimers(timeoutId, warningId, heartbeatId) {
  if (timeoutId) { clearTimeout(timeoutId) }
  if (warningId) { clearTimeout(warningId) }
  if (heartbeatId) { clearInterval(heartbeatId) }
}

export function useSessionTimeout(enabled = true, options = {}) {
  const [showWarning, setShowWarning] = useState(false)
  const [expiresAt, setExpiresAt] = useState(null)
  const [remaining, setRemaining] = useState(WARNING_MS)
  const resetTimerRef = useRef(() => {})
  const isBusyRef = useRef(options.isBusy)

  useEffect(() => {
    isBusyRef.current = options.isBusy
  }, [options.isBusy])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    let timeoutId
    let warningId
    let loggedOut = false

    const resetTimer = () => {
      if (loggedOut) { return }
      clearTimeout(timeoutId)
      clearTimeout(warningId)
      setShowWarning((prev) => (prev ? false : prev))
      setExpiresAt(null)

      warningId = setTimeout(() => {
        if (isBusyRef.current?.()) {
          resetTimer()
          return
        }
        setExpiresAt(Date.now() + WARNING_MS)
        setRemaining(WARNING_MS)
        setShowWarning(true)
      }, IDLE_BEFORE_WARNING_MS)

      timeoutId = setTimeout(() => {
        if (isBusyRef.current?.()) {
          resetTimer()
          return
        }
        loggedOut = true
        handleLogout()
      }, TOTAL_MS)
    }

    resetTimerRef.current = resetTimer
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()

    return () => {
      clearSessionTimers(timeoutId, warningId, null)
      events.forEach((e) => window.removeEventListener(e, resetTimer, { passive: true }))
    }
  }, [enabled])

  useEffect(() => {
    if (!showWarning || !expiresAt) { return undefined }
    const tick = () => setRemaining(expiresAt - Date.now())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [showWarning, expiresAt])

  const stayLoggedIn = useCallback(() => {
    setShowWarning(false)
    resetTimerRef.current()
  }, [])

  if (!enabled || !showWarning) { return null }

  return (
    <SessionWarningModal
      remaining={remaining}
      expiresAt={expiresAt}
      onStayLoggedIn={stayLoggedIn}
    />
  )
}

export default useSessionTimeout
