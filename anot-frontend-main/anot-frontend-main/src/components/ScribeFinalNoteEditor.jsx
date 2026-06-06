import { useMemo } from 'react'

const SECTIONS = [
  { label: 'CHIEF COMPLAINT', match: /CHIEF COMPLAINT/i },
  { label: 'HISTORY OF PRESENT ILLNESS (HPI)', match: /HISTORY OF PRESENT ILLNESS(?:\s*\(HPI\))?/i },
  { label: 'PHYSICAL EXAMINATION (PE)', match: /PHYSICAL EXAMINATION(?:\s*\(PE\))?/i },
  { label: 'IMAGING', match: /IMAGING/i },
  { label: 'ASSESSMENT & PLAN (A&P)', match: /ASSESSMENT\s*&\s*PLAN(?:\s*\(A&P\))?/i },
]

function parseNote(text) {
  const bodies = Object.fromEntries(SECTIONS.map((s) => [s.label, '']))
  const raw = String(text || '').trim()
  if (!raw) return bodies

  let remaining = raw
  for (let i = 0; i < SECTIONS.length; i += 1) {
    const section = SECTIONS[i]
    const next = SECTIONS[i + 1]
    const headerRe = new RegExp(`${section.match.source}\\s*:?\\s*`, 'i')
    const headerMatch = remaining.match(headerRe)
    if (!headerMatch) continue

    const start = headerMatch.index + headerMatch[0].length
    let end = remaining.length
    if (next) {
      const nextRe = new RegExp(`${next.match.source}\\s*:?`, 'i')
      const tail = remaining.slice(start)
      const nextMatch = tail.match(nextRe)
      if (nextMatch) end = start + nextMatch.index
    }
    bodies[section.label] = remaining.slice(start, end).trim()
  }

  if (!SECTIONS.some((s) => bodies[s.label]) && raw) {
    bodies[SECTIONS[0].label] = raw
  }
  return bodies
}

function buildNote(bodies) {
  return SECTIONS.map((s) => `${s.label}:\n\n${bodies[s.label] || ''}`.trimEnd()).join('\n\n')
}

export default function ScribeFinalNoteEditor({ value, onChange, readOnly = false, className = '' }) {
  const bodies = useMemo(() => parseNote(value), [value])

  const setBody = (label, body) => {
    onChange(buildNote({ ...bodies, [label]: body }))
  }

  if (readOnly) {
    return (
      <div className={`scribe-final-note scribe-final-note--readonly ${className}`.trim()}>
        {SECTIONS.map((s) => (
          <div key={s.label} className="scribe-final-note__section">
            <div className="scribe-final-note__header">{s.label}</div>
            <pre className="scribe-final-note__body">{bodies[s.label] || '—'}</pre>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={`scribe-final-note ${className}`.trim()}>
      {SECTIONS.map((s) => (
        <div key={s.label} className="scribe-final-note__section">
          <div className="scribe-final-note__header">{s.label}</div>
          <textarea
            className="scribe-final-note__input"
            value={bodies[s.label]}
            onChange={(e) => setBody(s.label, e.target.value)}
            rows={3}
            spellCheck
          />
        </div>
      ))}
    </div>
  )
}
