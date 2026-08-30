/**
 * Production-safe HTTP error responses.
 * Full error details are logged server-side only; clients receive generic messages in production.
 */

const STATUS_MESSAGES = {
  400: 'Invalid request',
  401: 'Authentication failed',
  403: 'Access denied',
  404: 'Resource not found',
  409: 'Resource conflict',
  413: 'Request too large',
  429: 'Too many requests',
  500: 'Something went wrong',
  503: 'Service temporarily unavailable',
}

function isProduction() {
  return process.env.NODE_ENV === 'production'
}

function getPublicErrorMessage(status, err) {
  const code = Number(status) || 500
  if (!isProduction()) {
    return err?.message || STATUS_MESSAGES[code] || STATUS_MESSAGES[500]
  }
  return STATUS_MESSAGES[code] || STATUS_MESSAGES[500]
}

function logServerError(context, err, req) {
  const label = context || 'API'
  const cid = req?.correlationId
  const msg = err?.message || String(err)
  if (cid) {
    console.error(`[${label}] ${msg} (correlation: ${cid})`)
  } else {
    console.error(`[${label}] ${msg}`)
  }
  if (!isProduction() && err?.stack) {
    console.error(err.stack)
  }
}

/**
 * Send a sanitized JSON error response and log the real error server-side.
 * @returns {import('express').Response}
 */
function sendHttpError(res, status, err, { context, req } = {}) {
  logServerError(context, err, req)
  const body = { error: getPublicErrorMessage(status, err) }
  if (!isProduction() && err?.message && err.message !== body.error) {
    body.details = err.message
  }
  return res.status(status).json(body)
}

/**
 * Build error payload for the global Express error handler.
 */
function buildErrorPayload(err, status) {
  const code = Number(status) || 500
  const payload = { error: getPublicErrorMessage(code, err) }
  if (!isProduction()) {
    if (err?.message && err.message !== payload.error) payload.details = err.message
    if (err?.stack) payload.stack = err.stack
  }
  return payload
}

module.exports = {
  STATUS_MESSAGES,
  isProduction,
  getPublicErrorMessage,
  logServerError,
  sendHttpError,
  buildErrorPayload,
}
