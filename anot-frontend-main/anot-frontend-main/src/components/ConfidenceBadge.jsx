import { formatConfidence, confidenceClass } from '../utils/confidence'
import './confidence.css'

/** Displays ASR confidence percentage when available */
export function ConfidenceBadge({ score }) {
  const label = formatConfidence(score)
  if (!label) { return null }
  return (
    <span
      className={`confidence-badge ${confidenceClass(score)}`}
      title="Transcription confidence"
    >
      {label}
    </span>
  )
}