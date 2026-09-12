/**
 * Pure decision logic for auto-pausing/auto-resuming a recording during dead air, kept
 * separate from the MediaRecorder/AnalyserNode glue code in ClinicianPortal.jsx so it can
 * be unit-tested without mocking the Web Audio API or requestAnimationFrame.
 *
 * Cuts billed transcription minutes for genuinely dead time (exam performed quietly,
 * doctor stepped out) without risking lost speech: the silence duration required before
 * auto-pausing is deliberately far longer than any real conversational pause, and it never
 * overrides a pause the doctor triggered manually — only a pause THIS logic started can be
 * auto-resumed.
 *
 * @param {object} input
 * @param {number} input.avgVolume - raw analyser average (0-255 scale)
 * @param {number|null} input.silenceStartedAt - timestamp (ms) silence began, or null if not currently silent
 * @param {number} input.now - current timestamp (ms)
 * @param {'recording'|'paused'|'inactive'} input.recorderState
 * @param {boolean} input.isAutoPaused - whether the CURRENT pause (if any) was triggered by this logic
 * @param {number} [input.volumeThreshold] - below this raw average counts as silence
 * @param {number} [input.silenceDurationMs] - how long silence must persist before auto-pausing
 * @returns {{ action: 'none'|'startTimer'|'autoPause'|'autoResume'|'resetTimer', nextSilenceStartedAt: number|null }}
 */
export function evaluateAutoPauseDecision({
  avgVolume,
  silenceStartedAt,
  now,
  recorderState,
  isAutoPaused,
  volumeThreshold = 6,
  silenceDurationMs = 12000,
}) {
  const isSilent = avgVolume < volumeThreshold

  if (isSilent) {
    if (recorderState !== 'recording') {
      // Already paused (auto or manual) — billing already stopped, nothing to track.
      return { action: 'none', nextSilenceStartedAt: silenceStartedAt }
    }
    if (silenceStartedAt === null) {
      return { action: 'startTimer', nextSilenceStartedAt: now }
    }
    if (now - silenceStartedAt >= silenceDurationMs) {
      return { action: 'autoPause', nextSilenceStartedAt: silenceStartedAt }
    }
    return { action: 'none', nextSilenceStartedAt: silenceStartedAt }
  }

  // Speech (or any non-silent sound) detected.
  if (recorderState === 'paused' && isAutoPaused) {
    // Only resume a pause WE started — a manual pause is left entirely to the doctor.
    return { action: 'autoResume', nextSilenceStartedAt: null }
  }
  return { action: 'resetTimer', nextSilenceStartedAt: null }
}
