import { describe, test, expect } from 'vitest'
import { evaluateAutoPauseDecision } from '../utils/autoPauseOnSilence'

const BASE = { volumeThreshold: 6, silenceDurationMs: 12000 }

describe('evaluateAutoPauseDecision', () => {
  test('starts the silence timer the first moment volume drops below threshold while recording', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 2,
      silenceStartedAt: null,
      now: 100000,
      recorderState: 'recording',
      isAutoPaused: false,
    })
    expect(result).toEqual({ action: 'startTimer', nextSilenceStartedAt: 100000 })
  })

  test('does nothing while silence duration is still under the threshold', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 2,
      silenceStartedAt: 100000,
      now: 100000 + 5000, // only 5s of silence so far, threshold is 12s
      recorderState: 'recording',
      isAutoPaused: false,
    })
    expect(result).toEqual({ action: 'none', nextSilenceStartedAt: 100000 })
  })

  test('auto-pauses once silence has persisted for the full configured duration', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 2,
      silenceStartedAt: 100000,
      now: 100000 + 12000,
      recorderState: 'recording',
      isAutoPaused: false,
    })
    expect(result.action).toBe('autoPause')
  })

  test('a real conversational pause (well under threshold) never triggers auto-pause', () => {
    // Simulate a 4-second pause between sentences — nowhere near the 12s threshold.
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 2,
      silenceStartedAt: 100000,
      now: 100000 + 4000,
      recorderState: 'recording',
      isAutoPaused: false,
    })
    expect(result.action).not.toBe('autoPause')
  })

  test('resets the silence timer as soon as speech is detected again', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 40, // clearly above the silence threshold
      silenceStartedAt: 100000,
      now: 100000 + 3000,
      recorderState: 'recording',
      isAutoPaused: false,
    })
    expect(result).toEqual({ action: 'resetTimer', nextSilenceStartedAt: null })
  })

  test('auto-resumes when speech returns during a pause this logic itself started', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 40,
      silenceStartedAt: null,
      now: 200000,
      recorderState: 'paused',
      isAutoPaused: true,
    })
    expect(result).toEqual({ action: 'autoResume', nextSilenceStartedAt: null })
  })

  test('never auto-resumes a pause the doctor triggered manually', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 40, // doctor is speaking again, but they paused it themselves
      silenceStartedAt: null,
      now: 200000,
      recorderState: 'paused',
      isAutoPaused: false, // this pause was NOT started by the auto-pause logic
    })
    expect(result.action).not.toBe('autoResume')
    expect(result.action).toBe('resetTimer')
  })

  test('does not track a silence timer while already paused (manual or auto)', () => {
    const result = evaluateAutoPauseDecision({
      ...BASE,
      avgVolume: 2,
      silenceStartedAt: null,
      now: 100000,
      recorderState: 'paused',
      isAutoPaused: false,
    })
    expect(result).toEqual({ action: 'none', nextSilenceStartedAt: null })
  })
})
