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
  if (results) {
    // 1. Prefer diarized speaker utterances
    if (Array.isArray(results.utterances) && results.utterances.length > 0) {
      const formatted = results.utterances
        .map((u) => {
          const spk = u.speaker != null ? `Speaker ${u.speaker}: ` : ''
          const txt = String(u.transcript || '').trim()
          return txt ? `${spk}${txt}` : ''
        })
        .filter(Boolean)
        .join('\n')
      if (formatted.trim()) return [formatted.trim()]
    }

    // 2. Prefer paragraphs with speaker labels
    const paragraphs = results.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs
    if (Array.isArray(paragraphs) && paragraphs.length > 0) {
      const formatted = paragraphs
        .map((p) => {
          const spk = p.speaker != null ? `Speaker ${p.speaker}: ` : ''
          const text = p.sentences ? p.sentences.map((s) => s.text).join(' ') : (p.transcript || '')
          const trimmed = String(text || '').trim()
          return trimmed ? `${spk}${trimmed}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
      if (formatted.trim()) return [formatted.trim()]
    }

    // 3. Fallback to channel alternative transcript
    if (results.channels?.length) {
      const texts = []
      for (const ch of results.channels) {
        const alt = ch?.alternatives?.[0]
        const t = alt?.transcript
        if (t != null && String(t).trim()) texts.push(String(t).trim())
      }
      if (texts.length) return texts
    }
  }

  const single =
    b.channel?.alternatives?.[0]?.transcript ||
    b.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    b.transcript
  if (typeof single === 'string' && single.trim()) return [single.trim()]

  return []
}

module.exports = { extractTranscriptsFromDeepgramBody }
