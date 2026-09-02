import { useState } from 'react'
import './QuickConsultationModal.css'

export default function QuickConsultationModal({
  isOpen,
  onClose,
  upcomingVisits = [],
  patients = [],
  onStartScheduledVisit,
  onStartQuickVisit,
  onStartInstantVisit,
}) {
  const [tab, setTab] = useState('scheduled') // 'scheduled' | 'new'
  const [patientSearch, setPatientSearch] = useState('')
  const [selectedPatientId, setSelectedPatientId] = useState('')
  const [name, setName] = useState('')
  const [mrn, setMrn] = useState('')
  const [visitType, setVisitType] = useState('Comprehensive Exam')
  const [consentGiven, setConsentGiven] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!isOpen) {
    return null
  }

  const filteredUpcoming = upcomingVisits.filter(v => v.status === 'upcoming')

  const filteredPatients = patientSearch.trim()
    ? patients.filter(p =>
        p.name?.toLowerCase().includes(patientSearch.toLowerCase()) ||
        p.mrn?.toLowerCase().includes(patientSearch.toLowerCase())
      )
    : patients.slice(0, 8)

  const handleStartScheduled = (visit) => {
    if (!consentGiven) {
      setError('Please confirm patient consent before recording.')
      return
    }
    setError('')
    onStartScheduledVisit(visit)
    onClose()
  }

  const handleStartInstant = () => {
    if (!consentGiven) {
      setError('Please confirm patient consent before recording.')
      return
    }
    setError('')
    onStartInstantVisit?.()
    onClose()
  }

  const handleStartNew = async (e) => {
    e.preventDefault()
    if (!consentGiven) {
      setError('Please confirm patient consent before recording.')
      return
    }
    setError('')
    setLoading(true)
    try {
      if (selectedPatientId) {
        const found = patients.find(p => String(p.id) === String(selectedPatientId))
        await onStartQuickVisit({
          patient_id: found.id,
          name: found.name,
          mrn: found.mrn,
          visit_type: visitType,
        })
      } else {
        if (!name.trim()) {
          setError('Patient name is required.')
          setLoading(false)
          return
        }
        const generatedMrn = mrn.trim() || `MRN-${Date.now().toString().slice(-6)}`
        await onStartQuickVisit({
          name: name.trim(),
          mrn: generatedMrn,
          visit_type: visitType,
        })
      }
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to start consultation')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="portal-modal-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quick-rec-modal" role="dialog" aria-modal="true" aria-labelledby="quick-rec-title">
        <div className="quick-rec-modal__header">
          <div className="quick-rec-modal__title-wrap">
            <span className="quick-rec-modal__icon">🎙</span>
            <div>
              <h2 id="quick-rec-title" className="quick-rec-modal__title">Start Patient Consultation</h2>
              <p className="quick-rec-modal__subtitle">Live recording & AI clinical documentation</p>
            </div>
          </div>
          <button type="button" className="quick-rec-modal__close" onClick={onClose} aria-label="Close modal">×</button>
        </div>

        {/* Instant Consultation (Zero Manual Input) */}
        <div className="quick-rec-instant-card">
          <div className="quick-rec-instant-card__info">
            <div className="quick-rec-instant-card__title">
              <span className="quick-rec-instant-card__badge">⚡ 1-Click Zero Typing</span>
              <strong>Instant Consultation (Dictate Patient)</strong>
            </div>
            <p className="quick-rec-instant-card__desc">
              Start recording immediately. Simply dictate the patient's name, MRN, and details during the consultation — AI will extract and structure them automatically.
            </p>
          </div>
          <button
            type="button"
            className="quick-rec-btn quick-rec-btn--instant"
            onClick={handleStartInstant}
            title="Start consultation immediately without entering patient details manually"
          >
            🎙 Instant Record
          </button>
        </div>

        <div className="quick-rec-divider">
          <span>or choose scheduled / manual patient</span>
        </div>

        {/* Tab switcher */}
        <div className="quick-rec-modal__tabs">
          <button
            type="button"
            className={`quick-rec-modal__tab ${tab === 'scheduled' ? 'quick-rec-modal__tab--active' : ''}`}
            onClick={() => { setTab('scheduled'); setError('') }}
          >
            Today's Patients ({filteredUpcoming.length})
          </button>
          <button
            type="button"
            className={`quick-rec-modal__tab ${tab === 'new' ? 'quick-rec-modal__tab--active' : ''}`}
            onClick={() => { setTab('new'); setError('') }}
          >
            + New / Walk-In Patient
          </button>
        </div>

        {error ? <div className="quick-rec-modal__error" role="alert">{error}</div> : null}

        {tab === 'scheduled' ? (
          <div className="quick-rec-modal__body">
            {filteredUpcoming.length === 0 ? (
              <div className="quick-rec-modal__empty">
                <p>No upcoming patients scheduled for today.</p>
                <button
                  type="button"
                  className="quick-rec-btn quick-rec-btn--primary"
                  onClick={() => setTab('new')}
                >
                  Start Walk-In Consultation
                </button>
              </div>
            ) : (
              <div className="quick-rec-modal__list">
                {filteredUpcoming.map((visit) => (
                  <div key={visit.id} className="quick-rec-item">
                    <div className="quick-rec-item__info">
                      <div className="quick-rec-item__name">{visit.patient_name}</div>
                      <div className="quick-rec-item__meta">
                        {visit.visit_time ? `${visit.visit_time} · ` : ''}
                        {visit.mrn ? `MRN: ${visit.mrn} · ` : ''}
                        {visit.visit_type || 'Follow-up'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="quick-rec-btn quick-rec-btn--record"
                      onClick={() => handleStartScheduled(visit)}
                    >
                      🎙 Record
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <form className="quick-rec-modal__form" onSubmit={handleStartNew}>
            {patients.length > 0 ? (
              <div className="quick-rec-form-group">
                <label className="quick-rec-label" htmlFor="quick-pt-search">Search Existing Patient (Optional)</label>
                <input
                  id="quick-pt-search"
                  className="quick-rec-input"
                  type="text"
                  placeholder="Search by name or MRN..."
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                />
                {patientSearch.trim() && filteredPatients.length > 0 ? (
                  <div className="quick-rec-patient-dropdown">
                    {filteredPatients.map(p => (
                      <div
                        key={p.id}
                        className={`quick-rec-patient-option ${selectedPatientId === p.id ? 'quick-rec-patient-option--selected' : ''}`}
                        onClick={() => {
                          setSelectedPatientId(p.id)
                          setName(p.name)
                          setMrn(p.mrn)
                          setPatientSearch('')
                        }}
                      >
                        <strong>{p.name}</strong> <span style={{ color: '#64748b' }}>({p.mrn})</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="quick-rec-form-grid">
              <div className="quick-rec-form-group">
                <label className="quick-rec-label" htmlFor="quick-pt-name">Patient Name *</label>
                <input
                  id="quick-pt-name"
                  className="quick-rec-input"
                  type="text"
                  placeholder="e.g. Sarah Jenkins"
                  value={name}
                  onChange={(e) => { setName(e.target.value); setSelectedPatientId('') }}
                  required
                />
              </div>
              <div className="quick-rec-form-group">
                <label className="quick-rec-label" htmlFor="quick-pt-mrn">MRN (Auto-generated if empty)</label>
                <input
                  id="quick-pt-mrn"
                  className="quick-rec-input"
                  type="text"
                  placeholder="e.g. MRN-1082"
                  value={mrn}
                  onChange={(e) => setMrn(e.target.value)}
                />
              </div>
            </div>

            <div className="quick-rec-form-group">
              <label className="quick-rec-label" htmlFor="quick-visit-type">Visit Type</label>
              <select
                id="quick-visit-type"
                className="quick-rec-input"
                value={visitType}
                onChange={(e) => setVisitType(e.target.value)}
              >
                <option value="Comprehensive Exam">Comprehensive Exam</option>
                <option value="Follow-up">Follow-up</option>
                <option value="New Patient">New Patient</option>
                <option value="Urgent Care">Urgent Care</option>
                <option value="Telemedicine">Telemedicine</option>
              </select>
            </div>

            <div className="quick-rec-modal__footer">
              <button
                type="button"
                className="quick-rec-btn quick-rec-btn--ghost"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="quick-rec-btn quick-rec-btn--record"
                disabled={loading}
              >
                {loading ? 'Starting…' : '🎙 Start Recording'}
              </button>
            </div>
          </form>
        )}

        {/* Consent row */}
        <div className="quick-rec-consent">
          <label className="quick-rec-consent__label">
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(e) => setConsentGiven(e.target.checked)}
            />
            <span>Patient verbal consent recorded for audio capture</span>
          </label>
        </div>
      </div>
    </div>
  )
}
