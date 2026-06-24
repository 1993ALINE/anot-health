/** Format confidence score for display (0-1 -> percentage) */
export function formatConfidence(score) {
  if ((score === null || score === undefined) || Number.isNaN(Number(score))) { return null }
  const pct = Math.round(Number(score) * 100)
  return `${pct}%`
}

export function confidenceClass(score) {
  const n = Number(score)
  if (Number.isNaN(n)) { return 'confidence-unknown' }
  if (n >= 0.9) { return 'confidence-high' }
  if (n >= 0.75) { return 'confidence-medium' }
  return 'confidence-low'
}
