import { useState, useMemo } from 'react'
import { parseNote, buildNote } from '../utils/noteParser'
import './ScribeFinalNoteEditor.css'

export default function ScribeFinalNoteEditor({ value, onChange, readOnly = false, className = '' }) {
  const sections = useMemo(() => parseNote(value), [value])
  const [copiedIdx, setCopiedIdx] = useState(null)

  const setBody = (index, body) => {
    const next = sections.map((s, i) => (i === index ? { ...s, body } : s))
    if (onChange) {
      onChange(buildNote(next))
    }
  }

  const copySection = (idx, text) => {
    if (!text) { return }
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 2000)
    }).catch(() => {})
  }

  if (readOnly) {
    return (
      <div className={`scribe-final-note scribe-final-note--readonly ${className}`.trim()}>
        {sections.map((s, i) => {
          const isMuted = !s.body || s.body.trim().toLowerCase() === 'not mentioned.' || s.body.trim().toLowerCase() === 'none reported.'
          const isCopied = copiedIdx === i
          return (
            <div key={`${s.label}-${i}`} className="scribe-final-note__section">
              {s.label ? (
                <div className="scribe-final-note__header">
                  <span className="scribe-final-note__badge">{s.label}</span>
                  {s.body && !isMuted ? (
                    <button
                      type="button"
                      className={`scribe-final-note__copy-btn ${isCopied ? 'scribe-final-note__copy-btn--copied' : ''}`}
                      onClick={() => copySection(i, s.body)}
                      title={`Copy ${s.label} to clipboard`}
                    >
                      {isCopied ? '✓ Copied' : '📋 Copy'}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className={`scribe-final-note__body ${isMuted ? 'scribe-final-note__body--muted' : ''}`}>
                {s.body || 'Not mentioned.'}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={`scribe-final-note ${className}`.trim()}>
      {sections.map((s, i) => (
        <div key={`${s.label}-${i}`} className="scribe-final-note__section">
          {s.label ? (
            <div className="scribe-final-note__header">
              <span className="scribe-final-note__badge">{s.label}</span>
            </div>
          ) : null}
          <textarea
            className="scribe-final-note__input"
            value={s.body}
            onChange={(e) => setBody(i, e.target.value)}
            rows={Math.max(2, (s.body || '').split('\n').length + 1)}
            spellCheck
            placeholder={`Enter ${s.label || 'section content'}…`}
          />
        </div>
      ))}
    </div>
  )
}
