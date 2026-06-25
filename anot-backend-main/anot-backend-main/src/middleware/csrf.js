const crypto = require('crypto')

/**
 * Stateless double-submit CSRF protection.
 *
 * No server-side token store — the CSRF cookie is the source of truth.
 * Mutating requests must send the same value in the X-CSRF-Token header.
 * Survives EB restarts and scales across instances; cookie is long-lived (no expiry).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const TOKEN_HEADER = 'x-csrf-token'
/** __Host- prefix enforces Secure + Path=/ + no Domain (HTTPS production only). */
const TOKEN_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-csrf_token' : 'csrf_token'
/** 10 years — effectively permanent; browser may cap but never session-only. */
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000
const TOKEN_REGEX = /^[a-f0-9]{64}$/

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
  res.cookie(TOKEN_COOKIE, token, csrfCookieOptions())
}

function clearCsrfCookie(res) {
  res.clearCookie(TOKEN_COOKIE, {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
}

function resolveToken(req) {
  const existing = req.cookies?.[TOKEN_COOKIE]
  return isValidToken(existing) ? existing : generateToken()
}

function isWebhookPath(req) {
  const path = req.originalUrl || req.url || ''
  return path.startsWith('/api/webhooks')
}

function csrfProtection(req, res, next) {
  if (isWebhookPath(req)) {
    return next()
  }

  if (SAFE_METHODS.has(req.method)) {
    if (!isValidToken(req.cookies?.[TOKEN_COOKIE])) {
      const token = generateToken()
      setCsrfCookie(res, token)
      res.setHeader(TOKEN_HEADER, token)
    }
    return next()
  }

  const cookieToken = req.cookies?.[TOKEN_COOKIE]
  const headerToken = req.get(TOKEN_HEADER)
  if (!isValidToken(cookieToken) || !isValidToken(headerToken) || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' })
  }
  return next()
}

function csrfTokenRoute(req, res) {
  const token = resolveToken(req)
  setCsrfCookie(res, token)
  res.json({ csrfToken: token, cookieName: TOKEN_COOKIE })
}

module.exports = {
  csrfProtection,
  csrfTokenRoute,
  clearCsrfCookie,
  TOKEN_HEADER,
  TOKEN_COOKIE,
}
