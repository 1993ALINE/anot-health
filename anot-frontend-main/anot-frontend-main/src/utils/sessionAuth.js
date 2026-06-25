/** Session-scoped auth storage with 1h TTL (interim until HttpOnly cookies). */

const TOKEN_KEY = 'token'
const USER_KEY = 'user'
const EXPIRY_KEY = 'token_expires_at'
const SESSION_TTL_MS = 60 * 60 * 1000

function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    /* ignore */
  }
}

/** Remove expired session; migrate away from legacy localStorage tokens. */
export function purgeExpiredSession() {
  clearLegacyLocalStorage()
  try {
    const expiry = sessionStorage.getItem(EXPIRY_KEY)
    if (expiry && Date.now() > Number(expiry)) {
      clearSession()
    }
  } catch {
    /* ignore */
  }
}

export function setSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token)
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
  sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + SESSION_TTL_MS))
  clearLegacyLocalStorage()
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(USER_KEY)
  sessionStorage.removeItem(EXPIRY_KEY)
  clearLegacyLocalStorage()
}

export function getToken() {
  purgeExpiredSession()
  return sessionStorage.getItem(TOKEN_KEY)
}

export function getStoredUserRaw() {
  purgeExpiredSession()
  return sessionStorage.getItem(USER_KEY)
}

export function setStoredUser(user) {
  if (!getToken()) { return }
  sessionStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function hasValidSession() {
  return !!getToken()
}

/** Clear service worker / Cache API storage on logout (PHI must not persist). */
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
