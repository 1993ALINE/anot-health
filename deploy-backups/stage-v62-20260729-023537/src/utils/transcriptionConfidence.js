/**
 * Extract confidence from Deepgram response
 */
function extractConfidence(deepgramResult) {
  const alt = deepgramResult?.results?.channels?.[0]?.alternatives?.[0]
  if (!alt) return { overall: null, segments: [] }
  const overall = typeof alt.confidence === 'number' ? alt.confidence : null
  const segments = (alt.words || []).map((w) => ({
    word: w.word,
    confidence: w.confidence ?? null,
    start: w.start,
    end: w.end,
  }))
  return { overall, segments }
}

module.exports.extractConfidence = extractConfidence