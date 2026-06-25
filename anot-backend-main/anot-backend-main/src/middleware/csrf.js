const crypto = require('crypto')

/**
 * Stateless double-submit CSRF protection.
 *
 * No server-side token store — the CSRF cookie is the source of truth.
 * Mutating requests must send the same value in the X-CSRF-Token header.
 * Survives EB restarts and scales across instances; cookie is long-lived (no expiry).
 *
 * Cookie policy (production):
 *   Name: __Host-csrf_token (Secure, Path=/, no Domain — __Host- prefix rules)
 *   SameSite: strict
 *   httpOnly: false — required so the SPA can read the cookie for the header (double-submit)
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const TOKEN_HEADER = 'x-csrf-token'
/** __Host- prefix enforces Secure + Path=/ + no Domain (HTTPS production only). */
const LEGACY_DEV_COOKIE = 'csrf_token'
/** 10 years — effectively permanent; browser may cap but never session-only. */
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000
const TOKEN_REGEX = /^[a-f0-9]{64}$/
const CSRF_DEBUG = process.env.CSRF_DEBUG === 'true' || process.env.CSRF_DEBUG === '1'

function getTokenCookieName() {
  return process.env.NODE_ENV === 'production' ? '__Host-csrf_token' : LEGACY_DEV_COOKIE
}

function csrfDebug(message, meta = {}) {
  if (!CSRF_DEBUG) { return }
  const path = meta.path || ''
  console.log(`[csrf] ${message}${path ? ` path=${path}` : ''}`, meta)
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token)
}

function csrfCookieOptions() {
  return {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  }
}

function setCsrfCookie(res, token) {
  const cookieName = getTokenCookieName()
  res.cookie(cookieName, token, csrfCookieOptions())
  csrfDebug('set cookie', { cookie: cookieName, tokenPrefix: token.slice(0, 8) })
}

function clearCsrfCookie(res) {
  const opts = {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  }
  const cookieName = getTokenCookieName()
  res.clearCookie(cookieName, opts)
  if (cookieName !== LEGACY_DEV_COOKIE) {
    res.clearCookie(LEGACY_DEV_COOKIE, opts)
  }
}

function resolveToken(req) {
  const cookieName = getTokenCookieName()
  const existing = req.cookies?.[cookieName]
  if (isValidToken(existing)) {
    csrfDebug('reuse cookie token', { tokenPrefix: existing.slice(0, 8) })
    return existing
  }
  const legacy = req.cookies?.[LEGACY_DEV_COOKIE]
  if (cookieName !== LEGACY_DEV_COOKIE && isValidToken(legacy)) {
    csrfDebug('reuse legacy cookie token', { tokenPrefix: legacy.slice(0, 8) })
    return legacy
  }
  const token = generateToken()
  csrfDebug('generated new token', { tokenPrefix: token.slice(0, 8) })
  return token
}

function isWebhookPath(req) {
  const path = req.originalUrl || req.url || ''
  return path.startsWith('/api/webhooks')
}

function csrfProtection(req, res, next) {
  const path = req.originalUrl || req.url || ''

  if (CSRF_DEBUG) {
    const cookieName = getTokenCookieName()
    console.log('[CSRF-CHECK]', req.method, path)
    console.log('[CSRF-CHECK] Header token:', req.headers['x-csrf-token']?.substring(0, 8))
    console.log('[CSRF-CHECK] Cookie value:', req.cookies[cookieName]?.substring(0, 8))
    console.log('[CSRF-CHECK] Match:', req.headers['x-csrf-token'] === req.cookies[cookieName])
  }

  if (isWebhookPath(req)) {
    return next()
  }

  // Do not mint CSRF cookies on arbitrary safe GETs — parallel requests without a
  // cookie each used to generate a different token, overwriting Set-Cookie and
  // desyncing the header (from GET /csrf-token) from the browser cookie → 403.
  if (SAFE_METHODS.has(req.method)) {
    return next()
  }

  const cookieName = getTokenCookieName()
  const cookieToken = isValidToken(req.cookies?.[cookieName])
    ? req.cookies[cookieName]
    : req.cookies?.[LEGACY_DEV_COOKIE]
  const headerToken = req.get(TOKEN_HEADER)

  if (!isValidToken(cookieToken) || !isValidToken(headerToken) || cookieToken !== headerToken) {
    csrfDebug('rejected mutating request', {
      method: req.method,
      path,
      hasCookie: isValidToken(cookieToken),
      hasHeader: isValidToken(headerToken),
      match: isValidToken(cookieToken) && cookieToken === headerToken,
    })
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' })
  }

  csrfDebug('allowed mutating request', { method: req.method, path, tokenPrefix: cookieToken.slice(0, 8) })
  return next()
}

function csrfTokenRoute(req, res) {
  const token = resolveToken(req)
  setCsrfCookie(res, token)
  res.json({ csrfToken: token, cookieName: getTokenCookieName() })
}

module.exports = {
  csrfProtection,
  csrfTokenRoute,
  clearCsrfCookie,
  csrfCookieOptions,
  isValidToken,
  getTokenCookieName,
  TOKEN_HEADER,
  LEGACY_DEV_COOKIE,
}
