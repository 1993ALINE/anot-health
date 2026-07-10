'use strict'

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Simple in-process circuit breaker (fail-fast when a dependency is down).
 */
function createCircuitBreaker(name, opts = {}) {
  const failureThreshold = parsePositiveInt(opts.failureThreshold, 5)
  const resetMs = parsePositiveInt(opts.resetMs, 30000)
  const windowMs = parsePositiveInt(opts.windowMs, 60000)

  let state = 'closed' // closed | open | half-open
  let openedAt = 0
  const failures = []

  function prune() {
    const cutoff = Date.now() - windowMs
    while (failures.length && failures[0] < cutoff) failures.shift()
  }

  function recordFailure() {
    failures.push(Date.now())
    prune()
    if (state === 'half-open' || failures.length >= failureThreshold) {
      state = 'open'
      openedAt = Date.now()
      console.error(`[circuitBreaker] ${name} OPEN after ${failures.length} failure(s) in ${windowMs}ms`)
    }
  }

  function recordSuccess() {
    failures.length = 0
    if (state !== 'closed') {
      console.log(`[circuitBreaker] ${name} CLOSED — dependency recovered`)
    }
    state = 'closed'
  }

  function status() {
    prune()
    return {
      name,
      state,
      recentFailures: failures.length,
      failureThreshold,
      resetMs,
    }
  }

  async function exec(fn) {
    if (state === 'open') {
      if (Date.now() - openedAt >= resetMs) {
        state = 'half-open'
        console.log(`[circuitBreaker] ${name} HALF-OPEN — probing`)
      } else {
        const err = new Error(`${name} circuit breaker is open — failing fast`)
        err.code = 'CIRCUIT_OPEN'
        err.status = 503
        throw err
      }
    }

    try {
      const result = await fn()
      recordSuccess()
      return result
    } catch (err) {
      recordFailure()
      throw err
    }
  }

  return { exec, status, recordFailure, recordSuccess }
}

module.exports = { createCircuitBreaker }
