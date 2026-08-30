'use strict'

const DEFAULT_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10)
const LONG_RUNNING_SOCKET_MS = parseInt(process.env.REQUEST_TIMEOUT || '600000', 10)

const LONG_RUNNING_PREFIXES = [
  '/api/audio',
  '/api/webhooks',
]

function isLongRunningRequest(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0]
  if (LONG_RUNNING_PREFIXES.some((p) => path.startsWith(p))) return true
  if (/^\/api\/visits\/\d+\/(transcribe|generate-ai|generate-draft)$/i.test(path)) return true
  if (req.method === 'GET' && path.startsWith('/api/health')) return true
  return false
}

/**
 * Extend socket timeouts for uploads and transcription routes (default 10 min).
 * Prevents premature connection drops on large audio uploads and long jobs.
 */
function longRunningSocketTimeoutMiddleware(timeoutMs = LONG_RUNNING_SOCKET_MS) {
  return (req, res, next) => {
    if (!isLongRunningRequest(req)) return next()
    req.setTimeout?.(timeoutMs)
    res.setTimeout?.(timeoutMs)
    next()
  }
}

/**
 * Abort requests that exceed REQUEST_TIMEOUT_MS (default 30s).
 * Skips audio upload/stream, webhooks, and transcription routes.
 */
function requestTimeoutMiddleware(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return (req, res, next) => {
    if (isLongRunningRequest(req)) return next()

    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      if (!res.headersSent) {
        res.status(503).json({ error: 'Request timed out. Please try again.' })
      }
      req.destroy?.()
    }, timeoutMs)

    const cleanup = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
    }

    res.on('finish', cleanup)
    res.on('close', cleanup)
    next()
  }
}

module.exports = {
  requestTimeoutMiddleware,
  longRunningSocketTimeoutMiddleware,
  isLongRunningRequest,
  DEFAULT_TIMEOUT_MS,
  LONG_RUNNING_SOCKET_MS,
}
