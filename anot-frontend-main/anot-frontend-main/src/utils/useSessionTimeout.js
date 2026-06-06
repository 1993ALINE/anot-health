import { useEffect, useRef, useState, useCallback, createElement } from 'react'
import { createPortal } from 'react-dom'
import { authAPI } from '../services/api'

/**
 * HIPAA-compliant idle session timeout.
 *
 * Warns the user after 14 minutes of inactivity and automatically logs them
 * out after a further 1 minute (15 minutes total). Any tracked user activity
 * resets the timer and dismisses the warning.
 *
 * @param {boolean} enabled - Only run while a user is logged in.
 * @returns {React.ReactNode} The warning modal (portaled to <body>) or null.
 */

const TIMEOUT_MS = 14 * 60 * 1000
const WARNING_MS = 1 * 60 * 1000

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
    localStorage.clear()
  } catch {
    /* ignore storage access errors */
  }
  window.location.href = '/login'
}

export function useSessionTimeout(enabled = true) {
  const [showWarning, setShowWarning] = useState(false)
  const resetTimerRef = useRef(() => {})

  useEffect(() => {
    if (!enabled) {
      setShowWarning(false)
      return undefined
    }

    let timeoutId
    let warningId
    let loggedOut = false

    const resetTimer = () => {
      if (loggedOut) return
      clearTimeout(timeoutId)
      clearTimeout(warningId)
      setShowWarning((prev) => (prev ? false : prev))

      warningId = setTimeout(() => {
        setShowWarning(true)
      }, TIMEOUT_MS)

      timeoutId = setTimeout(() => {
        loggedOut = true
        handleLogout()
      }, TIMEOUT_MS + WARNING_MS)
    }

    resetTimerRef.current = resetTimer
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }))
    resetTimer()

    return () => {
      clearTimeout(timeoutId)
      clearTimeout(warningId)
      events.forEach((e) => window.removeEventListener(e, resetTimer, { passive: true }))
    }
  }, [enabled])

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
        margin: '0 0 24px',
        fontSize: 14,
        lineHeight: 1.5,
        color: '#4B5563',
      },
    },
    'You will be logged out in 1 minute due to inactivity.',
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
    button,
  )

  return createPortal(createElement('div', null, overlay, modal), document.body)
}

export default useSessionTimeout
