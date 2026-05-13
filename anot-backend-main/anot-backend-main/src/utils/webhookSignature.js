const crypto = require('crypto')

function webhookSecret() {
  return String(process.env.DEEPGRAM_WEBHOOK_SECRET || process.env.JWT_SECRET || '').trim()
}

function signDeepgramVisitToken(visitId) {
  const id = String(visitId)
  return crypto.createHmac('sha256', webhookSecret()).update(`dgwb:${id}`).digest('base64url')
}

function verifyDeepgramVisitToken(visitId, sig) {
  if (visitId == null || sig == null || !webhookSecret()) return false
  const id = parseInt(String(visitId), 10)
  if (!Number.isInteger(id)) return false
  try {
    const expected = signDeepgramVisitToken(id)
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(String(sig), 'utf8')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Append signed visit query to a public webhook base URL (no auth). */
function appendDeepgramVisitQuery(baseUrl, visitId) {
  const id = parseInt(String(visitId), 10)
  if (!Number.isInteger(id)) return null
  const u = String(baseUrl || '').trim()
  if (!u) return null
  const sig = signDeepgramVisitToken(id)
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}visit_id=${encodeURIComponent(String(id))}&sig=${encodeURIComponent(sig)}`
}

module.exports = {
  signDeepgramVisitToken,
  verifyDeepgramVisitToken,
  appendDeepgramVisitQuery,
}
