import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { audioAPI } from '../services/api'
import { fmtSecsAudio } from '../utils/timeFormat'
import { useRenderRateWarning } from '../utils/useRenderRateWarning'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function readDuration(audio) {
  const dur = audio?.duration
  return dur && Number.isFinite(dur) && dur > 0 ? dur : 0
}

/** Wait for loadedmetadata; seek trick for formats (e.g. webm) with missing duration headers. Includes 2.5s safety timeout. */
function waitForAudioDuration(audio, fallbackSecs = 0) {
  return new Promise((resolve) => {
    let settled = false
    let timeoutId = null

    const finish = (dur) => {
      if (settled) { return }
      settled = true
      if (timeoutId) { clearTimeout(timeoutId) }
      cleanup()
      resolve(dur > 0 ? dur : (fallbackSecs > 0 ? fallbackSecs : 0))
    }

    const tryRead = () => {
      const dur = readDuration(audio)
      if (dur > 0) {
        finish(dur)
        return true
      }
      return false
    }

    const onMeta = () => {
      if (tryRead()) { return }
      try {
        audio.currentTime = 1e101
      } catch {
        finish(0)
      }
    }

    const onSeeked = () => {
      const dur = readDuration(audio)
      if (dur > 0) {
        try {
          audio.currentTime = 0
        } catch {
          /* ignore */
        }
        finish(dur)
      }
    }

    const onError = () => finish(0)

    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('seeked', onSeeked)
      audio.removeEventListener('error', onError)
    }

    if (tryRead()) { return }

    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('error', onError, { once: true })

    // Safety timeout: never hang forever on streams where seeked does not fire
    timeoutId = setTimeout(() => {
      finish(readDuration(audio) || fallbackSecs || 0)
    }, 2500)

    try {
      audio.load()
    } catch {
      finish(0)
    }
  })
}

const PROGRESS_UI_MIN_MS = 250

function isExplicitNoAudio(hasAudio, audioFile) {
  if (hasAudio === false) { return true }
  if (audioFile !== undefined && (audioFile === null || audioFile === '' || audioFile === '[]')) {
    return true
  }
  return false
}

