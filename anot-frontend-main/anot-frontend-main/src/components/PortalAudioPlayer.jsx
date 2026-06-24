import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { API_BASE } from '../services/api'
import { fmtSecsAudio } from '../utils/timeFormat'
import { useRenderRateWarning } from '../utils/useRenderRateWarning'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function readDuration(audio) {
  const dur = audio.duration
  return dur && Number.isFinite(dur) && dur > 0 ? dur : 0
}

/** Wait for loadedmetadata; seek trick for formats (e.g. webm) with missing duration. */
function waitForAudioDuration(audio) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (dur) => {
      if (settled) {return}
      settled = true
      cleanup()
      resolve(dur > 0 ? dur : 0)
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
      if (tryRead()) {return}
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

    if (tryRead()) {return}

    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('error', onError, { once: true })
    audio.load()
  })
}

const PROGRESS_UI_MIN_MS = 250

function PortalAudioPlayer({ visitId, durationSecs = 0, onTabChange, compact = true }) {
  useRenderRateWarning('PortalAudioPlayer')

  const [count, setCount] = useState(1)
  const [activeIdx, setActiveIdx] = useState(0)
  const [status, setStatus] = useState('loading')
  const [isPlaying, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [progress, setProgress] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [, setDurations] = useState({})
  const [scrubHover, setScrubHover] = useState(null)

  const audioRef = useRef(null)
  const blobUrlsRef = useRef({})
  const durationsRef = useRef({})
  const playbackRateRef = useRef(playbackRate)
  const visitIdRef = useRef(visitId)
  const lastProgressUiRef = useRef(0)
  const lastProgressSecRef = useRef(-1)

  useEffect(() => {
    visitIdRef.current = visitId
  }, [visitId])

  const storeDuration = useCallback((idx, rawDuration) => {
    if (!rawDuration || !Number.isFinite(rawDuration) || rawDuration <= 0) {return}
    const secs = Math.floor(rawDuration)
    durationsRef.current[idx] = secs
    setDurations((prev) => ({ ...prev, [idx]: secs }))
  }, [])

  const resolvedStatus = visitId ? status : 'error'

  const fetchBlobUrl = useCallback(async (idx) => {
    if (blobUrlsRef.current[idx]) {return blobUrlsRef.current[idx]}

    const token = localStorage.getItem('token')
    const res = await fetch(`${API_BASE}/audio/${visitIdRef.current}?index=${idx}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {throw new Error('no audio')}
    const blob = await res.blob()
    if (!blob?.size) {throw new Error('empty')}

    const url = URL.createObjectURL(blob)
    blobUrlsRef.current[idx] = url
    return url
  }, [])

  // Recording count only on visit change.
  useEffect(() => {
    if (!visitId) {
      return
    }

    let cancelled = false

    setCount(1)
    setActiveIdx(0)
    setDurations({})
    durationsRef.current = {}
    setProgress(0)
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    setStatus('loading')

    Object.values(blobUrlsRef.current).forEach((url) => URL.revokeObjectURL(url))
    blobUrlsRef.current = {}

    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}/count`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d.count > 0) {setCount(d.count)}
      })
      .catch(() => {})

    return () => {
      cancelled = true
      Object.values(blobUrlsRef.current).forEach((url) => URL.revokeObjectURL(url))
      blobUrlsRef.current = {}
    }
  }, [visitId])

  // Load active recording on tab switch: fetch blob, wait for metadata, then ready.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !visitId) {return}

    let cancelled = false

    audio.pause()
    setPlaying(false)
    setProgress(0)
    setCurrentTime(0)
    audio.currentTime = 0
    setDuration(0)
    setStatus('loading')

    ;(async () => {
      try {
        const url = await fetchBlobUrl(activeIdx)
        if (cancelled) {return}

        audio.pause()
        audio.currentTime = 0
        // Read the latest speed from a ref so this (heavy) load effect doesn't
        // need `playbackRate` as a dependency and re-run on every speed change.
        audio.playbackRate = playbackRateRef.current
        audio.src = url

        let dur = await waitForAudioDuration(audio)
        if (cancelled) {return}

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
      } catch {
        if (!cancelled) {setStatus('error')}
      }
    })()

    return () => {
      cancelled = true
      audio.pause()
    }
  }, [activeIdx, visitId, durationSecs, fetchBlobUrl, storeDuration])

  // Playback events on the single main audio element.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) {return}

    const onTimeUpdate = () => {
      const dur = audio.duration
      if (!dur || !Number.isFinite(dur) || dur <= 0) {return}
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

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  useEffect(() => {
    playbackRateRef.current = playbackRate
    if (audioRef.current) {audioRef.current.playbackRate = playbackRate}
  }, [playbackRate])

  const handleTabChange = (i) => {
    if (i === activeIdx) {return}
    const audio = audioRef.current
    if (audio) {audio.pause()}
    setPlaying(false)
    setActiveIdx(i)
    onTabChange?.(i)
  }

  const toggle = () => {
    const audio = audioRef.current
    if (!audio || resolvedStatus !== 'ready') {return}
    if (isPlaying) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  const skip = (secs) => {
    const audio = audioRef.current
    if (!audio || resolvedStatus !== 'ready') {return}
    const dur = audio.duration
    if (!dur || !Number.isFinite(dur) || dur <= 0) {return}
    const t = Math.max(0, Math.min(dur, audio.currentTime + secs))
    audio.currentTime = t
    setProgress((t / dur) * 100)
    setCurrentTime(t)
  }

  const timeAtProgressX = (trackEl, clientX) => {
    const audio = audioRef.current
    if (!audio || !trackEl) {return null}
    const dur = audio.duration
    if (!dur || !Number.isFinite(dur) || dur <= 0) {return null}
    const rect = trackEl.getBoundingClientRect()
    const width = rect.width || 1
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / width))
    return { time: ratio * dur, pct: ratio * 100 }
  }

  const seek = (e) => {
    const audio = audioRef.current
    if (!audio || resolvedStatus !== 'ready') {return}
    const hit = timeAtProgressX(e.currentTarget, e.clientX)
    if (!hit) {return}
    audio.currentTime = hit.time
    setProgress(hit.pct)
    setCurrentTime(hit.time)
  }

  const handleProgressMouseMove = (e) => {
    if (resolvedStatus !== 'ready') {return}
    const hit = timeAtProgressX(e.currentTarget, e.clientX)
    if (!hit) {return}
    setScrubHover({ time: hit.time, pct: hit.pct })
  }

  const handleProgressMouseLeave = () => setScrubHover(null)

  const onSpeedChange = (e) => {
    const rate = parseFloat(e.target.value, 10)
    setPlaybackRate(rate)
    if (audioRef.current) {audioRef.current.playbackRate = rate}
  }

  const canPlay = resolvedStatus === 'ready'
  const displayCurrent = fmtSecsAudio(Math.floor(currentTime))
  const displayTotal = duration > 0 ? fmtSecsAudio(duration) : '--:--'

  return (
    <div className={`sf-audio-bar sf-audio-bar--portal${compact ? ' sf-audio-bar--compact' : ''}`}>
      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }} />
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
          🎙 Recording {activeIdx + 1}
          {count > 1 ? ` of ${count}` : ''}
        </span>
        {resolvedStatus === 'loading' ? <span className="sf-audio-bar__pill">Loading…</span> : null}
        {resolvedStatus === 'ready' ? <span className="sf-audio-bar__pill sf-audio-bar__pill--ok">Ready</span> : null}
        {resolvedStatus === 'error' ? <span className="sf-audio-bar__pill">No audio</span> : null}
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
            {resolvedStatus === 'loading' ? '⏳' : isPlaying ? '⏸' : '▶'}
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
