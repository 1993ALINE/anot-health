const crypto = require('crypto')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const TOKEN_HEADER = 'x-csrf-token'
const TOKEN_COOKIE = 'csrf_token'

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    if (!req.cookies?.[TOKEN_COOKIE]) {
      const token = generateToken()
      res.cookie(TOKEN_COOKIE, token, {
        httpOnly: false,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      })
      res.setHeader(TOKEN_HEADER, token)
    }
    return next()
  }

  const cookieToken = req.cookies?.[TOKEN_COOKIE]
  const headerToken = req.get(TOKEN_HEADER)
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.' })
  }
  return next()
}

function csrfTokenRoute(req, res) {
  const token = req.cookies?.[TOKEN_COOKIE] || generateToken()
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  res.json({ csrfToken: token })
}

module.exports = { csrfProtection, csrfTokenRoute, TOKEN_HEADER }