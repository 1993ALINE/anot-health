import { useEffect, useRef, useState } from 'react'
import './RecordingVisualizer.css'

export default function RecordingVisualizer({ stream, isPaused = false, barCount = 7, theme = 'primary' }) {
  const [levels, setLevels] = useState(() => Array(barCount).fill(12))
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const animFrameRef = useRef(null)

  useEffect(() => {
    if (!stream || isPaused) {
      return
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) {
        return
      }

      const audioCtx = new AudioCtx()
      audioCtxRef.current = audioCtx

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }

      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      analyser.smoothingTimeConstant = 0.6
      analyserRef.current = analyser

      const source = audioCtx.createMediaStreamSource(stream)
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const updateLevels = () => {
        analyser.getByteFrequencyData(dataArray)
        
        const step = Math.max(1, Math.floor(dataArray.length / barCount))
        const newLevels = []

        for (let i = 0; i < barCount; i++) {
          const val = dataArray[i * step] || 0
          const pct = Math.min(100, Math.max(15, Math.round((val / 255) * 100)))
          newLevels.push(pct)
        }

        setLevels(newLevels)
        animFrameRef.current = requestAnimationFrame(updateLevels)
      }

      animFrameRef.current = requestAnimationFrame(updateLevels)
    } catch {
      // AudioContext fallback
    }

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
      }
      audioCtxRef.current = null
      analyserRef.current = null
    }
  }, [stream, isPaused, barCount])

  const activeLevels = (!stream || isPaused) ? Array(barCount).fill(8) : levels

  return (
    <div className={`rec-visualizer rec-visualizer--${theme}${isPaused ? ' rec-visualizer--paused' : ''}`} aria-hidden="true">
      {activeLevels.map((lvl, idx) => (
        <span
          key={idx}
          className="rec-visualizer__bar"
          style={{
            height: isPaused ? '4px' : `${Math.max(4, Math.round(lvl * 0.22))}px`,
          }}
        />
      ))}
    </div>
  )
}
