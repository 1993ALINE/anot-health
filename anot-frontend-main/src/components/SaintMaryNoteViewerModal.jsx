import { useState } from 'react'
import { parseNote } from '../utils/noteParser'
import { cleanAiDraftForDisplay } from '../utils/aiDraftFormat'
import { notesAPI } from '../services/api'
import './SaintMaryNoteViewerModal.css'

export default function SaintMaryNoteViewerModal({ noteData, onClose, onNoteUpdated, showToast }) {
  const [activeTab, setActiveTab] = useState('formatted') // 'formatted' | 'raw' | 'transcript'
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(() => noteData?.final_note || noteData?.ai_draft || '')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!noteData) {return null}

  const rawNoteText = noteData.final_note || noteData.ai_draft || ''
  const displayText = cleanAiDraftForDisplay(rawNoteText)
  const sections = parseNote(displayText)
  const transcriptText = noteData.transcription || noteData.transcript || ''

  const handleCopy = (text) => {
    const textToCopy = text || displayText
    if (!textToCopy) {
      showToast?.('No note content to copy.', 'warn')
      return
    }
    navigator.clipboard?.writeText(textToCopy).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
      showToast?.('✓ Clinical note copied to clipboard — ready to paste into EMR!')
    })
  }

  const handleSaveEdit = async () => {
    setSaving(true)
    try {
      if (noteData.note_id) {
        await notesAPI.updateNote(noteData.note_id, editText)
      } else if (noteData.id && noteData.visit_id && noteData.id !== noteData.visit_id) {
        await notesAPI.updateNote(noteData.id, editText)
      } else {
        const vId = noteData.visit_id || noteData.id
        try {
          const res = await notesAPI.getByVisit(vId)
          if (res?.note?.id) {
            await notesAPI.updateNote(res.note.id, editText)
          } else {
            await notesAPI.saveDraft(vId, editText, transcriptText, noteData.ai_draft)
          }
        } catch {
          await notesAPI.saveDraft(vId, editText, transcriptText, noteData.ai_draft)
        }
      }
      showToast?.('✓ Clinical note saved successfully')
      setIsEditing(false)
      onNoteUpdated?.({ ...noteData, final_note: editText })
    } catch (err) {
      showToast?.(err?.message || 'Failed to save note update', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="sm-note-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sm-note-title">
      <div className="sm-note-modal">
        {/* Header */}
        <div className="sm-note-modal__header">
          <div className="sm-note-modal__patient-info">
            <div className="sm-note-modal__avatar">
              {(noteData.patient_name || 'PT').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="sm-note-modal__title-row">
                <h2 id="sm-note-title" className="sm-note-modal__patient-name">
                  {noteData.patient_name || 'Patient Encounter'}
                </h2>
                <span className="sm-note-modal__badge sm-note-modal__badge--clinic">
                  {noteData.clinic_name || 'Anot Health'}
                </span>
                {(() => {
                  const isSigned = noteData.status === 'completed' || noteData.status === 'uploaded' || noteData.note_status === 'uploaded' || Boolean(noteData.locked_at)
                  return (
                    <span className={`sm-note-modal__badge sm-note-modal__badge--status sm-note-modal__badge--${isSigned ? 'ready' : (noteData.status || 'draft')}`}>
                      {isSigned ? '🔒 Signed & Locked' : (noteData.status || 'Draft Note')}
                    </span>
                  )
                })()}
              </div>
              <div className="sm-note-modal__meta-row">
                {noteData.mrn && <span><strong>MRN:</strong> {noteData.mrn}</span>}
                <span><strong>Date:</strong> {noteData.visit_date || 'Today'} {noteData.visit_time ? `at ${noteData.visit_time}` : ''}</span>
                <span><strong>Encounter:</strong> {noteData.visit_type || 'Consultation'}</span>
                {noteData.scribe_name && <span><strong>Scribe:</strong> {noteData.scribe_name}</span>}
              </div>
            </div>
          </div>

          <div className="sm-note-modal__header-actions">
            <button
              type="button"
              className={`sm-note-btn sm-note-btn--copy ${copied ? 'sm-note-btn--copied' : ''}`}
              onClick={() => handleCopy(isEditing ? editText : displayText)}
              title="Copy entire note to clipboard for EMR"
            >
              {copied ? '✓ Copied to EMR!' : '📋 Copy to EMR'}
            </button>
            <button
              type="button"
              className="sm-note-btn sm-note-btn--secondary"
              onClick={handlePrint}
              title="Print Clinical Note"
            >
              🖨 Print
            </button>
            <button
              type="button"
              className="sm-note-modal__close-btn"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="sm-note-modal__tabs">
          <button
            type="button"
            className={`sm-note-modal__tab ${activeTab === 'formatted' ? 'sm-note-modal__tab--active' : ''}`}
            onClick={() => { setActiveTab('formatted'); setIsEditing(false) }}
          >
            📋 Structured SOAP Note
          </button>
          <button
            type="button"
            className={`sm-note-modal__tab ${activeTab === 'raw' ? 'sm-note-modal__tab--active' : ''}`}
            onClick={() => setActiveTab('raw')}
          >
            📄 Plain Text &amp; Editor
          </button>
          <button
            type="button"
            className={`sm-note-modal__tab ${activeTab === 'transcript' ? 'sm-note-modal__tab--active' : ''}`}
            onClick={() => { setActiveTab('transcript'); setIsEditing(false) }}
          >
            🎙 Audio Transcript {transcriptText ? '✓' : ''}
          </button>
        </div>

        {/* Content Body */}
        <div className="sm-note-modal__body">
          {activeTab === 'formatted' && (
            <div className="sm-note-formatted">
              {!displayText ? (
                <div className="sm-note-empty">
                  <span className="sm-note-empty__icon">⏳</span>
                  <h3>Note In Progress</h3>
                  <p>The audio recording for this visit has been received and Saint Mary AI is generating the structured clinical documentation.</p>
                </div>
              ) : (
                <div className="sm-note-sections-grid">
                  {sections.map((sec, idx) => (
                    <div key={idx} className="sm-note-section-card">
                      <div className="sm-note-section-card__header">
                        <span className="sm-note-section-card__icon">
                          {sec.label.toUpperCase().includes('SUBJECTIVE') || sec.label.toUpperCase().includes('CHIEF') || sec.label.toUpperCase().includes('HPI') ? '🗣' :
                           sec.label.toUpperCase().includes('OBJECTIVE') || sec.label.toUpperCase().includes('EXAM') || sec.label.toUpperCase().includes('VITAL') ? '🩺' :
                           sec.label.toUpperCase().includes('ASSESSMENT') || sec.label.toUpperCase().includes('DIAGNOSIS') ? '🧠' :
                           sec.label.toUpperCase().includes('PLAN') || sec.label.toUpperCase().includes('MEDICATION') ? '📝' : '📌'}
                        </span>
                        <h4 className="sm-note-section-card__title">{sec.label || 'Clinical Summary'}</h4>
                      </div>
                      <div className="sm-note-section-card__content">
                        <pre>{sec.body}</pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'raw' && (
            <div className="sm-note-raw-view">
              <div className="sm-note-raw-toolbar">
                <span>{isEditing ? 'Editing clinical note:' : 'Full note text:'}</span>
                {!isEditing ? (
                  <button
                    type="button"
                    className="sm-note-btn sm-note-btn--sm"
                    onClick={() => {
                      setEditText(displayText)
                      setIsEditing(true)
                    }}
                  >
                    ✏️ Edit / Add Addendum
                  </button>
                ) : (
                  <div className="sm-note-edit-actions">
                    <button
                      type="button"
                      className="sm-note-btn sm-note-btn--primary sm-note-btn--sm"
                      onClick={handleSaveEdit}
                      disabled={saving}
                    >
                      {saving ? 'Saving…' : '✓ Save Changes'}
                    </button>
                    <button
                      type="button"
                      className="sm-note-btn sm-note-btn--secondary sm-note-btn--sm"
                      onClick={() => setIsEditing(false)}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              {isEditing ? (
                <textarea
                  className="sm-note-raw-textarea"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={16}
                  placeholder="Type or modify clinical note here…"
                />
              ) : (
                <pre className="sm-note-raw-pre">{displayText || 'No note text available.'}</pre>
              )}
            </div>
          )}

          {activeTab === 'transcript' && (
            <div className="sm-note-transcript-view">
              <div className="sm-note-transcript-header">
                <h4>Full Encounter Audio Transcription</h4>
                <p>Recorded during consultation at {noteData.clinic_name || 'Anot Health'}</p>
              </div>
              {transcriptText ? (
                <div className="sm-note-transcript-content">
                  <pre>{transcriptText}</pre>
                </div>
              ) : (
                <div className="sm-note-empty">
                  <span className="sm-note-empty__icon">🎙</span>
                  <h3>No Transcript Available</h3>
                  <p>Transcription has not yet been processed for this encounter or no audio was uploaded.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sm-note-modal__footer">
          <span className="sm-note-modal__footer-tag">
            🏥 {noteData.clinic_name || 'Anot Health'} · HIPAA &amp; PIPEDA Compliant
          </span>
          <button
            type="button"
            className="sm-note-btn sm-note-btn--secondary"
            onClick={onClose}
          >
            Close Note
          </button>
        </div>
      </div>
    </div>
  )
}
