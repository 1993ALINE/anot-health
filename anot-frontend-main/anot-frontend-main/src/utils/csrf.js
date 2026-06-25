/** Stateless CSRF helper — double-submit cookie + X-CSRF-Token header. */

const TOKEN_REGEX = /^[a-f0-9]{64}$/

/** In-memory cache only (never localStorage); cookie is the durable source of truth. */
let cachedCsrfToken = null
let cachedCookieName = null
/** Dedupes concurrent /csrf-token fetches (parallel GETs caused token/cookie mismatch → 403). */
let inFlightFetch = null

const CSRF_DEBUG =
  import.meta.env.DEV ||
  import.meta.env.VITE_CSRF_DEBUG === 'true' ||
  import.meta.env.VITE_CSRF_DEBUG === '1'

function csrfDebug(message, meta = {}) {
  if (!CSRF_DEBUG) { return }
  console.debug('[csrf]', message, meta)
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token)
}

function readCookieValue(name) {
  if (typeof document === 'undefined') { return null }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/** Mirror backend csrfProtection cookie selection: __Host first, then legacy. */
function resolveDocumentCsrfToken() {
  const host = readCookieValue('__Host-csrf_token')
  if (isValidToken(host)) {
    return { token: host, cookieName: '__Host-csrf_token' }
  }
  const legacy = readCookieValue('csrf_token')
  if (isValidToken(legacy)) {
    return { token: legacy, cookieName: 'csrf_token' }
  }
  return null
}

function syncCache(token, cookieName) {
  if (token) {
    cachedCsrfToken = token
    if (cookieName) { cachedCookieName = cookieName }
  }
  return cachedCsrfToken
}

async function fetchCsrfTokenFromServer(apiBase) {
  const url = `${apiBase.replace(/\/+$/, '')}/csrf-token`
  csrfDebug('fetching token from server', { url })
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) { throw new Error('Failed to fetch CSRF token') }
  const data = await res.json()
  const token = data?.csrfToken
  const cookieName = data?.cookieName
  if (!isValidToken(token)) { throw new Error('CSRF token missing from response') }
  csrfDebug('received token from server', { cookieName, tokenPrefix: token.slice(0, 8) })
  syncCache(token, cookieName)
  const fromDoc = resolveDocumentCsrfToken()
  if (fromDoc) {
    syncCache(fromDoc.token, fromDoc.cookieName)
    return fromDoc.token
  }
  return token
}

/**
 * Synchronous read of the CSRF token that will be sent as a cookie on the next request.
 * Prefer this for headers so X-CSRF-Token matches the backend's cookie selection.
 */
export function getCsrfToken() {
  const fromDoc = resolveDocumentCsrfToken()
  if (fromDoc) {
    syncCache(fromDoc.token, fromDoc.cookieName)
    return fromDoc.token
  }
  return cachedCsrfToken
}

/**
 * GET /api/csrf-token — ensures CSRF cookie exists and returns its value.
 * Uses a single in-flight request so parallel API calls cannot desync cookie vs header.
 * @param {string} apiBase e.g. https://app.anot.health/api
 */
export async function fetchCsrfToken(apiBase, { forceRefresh = false } = {}) {
  if (inFlightFetch && !forceRefresh) {
    csrfDebug('awaiting in-flight CSRF fetch')
    return inFlightFetch
  }

  if (!forceRefresh) {
    const fromDoc = resolveDocumentCsrfToken()
    if (fromDoc) {
      csrfDebug('using cookie token', { cookieName: fromDoc.cookieName, tokenPrefix: fromDoc.token.slice(0, 8) })
      syncCache(fromDoc.token, fromDoc.cookieName)
      return fromDoc.token
    }
    if (cachedCsrfToken) {
      csrfDebug('using cached token', { tokenPrefix: cachedCsrfToken.slice(0, 8) })
      return cachedCsrfToken
    }
  }

  const run = fetchCsrfTokenFromServer(apiBase).finally(() => {
    inFlightFetch = null
  })

  inFlightFetch = run
  return run
}

export function clearCsrfToken() {
  cachedCsrfToken = null
  cachedCookieName = null
  inFlightFetch = null
  csrfDebug('cleared CSRF cache')
}

export function getCsrfHeaders(token) {
  return token ? { 'X-CSRF-Token': token } : {}
}
