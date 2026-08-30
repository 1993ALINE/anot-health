'use strict'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isRetryableError(err) {
  if (!err) return false
  const msg = String(err.message || err).toLowerCase()
  const code = String(err.code || err.name || '').toLowerCase()
  const status = err.status || err.statusCode || err.$metadata?.httpStatusCode

  if (status === 429 || status === 503 || status === 502 || status === 504) return true
  if (/timeout|timed out|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|throttl|rate limit|service unavailable|too many requests/.test(msg)) {
    return true
  }
  if (/econnreset|econnrefused|etimedout|enotfound|timeout|throttl|slowdown/.test(code)) return true
  if (/response body object should not be disturbed or locked/.test(msg)) return true
  return false
}

/**
 * Retry an async fn with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, label?: string, shouldRetry?: (err: unknown) => boolean }} opts
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const maxAttempts = parsePositiveInt(opts.maxAttempts, 3)
  const baseDelayMs = parsePositiveInt(opts.baseDelayMs, 500)
  const maxDelayMs = parsePositiveInt(opts.maxDelayMs, 15000)
  const label = opts.label || 'operation'
  const shouldRetry = opts.shouldRetry || isRetryableError

  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retry = attempt < maxAttempts && shouldRetry(err)
      if (!retry) throw err
      const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs)
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed (${err.message || err}) — retry in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw lastErr
}

module.exports = { withRetry, isRetryableError, sleep }
