/** Stateless CSRF helper — double-submit cookie + X-CSRF-Token header. */

const COOKIE_NAMES = ['__Host-csrf_token', 'csrf_token']

/** In-memory cache only (never localStorage); cookie is the durable source of truth. */
let cachedCsrfToken = null

function readCsrfCookie() {
  if (typeof document === 'undefined') { return null }
  for (const name of COOKIE_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))
    if (match) { return decodeURIComponent(match[1]) }
  }
  return null
}

function syncCache(token) {
  if (token) { cachedCsrfToken = token }
  return cachedCsrfToken
}

/**
 * GET /api/csrf-token — ensures CSRF cookie exists and returns its value.
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
