/** Deepgram cannot call back localhost or private URLs — use sync transcription instead. */
function isReachableWebhookUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const u = new URL(raw)
    if (!['http:', 'https:'].includes(u.protocol)) return false
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false
    if (host.endsWith('.local')) return false
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
    return true
  } catch {
    return false
  }
}

module.exports = { isReachableWebhookUrl }
