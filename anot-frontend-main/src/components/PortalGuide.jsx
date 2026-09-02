import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import './portalGuide.css'

const GUIDES = {
  clinician: {
    title: 'How the Clinician portal works',
    sections: [
      { heading: 'Schedule', body: 'Use the day strip to pick a date, start encounters to record audio, and add patients. Recordings upload when you end the visit.' },
      { heading: 'Notes', body: 'Use All, Pending, and Completed tabs to track encounters. When your scribe submits a note, open it from Ready for Review. Preview the note only after the scribe has uploaded it.' },
      { heading: 'Templates', body: 'Create visit templates that scribes see as a reference when writing the final note for that visit type.' },
      { heading: 'Recordings offline', body: 'If the internet drops during upload, your recording is saved locally and retried when you are back online.' },
    ],
  },
  scribe: {
    title: 'How the Scribe portal works',
    sections: [
      { heading: 'Recordings list', body: 'Choose a clinician and date, then open a visit to transcribe audio, edit the AI draft, and write the final note.' },
      { heading: 'Transcription', body: 'Run “Transcribe audio” while processing; once status is Completed the button is hidden. “Auto” means a single recording segment.' },
      { heading: 'Final note', body: 'Use the clinician’s template as a guide. Expand any panel for full-height editing. Save draft or upload to EMR when ready.' },
      { heading: 'Audio player', body: 'Use playback speed controls. Timer shows current / total (MM:SS / MM:SS).' },
    ],
  },
  qps: {
    title: 'How the QPS portal works',
    sections: [
      { heading: 'Review notes', body: 'Open submitted notes to read transcription and the scribe’s final note alongside encounter audio.' },
      { heading: 'Grading', body: 'Score rubric dimensions and add a comment before submitting the grade.' },
      { heading: 'Templates', body: 'The clinician’s template for that visit type is shown for context while you review documentation.' },
    ],
  },
}

export default function PortalGuide({ role = 'clinician', className = '' }) {
  const [open, setOpen] = useState(false)
  const guide = GUIDES[role] || GUIDES.clinician
  const close = () => setOpen(false)

  useEffect(() => {
    if (!open) {return undefined}
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') {close()}
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`portal-guide-trigger ${className}`.trim()}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="portal-guide-trigger__ico" aria-hidden>?</span>
        Platform guide
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div className="portal-guide-overlay" role="presentation" onClick={close}>
              <GuideDialog onClose={close} title={guide.title} sections={guide.sections} />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function GuideDialog({ onClose, title, sections }) {
  return (
    <div
      className="portal-guide-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portal-guide-title"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="portal-guide-modal__head">
        <h2 id="portal-guide-title">{title}</h2>
        <button type="button" className="portal-guide-modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="portal-guide-modal__body">
        {sections.map((s) => (
          <section key={s.heading} className="portal-guide-section">
            <h3>{s.heading}</h3>
            <p>{s.body}</p>
          </section>
        ))}
      </div>
    </div>
  )
}
