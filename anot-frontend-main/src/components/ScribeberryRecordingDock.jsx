import RecordingVisualizer from './RecordingVisualizer'
import './ScribeberryRecordingDock.css'

export default function ScribeberryRecordingDock({
  activeVisit,
  isPaused,
  timerSeconds,
  stream,
  onPauseResume,
  onEndVisit,
  onCancel,
  mode = 'primary', // 'primary' | 'additional'
}) {
  if (!activeVisit) {
    return null
  }

  const fmtTime = (s) => {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  return (
    <aside className="scribeberry-dock" role="region" aria-label="Active Consultation Recording Dock">
      <div className="scribeberry-dock__content">
        {/* Status & Visualizer */}
        <div className="scribeberry-dock__status-group">
          <div className={`scribeberry-dock__badge ${isPaused ? 'scribeberry-dock__badge--paused' : 'scribeberry-dock__badge--live'}`}>
            <span className="scribeberry-dock__pulse-dot" aria-hidden="true" />
            <span className="scribeberry-dock__status-text">{isPaused ? 'PAUSED' : 'LIVE REC'}</span>
          </div>

          <div className="scribeberry-dock__timer" aria-live="polite">
            {fmtTime(timerSeconds)}
          </div>

          <div className="scribeberry-dock__visualizer-wrap">
            <RecordingVisualizer stream={stream} isPaused={isPaused} barCount={8} theme="blue" />
          </div>
        </div>

        {/* Patient / Encounter Info */}
        <div className="scribeberry-dock__patient-info">
          <div className="scribeberry-dock__patient-name">
            <span className="scribeberry-dock__patient-icon">👤</span>
            <strong>{activeVisit.patient_name || 'Dictated Patient'}</strong>
          </div>
          <div className="scribeberry-dock__patient-meta">
            {activeVisit.mrn && <span>{activeVisit.mrn}</span>}
            {activeVisit.mrn && <span className="scribeberry-dock__dot-sep">·</span>}
            <span>{mode === 'additional' ? 'Additional Audio' : activeVisit.visit_type || 'Consultation'}</span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="scribeberry-dock__actions">
          <button
            type="button"
            className={`scribeberry-dock__btn scribeberry-dock__btn--pause ${isPaused ? 'scribeberry-dock__btn--resume' : ''}`}
            onClick={onPauseResume}
            title={isPaused ? 'Resume audio recording' : 'Pause audio recording'}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>

          <button
            type="button"
            className="scribeberry-dock__btn scribeberry-dock__btn--finish"
            onClick={onEndVisit}
            title="Complete recording and generate structured AI clinical note"
          >
            <span className="scribeberry-dock__stop-icon" aria-hidden="true" />
            <span>Stop &amp; Generate Note</span>
          </button>

          <button
            type="button"
            className="scribeberry-dock__btn scribeberry-dock__btn--cancel"
            onClick={onCancel}
            title="Discard this recording session"
          >
            ✕ Discard
          </button>
        </div>
      </div>
    </aside>
  )
}
