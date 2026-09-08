/**
 * Multi-layer keep-alive manager for active recording sessions.
 * 
 * Prevents PC (Windows, macOS, Linux) and mobile (iOS Safari, Android Chrome, iPadOS)
 * from entering sleep mode, screen auto-lock, display dimming, or audio suspension while recording is active.
 * 
 * Strategy:
 * 1. Screen Wake Lock API (Screen display keep-awake for Chromium, Edge, Safari 16.4+)
 * 2. Invisible looping video stream (Mobile Safari & Android WebKit OS power lock prevention)
 * 3. Inaudible audio playback & Web Audio pipeline (Desktop Windows/macOS kernel system sleep prevention)
 * 4. Active watchdog timer (re-acquires wake lock and resumes media every 10s if interrupted)
 * 5. Window focus & visibility change event recovery
 */

let wakeLock = null
let isRecordingActive = false
let audioCtx = null
let silentOscillator = null
let noSleepVideo = null
let noSleepAudio = null
let watchdogInterval = null

// Minimal silent 1-second 16-bit PCM WAV (base64 encoded)
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'

/**
 * Acquire Screen Wake Lock to prevent screen dimming/sleeping/locking during recording.
 */
export async function acquireWakeLock() {
  isRecordingActive = true
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
    try {
      if (!wakeLock || wakeLock.released) {
        wakeLock = await navigator.wakeLock.request('screen')
        wakeLock.addEventListener('release', () => {
          // If still recording and released (e.g. temporary OS interruption or tab switch), re-acquire when visible
          if (isRecordingActive && typeof document !== 'undefined' && document.visibilityState === 'visible') {
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
  }
  wakeLock = null
}

/**
 * Creates and plays an invisible looping media element to prevent mobile (iOS/Android)
 * and desktop browsers from sleeping during long hands-free dictations.
 */
function startNoSleepMedia() {
  if (typeof document === 'undefined') {
    return
  }

  try {
    // 1. Invisible looping video element (NoSleep pattern for mobile Safari & Chrome)
    if (!noSleepVideo) {
      const vid = document.createElement('video')
      vid.setAttribute('playsinline', '')
      vid.setAttribute('webkit-playsinline', '')
      vid.setAttribute('aria-hidden', 'true')
      vid.muted = true
      vid.loop = true
      vid.style.position = 'fixed'
      vid.style.left = '-9999px'
      vid.style.top = '-9999px'
      vid.style.width = '1px'
      vid.style.height = '1px'
      vid.style.opacity = '0.001'
      vid.style.pointerEvents = 'none'

      // Use a 1x1 canvas stream as video source
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.fillStyle = '#000000'
          ctx.fillRect(0, 0, 1, 1)
        }
        if (typeof canvas.captureStream === 'function') {
          vid.srcObject = canvas.captureStream(1)
        }
      } catch {
        /* ignore */
      }

      document.body.appendChild(vid)
      noSleepVideo = vid
    }

    if (noSleepVideo) {
      const playPromise = noSleepVideo.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {})
      }
    }

    // 2. Inaudible audio element (Tells OS power manager that media playback is active)
    if (!noSleepAudio) {
      const aud = document.createElement('audio')
      aud.src = SILENT_WAV
      aud.loop = true
      aud.volume = 0.001
      aud.setAttribute('aria-hidden', 'true')
      aud.style.position = 'fixed'
      aud.style.left = '-9999px'
      aud.style.width = '1px'
      aud.style.height = '1px'
      aud.style.opacity = '0.001'
      document.body.appendChild(aud)
      noSleepAudio = aud
    }

    if (noSleepAudio) {
      const audPromise = noSleepAudio.play()
      if (audPromise && typeof audPromise.catch === 'function') {
        audPromise.catch(() => {})
      }
    }
  } catch (err) {
    console.warn('[recordingKeepAlive] NoSleep media setup skipped:', err?.message || err)
  }
}

