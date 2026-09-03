import RecordingVisualizer from './RecordingVisualizer'
import './ScribeberryRecordButton.css'

export default function ScribeberryRecordButton({
  activeVisit,
  isPaused,
  timerSeconds,
  stream,
  onStartClick,
  onPauseResume,
  onEndVisit,
}) {
  const isRecording = Boolean(activeVisit)

  const fmtTime = (s) => {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  if (!isRecording) {
    return (
      <button
        type="button"
        className="scribeberry-rec-btn"
        onClick={onStartClick}
        title="Start instant consultation or audio recording"
      >
        <span className="scribeberry-rec-btn__dot" aria-hidden="true" />
        <span className="scribeberry-rec-btn__label">Record</span>
      </button>
    )
  }

  return (
    <div className={`scribeberry-rec-capsule ${isPaused ? 'scribeberry-rec-capsule--paused' : ''}`}>
      <div className="scribeberry-rec-capsule__status">
        <span className="scribeberry-rec-capsule__dot" aria-hidden="true" />
        <span className="scribeberry-rec-capsule__timer">{fmtTime(timerSeconds)}</span>
      </div>

      <div className="scribeberry-rec-capsule__visualizer">
        <RecordingVisualizer stream={stream} isPaused={isPaused} barCount={5} theme="primary" />
      </div>

      <div className="scribeberry-rec-capsule__actions">
        <button
          type="button"
          className="scribeberry-rec-capsule__btn scribeberry-rec-capsule__btn--pause"
          onClick={onPauseResume}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
        >
          {isPaused ? '▶' : '⏸'}
        </button>

        <button
          type="button"
          className="scribeberry-rec-capsule__btn scribeberry-rec-capsule__btn--finish"
          onClick={onEndVisit}
          title="Finish recording and generate AI clinical note"
        >
          ■ Done
        </button>
      </div>
    </div>
  )
}
