const crypto = require('crypto')

// Reject signatures older than this window to defeat replay of captured URLs
// (§164.312(c) integrity). Overridable for ops if long async transcriptions
// legitimately call back later than the default.
const MAX_AGE_MS = Number(process.env.DEEPGRAM_WEBHOOK_MAX_AGE_MS) || 5 * 60 * 1000

// Dedicated webhook secret. Never fall back to JWT_SECRET (key reuse). Fail
// closed in production; dev gets a clearly-labelled placeholder.
function webhookSecret() {
  const dedicated = String(process.env.DEEPGRAM_WEBHOOK_SECRET || '').trim()
  if (dedicated) return dedicated
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DEEPGRAM_WEBHOOK_SECRET must be set in production')
  }
  return 'dev-webhook-secret-change-in-prod'
}

function signDeepgramVisitToken(visitId, timestamp) {
  const id = String(visitId)
  const ts = String(timestamp)
  return crypto
    .createHmac('sha256', webhookSecret())
    .update(`dgwb:${id}:${ts}`)
    .digest('base64url')
}

function verifyDeepgramVisitToken(visitId, sig, timestamp) {
  if (visitId == null || sig == null || timestamp == null) return false

  const id = parseInt(String(visitId), 10)
  if (!Number.isInteger(id)) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false

  // Reject expired signatures (and timestamps from too far in the future,
  // which would otherwise extend the replay window).
  const age = Date.now() - ts
  if (age > MAX_AGE_MS) {
    console.log(`[webhookSignature] Signature expired (${Math.round(age / 1000)}s old)`)
    return false
  }
  if (age < -MAX_AGE_MS) {
    console.log('[webhookSignature] Signature timestamp is too far in the future')
    return false
  }

  let secret
  try {
    secret = webhookSecret()
  } catch {
    return false
  }
  if (!secret) return false

  try {
    const expected = signDeepgramVisitToken(id, ts)
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(String(sig), 'utf8')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Append signed, timestamped visit query to a public webhook base URL (no auth). */
function appendDeepgramVisitQuery(baseUrl, visitId) {
  const id = parseInt(String(visitId), 10)
  if (!Number.isInteger(id)) return null
  const u = String(baseUrl || '').trim()
  if (!u) return null
  const ts = Date.now()
  const sig = signDeepgramVisitToken(id, ts)
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}visit_id=${encodeURIComponent(String(id))}&ts=${encodeURIComponent(String(ts))}&sig=${encodeURIComponent(sig)}`
}

module.exports = {
  signDeepgramVisitToken,
  verifyDeepgramVisitToken,
  appendDeepgramVisitQuery,
}
