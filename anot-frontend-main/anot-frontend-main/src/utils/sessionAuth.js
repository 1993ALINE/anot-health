/** HttpOnly cookie session — user profile cached client-side; JWT never in JS storage. */

const USER_KEY = 'user'
const SESSION_ACTIVE_KEY = 'session_active'

function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('token_expires_at')
  } catch {
    /* ignore */
  }
}

export function purgeExpiredSession() {
  clearLegacyLocalStorage()
}

export function setSession(user) {
  if (!user) {
    return
  }
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
  sessionStorage.setItem(SESSION_ACTIVE_KEY, '1')
  clearLegacyLocalStorage()
}

export function clearSession() {
  sessionStorage.removeItem(USER_KEY)
  sessionStorage.removeItem(SESSION_ACTIVE_KEY)
  clearLegacyLocalStorage()
}

/** @deprecated Auth token is HttpOnly cookie — not readable from JS. */
export function getToken() {
  return null
}

export function getStoredUserRaw() {
  return sessionStorage.getItem(USER_KEY)
}

export function setStoredUser(user) {
  if (!hasValidSession()) {
    return
  }
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function hasValidSession() {
  return sessionStorage.getItem(SESSION_ACTIVE_KEY) === '1' && !!getStoredUserRaw()
}

export async function clearAppCaches() {
  try {
    if ('caches' in globalThis) {
      await caches.delete('anot-v1')
    }
  } catch {
    /* ignore */
  }
  try {
    const sw = navigator.serviceWorker?.controller
    if (sw) {
      sw.postMessage({ type: 'CLEAR_CACHE' })
    }
  } catch {
    /* ignore */
  }
}
