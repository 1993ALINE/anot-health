/**
 * Keep-alive manager for active recording sessions.
 * 
 * Prevents screen sleep / locking and OS audio pipeline suspension across:
 * - Desktop (Windows, macOS, Linux)
 * - Mobile (iOS Safari, Android Chrome, iPadOS)
 */

let wakeLock = null
let isRecordingActive = false
let audioCtx = null
let silentOscillator = null

/**
 * Acquire Screen Wake Lock to prevent screen dimming/sleeping/locking during recording.
 */
export async function acquireWakeLock() {
  isRecordingActive = true
  if ('wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
    try {
      if (!wakeLock || wakeLock.released) {
        wakeLock = await navigator.wakeLock.request('screen')
        wakeLock.addEventListener('release', () => {
          // If still recording and released unexpectedly (e.g. tab switched), try re-acquiring on visibility
          if (isRecordingActive && document.visibilityState === 'visible') {
            acquireWakeLock().catch(() => {})
          }
        })
      }
    } catch (err) {
      console.warn('[recordingKeepAlive] WakeLock request ignored:', err?.message || err)
    }
  }
}

/**
 * Release Screen Wake Lock when recording stops.
 */
export async function releaseWakeLock() {
  isRecordingActive = false
  if (wakeLock && !wakeLock.released) {
    try {
      await wakeLock.release()
    } catch {
      /* ignore */
    }
    wakeLock = null
  }
}

/**
 * Keep OS audio capture active in the background / when screen locks.
 * Creates an inaudible Web Audio gain node to tell mobile media frameworks
 * that an active audio session is underway.
 */
export function startAudioKeepAlive(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) {
      return
    }

    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass()
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {})
    }

    // Connect stream to a muted gain node so audio hardware stays awake
    if (stream) {
      const source = audioCtx.createMediaStreamSource(stream)
      const gain = audioCtx.createGain()
      gain.gain.setValueAtTime(0, audioCtx.currentTime)
      source.connect(gain)
      gain.connect(audioCtx.destination)
    } else {
      // Near-silent low frequency oscillator if no stream passed
      silentOscillator = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime)
      silentOscillator.frequency.setValueAtTime(40, audioCtx.currentTime)
      silentOscillator.connect(gain)
      gain.connect(audioCtx.destination)
      silentOscillator.start()
    }
  } catch (err) {
    console.warn('[recordingKeepAlive] Audio keep-alive error:', err?.message || err)
  }
}

export function stopAudioKeepAlive() {
  if (silentOscillator) {
    try {
      silentOscillator.stop()
      silentOscillator.disconnect()
    } catch {
      /* ignore */
    }
    silentOscillator = null
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    try {
      audioCtx.close().catch(() => {})
    } catch {
      /* ignore */
    }
    audioCtx = null
  }
}

/**
 * Start keep-alive bundle (WakeLock + Audio Pipeline).
 */
export async function startRecordingKeepAlive(stream) {
  await acquireWakeLock()
  startAudioKeepAlive(stream)
}

/**
 * Stop keep-alive bundle.
 */
export async function stopRecordingKeepAlive() {
  await releaseWakeLock()
  stopAudioKeepAlive()
}

/**
 * Global visibility change listener to re-acquire wake lock if tab is refocused.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRecordingActive) {
      acquireWakeLock().catch(() => {})
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
    }
  })
}
