import { useMemo } from 'react'

// A "section header" is any line whose trimmed text ends with ':' — same convention as
// `countTemplateSections` (Clinician/index.jsx), so notes render consistently with
// however many/whatever sections a clinician's own template defines (not a fixed list).
function isHeaderLine(line) {
  const trimmed = line.trim()
  return trimmed.length > 0 && trimmed.length <= 80 && trimmed.endsWith(':')
}

/** Parse free text into an ordered list of { label, body } sections. */
function parseNote(text) {
  const raw = String(text || '').trim()
  if (!raw) {return []}

  const lines = raw.split('\n')
  const headerIdx = []
  lines.forEach((line, i) => {
    if (isHeaderLine(line)) {headerIdx.push(i)}
  })

  if (headerIdx.length === 0) {
    return [{ label: '', body: raw }]
  }

  const sections = []
  for (let i = 0; i < headerIdx.length; i += 1) {
    const start = headerIdx[i]
    const end = i + 1 < headerIdx.length ? headerIdx[i + 1] : lines.length
    const label = lines[start].trim().replace(/:$/, '')
    const body = lines.slice(start + 1, end).join('\n').trim()
    sections.push({ label, body })
  }
  return sections
}

function buildNote(sections) {
  return sections
    .map((s) => (s.label ? `${s.label}:\n\n${s.body || ''}`.trimEnd() : s.body || ''))
    .join('\n\n')
}

export default function ScribeFinalNoteEditor({ value, onChange, readOnly = false, className = '' }) {
  const sections = useMemo(() => parseNote(value), [value])

  const setBody = (index, body) => {
    const next = sections.map((s, i) => (i === index ? { ...s, body } : s))
    onChange(buildNote(next))
  }

  if (readOnly) {
    return (
      <div className={`scribe-final-note scribe-final-note--readonly ${className}`.trim()}>
        {sections.map((s, i) => (
          <div key={`${s.label}-${i}`} className="scribe-final-note__section">
            {s.label ? <div className="scribe-final-note__header">{s.label}</div> : null}
            <pre className="scribe-final-note__body">{s.body || '—'}</pre>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={`scribe-final-note ${className}`.trim()}>
      {sections.map((s, i) => (
        <div key={`${s.label}-${i}`} className="scribe-final-note__section">
          {s.label ? <div className="scribe-final-note__header">{s.label}</div> : null}
          <textarea
            className="scribe-final-note__input"
            value={s.body}
            onChange={(e) => setBody(i, e.target.value)}
            rows={3}
            spellCheck
          />
        </div>
      ))}
    </div>
  )
}
