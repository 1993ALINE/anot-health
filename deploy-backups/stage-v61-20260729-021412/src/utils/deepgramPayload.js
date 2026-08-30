/**
 * Normalize Deepgram (or compatible) JSON into transcript segment strings.
 */
function extractTranscriptsFromDeepgramBody(body) {
  if (body == null) return []
  let b = body
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b)
    } catch {
      return []
    }
  }
  if (typeof b !== 'object') return []

  const results = b.results || b.result?.results
  if (results?.channels?.length) {
    const texts = []
    for (const ch of results.channels) {
      const alt = ch?.alternatives?.[0]
      const t = alt?.transcript
      if (t != null && String(t).trim()) texts.push(String(t).trim())
    }
    if (texts.length) return texts
  }

  const single =
    b.channel?.alternatives?.[0]?.transcript ||
    b.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    b.transcript
  if (typeof single === 'string' && single.trim()) return [single.trim()]

  return []
}

module.exports = { extractTranscriptsFromDeepgramBody }