function PortalAudioPlayer({
  visitId,
  durationSecs = 0,
  onTabChange,
  compact = true,
  hasAudio,
  audioFile,
}) {
  useRenderRateWarning('PortalAudioPlayer')

  const explicitlyEmpty = !visitId || isExplicitNoAudio(hasAudio, audioFile)

  const [count, setCount] = useState(() => (explicitlyEmpty ? 0 : null))
  const [activeIdx, setActiveIdx] = useState(0)
  const [status, setStatus] = useState(() => (explicitlyEmpty ? 'empty' : 'loading'))
  const [errorMessage, setErrorMessage] = useState('')
  const [isPlaying, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [progress, setProgress] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [, setDurations] = useState({})
  const [scrubHover, setScrubHover] = useState(null)
  const [reloadTrigger, setReloadTrigger] = useState(0)

  const audioRef = useRef(null)
  const blobUrlsRef = useRef({})
  const durationsRef = useRef({})
  const playbackRateRef = useRef(playbackRate)
  const activeIdxRef = useRef(activeIdx)
  const lastProgressUiRef = useRef(0)
  const lastProgressSecRef = useRef(-1)

  useEffect(() => {
    activeIdxRef.current = activeIdx
  }, [activeIdx])

  const storeDuration = useCallback((idx, rawDuration) => {
    if (!rawDuration || !Number.isFinite(rawDuration) || rawDuration <= 0) { return }
    const secs = Math.floor(rawDuration)
    durationsRef.current[idx] = secs
    setDurations((prev) => ({ ...prev, [idx]: secs }))
  }, [])

  const fetchBlobUrl = useCallback(async (targetVisitId, idx) => {
    const cacheKey = `${targetVisitId}_${idx}`
    if (blobUrlsRef.current[cacheKey]) {
      return blobUrlsRef.current[cacheKey]
    }

    try {
      const blob = await audioAPI.getBlob(targetVisitId, idx)
      if (!blob?.size) {
        throw Object.assign(new Error('Recording blob is empty'), { status: 404 })
      }

      const url = URL.createObjectURL(blob)
      blobUrlsRef.current[cacheKey] = url
      return url
    } catch (err) {
      delete blobUrlsRef.current[cacheKey]
      throw err
    }
  }, [])

  // Check audio availability and recording count on visit change or reload.
  useEffect(() => {
    if (!visitId) {
      setStatus('empty')
      setErrorMessage('')
      setCount(0)
      return
    }

    if (isExplicitNoAudio(hasAudio, audioFile)) {
      setStatus('empty')
      setErrorMessage('')
      setCount(0)
      setDuration(0)
      setCurrentTime(0)
      setProgress(0)
      return
    }

    let cancelled = false

    // Revoke old blob URLs when visit changes or reloads
    Object.values(blobUrlsRef.current).forEach((url) => URL.revokeObjectURL(url))
    blobUrlsRef.current = {}
    durationsRef.current = {}
    setDurations({})
    setActiveIdx(0)
    activeIdxRef.current = 0
    setStatus('loading')
    setErrorMessage('')

    audioAPI.getCount(visitId)
      .then((d) => {
        if (cancelled) { return }
        const recCount = typeof d?.count === 'number' ? d.count : 0
        if (recCount <= 0) {
          setCount(0)
          setStatus('empty')
          setErrorMessage('')
          setDuration(0)
        } else {
          setCount(recCount)
        }
      })
      .catch((err) => {
        if (cancelled) { return }
        if (err?.status === 404) {
          setCount(0)
          setStatus('empty')
          setErrorMessage('')
        } else {
          console.warn(`[PortalAudioPlayer] Failed to get recording count for visit ${visitId}:`, err?.message)
          setCount(0)
          setStatus('error')
          setErrorMessage('Audio unavailable')
        }
      })

    return () => {
      cancelled = true
      Object.values(blobUrlsRef.current).forEach((url) => URL.revokeObjectURL(url))
      blobUrlsRef.current = {}
    }
  }, [visitId, hasAudio, audioFile, reloadTrigger])

  // Load active recording on tab switch or when count confirmed > 0
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !visitId || count === null || count <= 0 || isExplicitNoAudio(hasAudio, audioFile)) {
      if ((count === 0 || isExplicitNoAudio(hasAudio, audioFile)) && visitId) {
        setStatus((prev) => (prev !== 'error' ? 'empty' : prev))
      }
      return
    }

    let cancelled = false

    audio.pause()
    setPlaying(false)
    setProgress(0)
    setCurrentTime(0)
    audio.currentTime = 0
    setDuration(0)
    setStatus('loading')
    setErrorMessage('')

    ;(async () => {
      try {
        const url = await fetchBlobUrl(visitId, activeIdx)
        if (cancelled) { return }

        audio.pause()
        audio.currentTime = 0
        audio.playbackRate = playbackRateRef.current
        audio.src = url

        let dur = await waitForAudioDuration(audio, durationSecs)
        if (cancelled) { return }

        if (dur <= 0 && activeIdx === 0 && durationSecs > 0) {
          dur = durationSecs
        }

        if (dur > 0) {
          storeDuration(activeIdx, dur)
          setDuration(Math.floor(dur))
        }

        audio.currentTime = 0
        setProgress(0)
        setCurrentTime(0)
        setStatus('ready')
      } catch (loadErr) {
        console.warn(`[PortalAudioPlayer] Failed to load recording ${activeIdx + 1} for visit ${visitId}:`, loadErr?.message)
        if (cancelled) { return }

        const errStatus = loadErr?.status || (loadErr?.message?.includes('404') ? 404 : null)
        const errMsg = loadErr?.message || ''

        if (errStatus === 404 && (errMsg.includes('No audio') || errMsg.includes('empty'))) {
          setStatus('empty')
          setErrorMessage('')
        } else if (errStatus === 403) {
          setStatus('error')
          setErrorMessage('Access restricted')
        } else if (errStatus === 404) {
          setStatus('error')
          setErrorMessage('Audio not found in storage')
        } else {
          setStatus('error')
          setErrorMessage('Audio unavailable')
        }
      }
    })()

    return () => {
      cancelled = true
      audio.pause()
    }
  }, [activeIdx, visitId, count, durationSecs, hasAudio, audioFile, fetchBlobUrl, storeDuration, reloadTrigger])

  // Playback events on the single main audio element.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) { return }

    const onTimeUpdate = () => {
      const dur = audio.duration
      if (!dur || !Number.isFinite(dur) || dur <= 0) { return }
      const ct = audio.currentTime
      const now = performance.now()
      const sec = Math.floor(ct)
      if (
        now - lastProgressUiRef.current < PROGRESS_UI_MIN_MS &&
        sec === lastProgressSecRef.current
      ) {
        return
      }
      lastProgressUiRef.current = now
      lastProgressSecRef.current = sec
      setCurrentTime(ct)
      setProgress((ct / dur) * 100)
    }

    const onEnded = () => {
      setPlaying(false)
      const dur = audio.duration
      if (dur && Number.isFinite(dur) && dur > 0) {
        setProgress(100)
        setCurrentTime(dur)
      }
    }

    const onError = () => {
      const code = audio.error?.code
      console.warn('[PortalAudioPlayer] Audio element playback error code:', code)
      setPlaying(false)
      setStatus('error')
      setErrorMessage('Playback error')
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [])

  useEffect(() => {
    playbackRateRef.current = playbackRate
    if (audioRef.current) { audioRef.current.playbackRate = playbackRate }
  }, [playbackRate])

  const handleTabChange = (i) => {
    if (i === activeIdx) { return }
    const audio = audioRef.current
    if (audio) { audio.pause() }
    setPlaying(false)
    setActiveIdx(i)
    onTabChange?.(i)
  }

  const toggle = () => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') { return }
    if (isPlaying) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  const skip = (secs) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') { return }
    const dur = audio.duration
    if (!dur || !Number.isFinite(dur) || dur <= 0) { return }
    const t = Math.max(0, Math.min(dur, audio.currentTime + secs))
    audio.currentTime = t
    setProgress((t / dur) * 100)
    setCurrentTime(t)
  }

  const seekFromClientX = (trackEl, clientX) => {
    const audio = audioRef.current
    if (!audio || !trackEl) { return null }
    const dur = audio.duration
    if (!dur || !Number.isFinite(dur) || dur <= 0) { return null }
    const rect = trackEl.getBoundingClientRect()
    const width = rect.width || 1
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / width))
    return { time: ratio * dur, pct: ratio * 100 }
  }

  const seek = (e) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') { return }
    const hit = seekFromClientX(e.currentTarget, e.clientX)
    if (!hit) { return }
    audio.currentTime = hit.time
    setProgress(hit.pct)
    setCurrentTime(hit.time)
  }

  const seekFromTouch = (e) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') { return }
    const touch = e.changedTouches?.[0] || e.touches?.[0]
    if (!touch) { return }
    const hit = seekFromClientX(e.currentTarget, touch.clientX)
    if (!hit) { return }
    e.preventDefault()
    audio.currentTime = hit.time
    setProgress(hit.pct)
    setCurrentTime(hit.time)
  }

  const handleProgressMouseMove = (e) => {
    if (status !== 'ready') { return }
    const hit = seekFromClientX(e.currentTarget, e.clientX)
    if (!hit) { return }
    setScrubHover({ time: hit.time, pct: hit.pct })
  }

  const handleProgressMouseLeave = () => setScrubHover(null)

  const onSpeedChange = (e) => {
    const rate = parseFloat(e.target.value, 10)
    setPlaybackRate(rate)
    if (audioRef.current) { audioRef.current.playbackRate = rate }
  }

  const canPlay = status === 'ready'
  const displayCurrent = fmtSecsAudio(Math.floor(currentTime))
  const displayTotal = duration > 0 ? fmtSecsAudio(duration) : '--:--'

  return (
    <div className={`sf-audio-bar sf-audio-bar--portal${compact ? ' sf-audio-bar--compact' : ''}`}>
      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }} aria-label="Encounter recording playback" />
      <div className="sf-audio-bar__row sf-audio-bar__row--meta">
        {count > 1 ? (
          <div className="sf-audio-bar__tabs">
            {Array.from({ length: count }, (_, i) => (
              <button
                key={i}
                type="button"
                className={`sf-audio-bar__tab${activeIdx === i ? ' is-active' : ''}`}
                onClick={() => handleTabChange(i)}
              >
                Rec {i + 1}
              </button>
            ))}
          </div>
        ) : null}
        <span className="sf-audio-bar__label">
          {status === 'empty' ? (
            '🎙 No audio recorded for this encounter'
          ) : (
            <>
              🎙 Recording {activeIdx + 1}
              {count > 1 ? ` of ${count}` : ''}
            </>
          )}
        </span>
        {status === 'empty' ? (
          <span
            className="sf-audio-bar__pill"
            style={{ background: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0', fontWeight: 500 }}
          >
            No recording
          </span>
        ) : null}
        {status === 'loading' ? <span className="sf-audio-bar__pill">Loading…</span> : null}
        {status === 'ready' ? <span className="sf-audio-bar__pill sf-audio-bar__pill--ok">Ready</span> : null}
        {status === 'error' ? (
          <button
            type="button"
            className="sf-audio-bar__pill sf-audio-bar__pill--error"
            style={{ cursor: 'pointer', border: 'none', background: '#FEE2E2', color: '#991B1B', fontWeight: 600 }}
            onClick={() => setReloadTrigger((t) => t + 1)}
            title={errorMessage || 'Click to retry loading audio recording'}
          >
            {errorMessage ? `${errorMessage} · ⟳ Retry` : 'Audio unavailable · ⟳ Retry'}
          </button>
        ) : null}
        <span className="sf-audio-timer" aria-live="polite">
          <span>{displayCurrent} / {displayTotal}</span>
        </span>
      </div>
      <div className="sf-audio-bar__row sf-audio-bar__row--controls">
        <div className="sf-audio-bar__transport">
          <button type="button" className="sf-skip-btn sf-skip-btn--back" onClick={() => skip(-5)} disabled={!canPlay}>
            −5s
          </button>
          <button type="button" className="sf-play-btn" onClick={toggle} disabled={!canPlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {status === 'loading' ? '⏳' : isPlaying ? '⏸' : '▶'}
          </button>
          <button type="button" className="sf-skip-btn sf-skip-btn--fwd" onClick={() => skip(5)} disabled={!canPlay}>
            +5s
          </button>
        </div>
        <label className="sf-audio-speed">
          <span className="sf-audio-speed__lbl">Speed</span>
          <select className="sf-audio-speed__select" value={playbackRate} onChange={onSpeedChange} disabled={!canPlay}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s === 1 ? '1×' : `${s}×`}
              </option>
            ))}
          </select>
        </label>
        <div className="sf-progress-wrap">
          <div
            className="sf-progress-track sf-progress-track--interactive"
            onClick={canPlay ? seek : undefined}
            onTouchEnd={canPlay ? seekFromTouch : undefined}
            onMouseMove={canPlay ? handleProgressMouseMove : undefined}
            onMouseLeave={canPlay ? handleProgressMouseLeave : undefined}
            role={canPlay ? 'slider' : undefined}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={Math.floor(currentTime)}
          >
            <div className="sf-progress-fill sf-progress-fill--live" style={{ width: `${progress}%` }} />
            {scrubHover !== null ? (
              <span className="sf-progress-scrub-label" style={{ left: `${scrubHover.pct}%` }}>
                {fmtSecsAudio(scrubHover.time)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(PortalAudioPlayer)
