'use strict'

/**
 * Limits concurrent outbound calls to third-party APIs (Deepgram, Anthropic).
 */

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MAX_CONCURRENT = parsePositiveInt(process.env.OUTBOUND_API_MAX_CONCURRENT, 5)
let active = 0
const queue = []

function runNext() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return
  const { fn, resolve, reject } = queue.shift()
  active += 1
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => {
      active -= 1
      runNext()
    })
}

function withOutboundSlot(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    runNext()
  })
}

module.exports = { withOutboundSlot, MAX_CONCURRENT }
