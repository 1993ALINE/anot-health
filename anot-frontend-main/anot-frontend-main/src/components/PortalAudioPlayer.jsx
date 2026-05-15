import { useState, useEffect, useRef } from 'react'
import { API_BASE } from '../services/api'
import { fmtSecsAudio } from '../utils/timeFormat'

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

export default function PortalAudioPlayer({ visitId, durationSecs = 0, onTabChange, compact = true }) {
  const [count, setCount] = useState(1)
  const [activeIdx, setActiveIdx] = useState(0)
  const [status, setStatus] = useState('loading')
  const [isPlaying, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(durationSecs || 0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const audioRef = useRef(null)
  const blobRef = useRef(null)
  const maxTimeRef = useRef(durationSecs || 0)

  useEffect(() => {
    if (!visitId) return
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}/count`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.count > 0) setCount(d.count)
      })
      .catch(() => {})
  }, [visitId])

  useEffect(() => {
    if (!visitId) {
      setStatus('error')
      return
    }
    const audioEl = audioRef.current
    setStatus('loading')
    setPlaying(false)
    setCurrent(0)
    const initDur = activeIdx === 0 ? durationSecs || 0 : 0
    setDuration(initDur)
    maxTimeRef.current = initDur
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current)
      blobRef.current = null
    }
    const token = localStorage.getItem('token')
    fetch(`${API_BASE}/audio/${visitId}?index=${activeIdx}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('no audio')
        return res.blob()
      })
      .then((blob) => {
        if (!blob?.size) throw new Error('empty')
        blobRef.current = URL.createObjectURL(blob)
        if (audioEl) {
          audioEl.src = blobRef.current
          audioEl.load()
        }
        setStatus('ready')
      })
      .catch(() => setStatus('error'))
    return () => {
      if (audioEl) {
        audioEl.pause()
        audioEl.src = ''
      }
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current)
        blobRef.current = null
      }
    }
  }, [visitId, activeIdx, durationSecs])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = playbackRate
    const onMeta = () => {
      const dur = audio.duration
      if (dur && isFinite(dur) && dur > 0) {
        const floored = Math.floor(dur)
        setDuration(floored)
        maxTimeRef.current = floored
      }
    }
    const onTime = () => {
      const cur = Math.floor(audio.currentTime)
      setCurrent(cur)
      if (cur > maxTimeRef.current) {
        maxTimeRef.current = cur
        setDuration(cur)
      }
    }
    const onEnded = () => {
      setPlaying(false)
      setCurrent(0)
      if (maxTimeRef.current > 0) setDuration(maxTimeRef.current)
    }
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
    }
  }, [playbackRate])

  const handleTabChange = (i) => {
    setActiveIdx(i)
    onTabChange?.(i)
  }

  const toggle = () => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') return
    if (isPlaying) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  const skip = (secs) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready') return
    const max = maxTimeRef.current || duration || 0
    const t = Math.max(0, Math.min(max, audio.currentTime + secs))
    audio.currentTime = t
    setCurrent(Math.floor(t))
  }

  const seek = (e) => {
    const audio = audioRef.current
    if (!audio || status !== 'ready' || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = Math.round(((e.clientX - rect.left) / rect.width) * duration)
    audio.currentTime = t
    setCurrent(t)
  }

  const onSpeedChange = (e) => {
    const rate = parseFloat(e.target.value, 10)
    setPlaybackRate(rate)
    if (audioRef.current) audioRef.current.playbackRate = rate
  }

  const canPlay = status === 'ready'
  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0
  const totalStr = duration > 0 ? fmtSecsAudio(duration) : '--:--'

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
        {status === 'loading' ? <span className="sf-audio-bar__pill">Loading…</span> : null}
        {status === 'ready' ? <span className="sf-audio-bar__pill sf-audio-bar__pill--ok">Ready</span> : null}
        {status === 'error' ? <span className="sf-audio-bar__pill">No audio</span> : null}
        <span className="sf-audio-timer" aria-live="polite">
          <span className="sf-audio-timer__cur">{fmtSecsAudio(current)}</span>
          <span className="sf-audio-timer__sep"> / </span>
          <span className="sf-audio-timer__total">{totalStr}</span>
        </span>
      </div>
      <div className="sf-audio-bar__row sf-audio-bar__row--controls">
        <div className="sf-audio-bar__transport">
          <button type="button" className="sf-skip-btn" onClick={() => skip(-5)} disabled={!canPlay}>
            −5s
          </button>
          <button type="button" className="sf-play-btn" onClick={toggle} disabled={!canPlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {status === 'loading' ? '⏳' : isPlaying ? '⏸' : '▶'}
          </button>
          <button type="button" className="sf-skip-btn" onClick={() => skip(5)} disabled={!canPlay}>
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
            className="sf-progress-track"
            onClick={canPlay ? seek : undefined}
            role={canPlay ? 'slider' : undefined}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={current}
          >
            <div className="sf-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>
    </div>
  )
}
