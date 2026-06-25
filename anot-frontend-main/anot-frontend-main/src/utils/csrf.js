/** Stateless CSRF helper — double-submit cookie + X-CSRF-Token header. */

const COOKIE_NAME = 'csrf_token'

/** In-memory cache only (never localStorage); cookie is the durable source of truth. */
let cachedCsrfToken = null

function readCsrfCookie() {
  if (typeof document === 'undefined') { return null }
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function syncCache(token) {
  if (token) { cachedCsrfToken = token }
  return cachedCsrfToken
}

/**
 * GET /api/csrf-token — ensures csrf_token cookie exists and returns its value.
 * Prefers the browser cookie over memory so cache clears never desync from the server.
 * @param {string} apiBase e.g. https://app.anot.health/api
 */
export async function fetchCsrfToken(apiBase, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const fromCookie = readCsrfCookie()
    if (fromCookie) { return syncCache(fromCookie) }
    if (cachedCsrfToken) { return cachedCsrfToken }
  }

  const url = `${apiBase.replace(/\/+$/, '')}/csrf-token`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) { throw new Error('Failed to fetch CSRF token') }
  const data = await res.json()
  const token = data?.csrfToken
  if (!token) { throw new Error('CSRF token missing from response') }
  return syncCache(token)
}

export function clearCsrfToken() {
  cachedCsrfToken = null
}

export function getCsrfHeaders(token) {
  return token ? { 'X-CSRF-Token': token } : {}
}
