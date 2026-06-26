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

function normalizeToken(raw) {
  if (raw == null) { return null }
  if (Array.isArray(raw)) { raw = raw[0] }
  if (typeof raw !== 'string') { return null }
  const trimmed = raw.trim()
  return trimmed.length ? trimmed : null
}

function readHeaderToken(req) {
  const raw = req.get?.(TOKEN_HEADER) ?? req.headers?.[TOKEN_HEADER]
  return normalizeToken(raw)
}

/** All valid CSRF cookie values present on the request (primary first in production). */
function readCsrfCookieTokens(req) {
  const names =
    process.env.NODE_ENV === 'production'
      ? ['__Host-csrf_token', LEGACY_DEV_COOKIE]
      : [LEGACY_DEV_COOKIE, '__Host-csrf_token']
  const found = []
  const seen = new Set()
  for (const name of names) {
    const token = normalizeToken(req.cookies?.[name])
    if (isValidToken(token) && !seen.has(token)) {
      seen.add(token)
      found.push({ name, token })
    }
  }
  return found
}

function csrfDebugLog(req, { headerToken, cookieTokens, matched }) {
  if (process.env.NODE_ENV !== 'production') { return }
  const cookieName = getTokenCookieName()
  const primaryCookie = normalizeToken(req.cookies?.[cookieName])
  console.log('[CSRF-DEBUG]', {
    path: req.path,
    originalUrl: req.originalUrl,
    method: req.method,
    cookieName,
    cookieExists: !!primaryCookie,
    cookieValue: primaryCookie?.substring(0, 16),
    headerExists: !!headerToken,
    headerValue: headerToken?.substring(0, 16),
    matchPrimary: primaryCookie === headerToken,
    matchedCookie: matched?.name ?? null,
    matchAny: !!matched,
    allCookies: Object.keys(req.cookies || {}),
    csrfCookieTokens: cookieTokens.map((c) => ({ name: c.name, prefix: c.token.slice(0, 16) })),
  })
}

function resolveCookieToken(req) {
  const tokens = readCsrfCookieTokens(req)
  if (tokens.length === 0) {
    return { token: null, cookieName: getTokenCookieName() }
  }
  return { token: tokens[0].token, cookieName: tokens[0].name }
}

function validateCsrf(req) {
  const headerToken = readHeaderToken(req)
  const cookieTokens = readCsrfCookieTokens(req)
  if (!isValidToken(headerToken)) {
    return { ok: false, headerToken, cookieTokens, matched: null }
  }
  const matched = cookieTokens.find((c) => c.token === headerToken) ?? null
  return { ok: !!matched, headerToken, cookieTokens, matched }
}

function csrfProtection(req, res, next) {
  const path = req.originalUrl || req.url || ''

  if (isWebhookPath(req)) {
    return next()
  }

  if (SAFE_METHODS.has(req.method)) {
    return next()
  }

  const validation = validateCsrf(req)
  const { headerToken, cookieTokens, matched, ok } = validation

  if (process.env.NODE_ENV === 'production') {
    csrfDebugLog(req, { headerToken, cookieTokens, matched })
  }

  if (CSRF_DEBUG) {
    const cookieName = getTokenCookieName()
    console.log('[CSRF-CHECK]', req.method, path)
    console.log('[CSRF-CHECK] Header token:', headerToken?.substring(0, 8))
    console.log('[CSRF-CHECK] Cookie value:', req.cookies[cookieName]?.substring(0, 8))
    console.log('[CSRF-CHECK] Match:', ok)
  }

  if (!ok) {
    csrfDebug('rejected mutating request', {
      method: req.method,
      path,
      hasCookie: cookieTokens.length > 0,
      hasHeader: isValidToken(headerToken),
      match: false,
      cookieCount: cookieTokens.length,
    })
    if (cookieTokens.length > 0 && !isValidToken(headerToken)) {
      console.warn('[CSRF] Cookie present but X-CSRF-Token header missing — check CloudFront/proxy header forwarding')
    } else if (cookieTokens.length > 1 && isValidToken(headerToken)) {
      console.warn('[CSRF] Multiple CSRF cookies present; header did not match any cookie value')
    }
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' })
  }

  csrfDebug('allowed mutating request', {
    method: req.method,
    path,
    tokenPrefix: headerToken.slice(0, 8),
    cookie: matched.name,
  })
  return next()
}

function csrfTokenRoute(req, res) {
  const token = resolveToken(req)
  setCsrfCookie(res, token)
  // Drop stale legacy cookie in production so dual-cookie mismatches cannot cause 403.
  if (process.env.NODE_ENV === 'production') {
    const opts = {
      httpOnly: false,
      sameSite: 'strict',
      secure: true,
      path: '/',
    }
    res.clearCookie(LEGACY_DEV_COOKIE, opts)
  }
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