function stopNoSleepMedia() {
  if (noSleepVideo) {
    try {
      if (typeof noSleepVideo.pause === 'function' && !noSleepVideo.paused) {
        noSleepVideo.pause()
      }
      if (noSleepVideo.parentNode) {
        noSleepVideo.parentNode.removeChild(noSleepVideo)
      }
    } catch {
      /* ignore */
    }
    noSleepVideo = null
  }

  if (noSleepAudio) {
    try {
      if (typeof noSleepAudio.pause === 'function' && !noSleepAudio.paused) {
        noSleepAudio.pause()
      }
      if (noSleepAudio.parentNode) {
        noSleepAudio.parentNode.removeChild(noSleepAudio)
      }
    } catch {
      /* ignore */
    }
    noSleepAudio = null
  }
}

/**
 * Keep OS audio capture active in the background / when screen locks.
 * Creates an inaudible Web Audio gain node to tell desktop and mobile media frameworks
 * that an active audio session is underway.
 */
export function startAudioKeepAlive(stream) {
  if (typeof window === 'undefined') {
    return
  }

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

    // Inaudible ultra-low oscillator ensures Windows audiodg.exe / macOS coreaudio
    // registers active audio output, preventing system sleep
    if (!silentOscillator) {
      silentOscillator = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      // 0.00001 is completely inaudible to human ears but keeps the OS audio pipeline active
      gain.gain.setValueAtTime(0.00001, audioCtx.currentTime)
      silentOscillator.frequency.setValueAtTime(40, audioCtx.currentTime)
      silentOscillator.connect(gain)
      gain.connect(audioCtx.destination)
      silentOscillator.start()
    }

    // Also connect stream to an inaudible gain node if stream provided
    if (stream) {
      try {
        const source = audioCtx.createMediaStreamSource(stream)
        const micGain = audioCtx.createGain()
        micGain.gain.setValueAtTime(0.00001, audioCtx.currentTime)
        source.connect(micGain)
        micGain.connect(audioCtx.destination)
      } catch {
        /* stream source connection may fail in testing environments */
      }
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
 * Start periodic watchdog to re-verify wake lock and media status during long recordings.
 */
function startWatchdog() {
  stopWatchdog()
  if (typeof window !== 'undefined') {
    watchdogInterval = setInterval(() => {
      if (!isRecordingActive) {
        stopWatchdog()
        return
      }
      // 1. Re-acquire WakeLock if released
      if (!wakeLock || wakeLock.released) {
        acquireWakeLock().catch(() => {})
      }
      // 2. Re-assert audio context
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
      // 3. Re-assert media playback
      if (noSleepVideo && noSleepVideo.paused) {
        noSleepVideo.play().catch(() => {})
      }
      if (noSleepAudio && noSleepAudio.paused) {
        noSleepAudio.play().catch(() => {})
      }
    }, 10000)
  }
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
  }
}

/**
 * Start full keep-alive bundle (Screen WakeLock + NoSleep Media + OS Audio Pipeline + Watchdog).
 */
export async function startRecordingKeepAlive(stream) {
  isRecordingActive = true
  await acquireWakeLock()
  startNoSleepMedia()
  startAudioKeepAlive(stream)
  startWatchdog()
}

/**
 * Stop keep-alive bundle cleanly and return device to normal power saving mode.
 */
export async function stopRecordingKeepAlive() {
  isRecordingActive = false
  stopWatchdog()
  await releaseWakeLock()
  stopNoSleepMedia()
  stopAudioKeepAlive()
}

/**
 * Global visibility change and focus listeners to re-acquire wake lock if tab is refocused.
 */
if (typeof document !== 'undefined') {
  const handleWakeRecovery = () => {
    if (isRecordingActive) {
      acquireWakeLock().catch(() => {})
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }
      if (noSleepVideo && noSleepVideo.paused) {
        noSleepVideo.play().catch(() => {})
      }
      if (noSleepAudio && noSleepAudio.paused) {
        noSleepAudio.play().catch(() => {})
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleWakeRecovery()
    }
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', handleWakeRecovery)
    window.addEventListener('pageshow', handleWakeRecovery)
  }
}
