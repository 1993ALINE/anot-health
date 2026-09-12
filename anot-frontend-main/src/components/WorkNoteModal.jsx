import { useState, useMemo } from 'react'
import './WorkNoteModal.css'

function getNextDateStr(baseDateStr, daysToAdd = 1) {
  try {
    const base = baseDateStr ? new Date(baseDateStr) : new Date()
    if (isNaN(base.getTime())) return ''
    const next = new Date(base)
    next.setDate(next.getDate() + daysToAdd)
    return next.toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

function getNextMondayStr(baseDateStr) {
  try {
    const base = baseDateStr ? new Date(baseDateStr) : new Date()
    if (isNaN(base.getTime())) return ''
    const day = base.getDay() // 0 is Sun, 1 is Mon
    const daysUntilMonday = day === 0 ? 1 : (8 - day)
    const next = new Date(base)
    next.setDate(next.getDate() + daysUntilMonday)
    return next.toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

function extractDiagnosisFromNote(noteText) {
  if (!noteText) return ''
  const clean = String(noteText)
  
  // Try to find Assessment or Diagnosis line
  const assessMatch = clean.match(/(?:ASSESSMENT|IMPRESSION|DIAGNOSIS|A&P)[\s:]*([^\n]+(?:\n[^\n]+)?)/i)
  if (assessMatch && assessMatch[1]) {
    const line = assessMatch[1].trim()
      .replace(/^[0-9•\-\*.\s]+/, '')
      .replace(/^(Assessment|Plan|Impression):\s*/i, '')
      .trim()
    if (line && line.length > 3 && !line.toUpperCase().includes('PLAN')) {
      return line.length > 80 ? line.slice(0, 80) + '…' : line
    }
  }

  // Try Chief Complaint
  const ccMatch = clean.match(/(?:CHIEF\s+COMPLAINT|REASON\s+FOR\s+VISIT)[\s:]*([^\n]+)/i)
  if (ccMatch && ccMatch[1]) {
    const line = ccMatch[1].trim().replace(/^[0-9•\-\*.\s]+/, '')
    if (line && line.length > 3) {
      return line.length > 80 ? line.slice(0, 80) + '…' : line
    }
  }

  return 'Medical evaluation and treatment'
}

function extractPatientNameFromNote(noteText) {
  if (!noteText) return ''
  const m = noteText.match(/(?:patient\s+name|patient):\s*([^\n,]+)/i) ||
            noteText.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+),\s+a\s+\d+/m)
  if (m && m[1]) {
    const clean = m[1].trim()
    if (clean && !/^(the\s+patient|patient|unknown)$/i.test(clean)) {
      return clean
    }
  }
  return ''
}

export default function WorkNoteModal({
  isOpen,
  onClose,
  patient,
  clinician,
  noteText = '',
  clinicName = 'Anot Health Family Practice',
}) {
  const extractedName = useMemo(() => extractPatientNameFromNote(noteText), [noteText])
  const initialPatientName = (patient?.patient_name && patient.patient_name !== 'Patient')
    ? patient.patient_name
    : (patient?.name && patient.name !== 'Patient')
    ? patient.name
    : (extractedName || 'Patient')
  const rawDate = patient?.visit_date ? String(patient.visit_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
  const initialClinicianName = clinician?.name ? (clinician.name.startsWith('Dr.') ? clinician.name : `Dr. ${clinician.name}`) : 'Dr. A. McKnight, MD'
  const specialty = clinician?.specialty || 'Family Physician'

  const defaultDiagnosis = useMemo(() => extractDiagnosisFromNote(noteText), [noteText])

  const [patientName, setPatientName] = useState(initialPatientName)
  const [clinicianName, setClinicianName] = useState(initialClinicianName)
  const [excuseType, setExcuseType] = useState('off-work') // 'off-work' | 'modified' | 'cleared'
  const [startDate, setStartDate] = useState(rawDate)
  const [returnDate, setReturnDate] = useState(() => getNextDateStr(rawDate, 2))
  const [diagnosis, setDiagnosis] = useState(defaultDiagnosis || 'Acute medical condition')
  const [includeDiagnosis, setIncludeDiagnosis] = useState(false)
  const [restrictions, setRestrictions] = useState('Light duty only. No lifting over 10 lbs. Seated work as needed.')
  const [customNote, setCustomNote] = useState('')
  const [copied, setCopied] = useState(false)

  if (!isOpen) return null

  const handlePresetDays = (days) => {
    setReturnDate(getNextDateStr(startDate, days))
  }

  const handleNextMonday = () => {
    setReturnDate(getNextMondayStr(startDate))
  }

  const formatDisplayDate = (dStr) => {
    if (!dStr) return 'N/A'
    try {
      const [y, m, d] = dStr.split('-').map(Number)
      const dt = new Date(y, m - 1, d)
      return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    } catch {
      return dStr
    }
  }

  // Generate formal letter text
  const generateLetterText = () => {
    const formattedEvalDate = formatDisplayDate(startDate)
    const formattedReturnDate = formatDisplayDate(returnDate)

    let bodyParagraph = ''
    if (excuseType === 'off-work') {
      bodyParagraph = `Due to a medical condition${includeDiagnosis && diagnosis ? ` (${diagnosis})` : ''}, the patient is temporarily incapacitated and is excused from work/school from ${formattedEvalDate} through ${formattedReturnDate}. The patient may resume normal duties on ${formattedReturnDate}.`
    } else if (excuseType === 'modified') {
      bodyParagraph = `The patient was evaluated in our clinic on ${formattedEvalDate} and is cleared to perform modified/light work duties starting ${formattedReturnDate}.\n\nSpecific Medical Restrictions:\n• ${restrictions}`
    } else {
      bodyParagraph = `The patient was evaluated in our clinic on ${formattedEvalDate} and has completed their medical examination. The patient is medically cleared to return to work/school immediately with no physical or cognitive restrictions.`
    }

    if (customNote.trim()) {
      bodyParagraph += `\n\nAdditional Clinical Instructions:\n${customNote.trim()}`
    }

    return `${clinicName.toUpperCase()}
123 Health Sciences Blvd • Suite 400
Phone: (555) 234-5678 • Fax: (555) 234-5679

==================================================
              MEDICAL EXCUSE / WORK NOTE
==================================================

Date of Notice: ${formatDisplayDate(rawDate)}

To Whom It May Concern:

Patient Name: ${patientName}
Date of Evaluation: ${formattedEvalDate}

This letter certifies that ${patientName} was examined at our medical facility on ${formattedEvalDate}.

${bodyParagraph}

If you have any questions or require further medical verification, please do not hesitate to contact our clinic.

Sincerely,

${clinicianName}
${specialty}
${clinicName}
License / Provider ID: Active on file`
  }

  const handleCopy = () => {
    const text = generateLetterText()
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    }).catch(() => {})
  }

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="sm-work-note-overlay" role="dialog" aria-modal="true" aria-labelledby="work-note-title">
      <div className="sm-work-note-modal">
        {/* Header */}
        <div className="sm-work-note-modal__header">
          <div className="sm-work-note-modal__title-group">
            <span className="sm-work-note-modal__icon">📄</span>
            <div>
              <h2 id="work-note-title" className="sm-work-note-modal__title">
                Medical Work &amp; School Excuse Note
              </h2>
              <p className="sm-work-note-modal__subtitle">
                Official medical certificate for <strong>{patientName}</strong> • Encounter: {formatDisplayDate(startDate)}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="sm-work-note-modal__close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* 2-Column Content: Form Controls (Left) + Live Certificate Preview (Right) */}
        <div className="sm-work-note-modal__content">
          {/* Controls Column */}
          <div className="sm-work-note-controls">
            <div className="sm-wn-dates-grid">
              <div className="sm-wn-field">
                <label className="sm-wn-label">Patient Name</label>
                <input
                  type="text"
                  className="sm-wn-input"
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="Patient Name"
                />
              </div>
              <div className="sm-wn-field">
                <label className="sm-wn-label">Provider Name</label>
                <input
                  type="text"
                  className="sm-wn-input"
                  value={clinicianName}
                  onChange={(e) => setClinicianName(e.target.value)}
                  placeholder="Provider Name"
                />
              </div>
            </div>

            <div className="sm-wn-field">
              <label className="sm-wn-label">Work / Duty Status</label>
              <div className="sm-wn-status-pills">
                <button
                  type="button"
                  className={`sm-wn-pill ${excuseType === 'off-work' ? 'sm-wn-pill--active sm-wn-pill--danger' : ''}`}
                  onClick={() => setExcuseType('off-work')}
                >
                  🛑 Off Work (Excused)
                </button>
                <button
                  type="button"
                  className={`sm-wn-pill ${excuseType === 'modified' ? 'sm-wn-pill--active sm-wn-pill--warn' : ''}`}
                  onClick={() => setExcuseType('modified')}
                >
                  ⚠️ Modified / Light Duty
                </button>
                <button
                  type="button"
                  className={`sm-wn-pill ${excuseType === 'cleared' ? 'sm-wn-pill--active sm-wn-pill--success' : ''}`}
                  onClick={() => setExcuseType('cleared')}
                >
                  ✓ Cleared (Full Duty)
                </button>
              </div>
            </div>

            <div className="sm-wn-dates-grid">
              <div className="sm-wn-field">
                <label className="sm-wn-label">Excused From</label>
                <input
                  type="date"
                  className="sm-wn-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              {excuseType !== 'cleared' && (
                <div className="sm-wn-field">
                  <label className="sm-wn-label">Return to Work Date</label>
                  <input
                    type="date"
                    className="sm-wn-input"
                    value={returnDate}
                    onChange={(e) => setReturnDate(e.target.value)}
                  />
                </div>
              )}
            </div>

            {excuseType !== 'cleared' && (
              <div className="sm-wn-field">
                <label className="sm-wn-label sm-wn-label--sub">Quick Presets</label>
                <div className="sm-wn-quick-days">
                  <button type="button" className="sm-wn-btn-tag" onClick={() => handlePresetDays(1)}>Tomorrow (+1d)</button>
                  <button type="button" className="sm-wn-btn-tag" onClick={() => handlePresetDays(2)}>2 Days (+2d)</button>
                  <button type="button" className="sm-wn-btn-tag" onClick={() => handlePresetDays(3)}>3 Days (+3d)</button>
                  <button type="button" className="sm-wn-btn-tag" onClick={() => handlePresetDays(5)}>5 Days (+5d)</button>
                  <button type="button" className="sm-wn-btn-tag" onClick={handleNextMonday}>Next Monday</button>
                </div>
              </div>
            )}

            {excuseType === 'modified' && (
              <div className="sm-wn-field">
                <label className="sm-wn-label">Workplace Restrictions</label>
                <textarea
                  className="sm-wn-textarea"
                  rows={3}
                  value={restrictions}
                  onChange={(e) => setRestrictions(e.target.value)}
                  placeholder="e.g. No lifting over 15 lbs, seated work only, frequent standing breaks..."
                />
              </div>
            )}

            <div className="sm-wn-field">
              <div className="sm-wn-checkbox-row">
                <label className="sm-wn-checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeDiagnosis}
                    onChange={(e) => setIncludeDiagnosis(e.target.checked)}
                  />
                  <span>Include medical reason/diagnosis in note (optional)</span>
                </label>
              </div>
              {includeDiagnosis && (
                <input
                  type="text"
                  className="sm-wn-input sm-wn-input--diag"
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="e.g. Acute gout flare, viral gastroenteritis, right ankle sprain"
                />
              )}
            </div>

            <div className="sm-wn-field">
              <label className="sm-wn-label">Additional Instructions / Notes (Optional)</label>
              <textarea
                className="sm-wn-textarea"
                rows={2}
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                placeholder="e.g. Re-evaluation scheduled in 1 week. Please contact clinic with questions."
              />
            </div>
          </div>

          {/* Certificate Live Preview Column */}
          <div className="sm-work-note-preview-pane">
            <div className="sm-wn-preview-header">
              <span className="sm-wn-preview-label">Live Certificate Preview</span>
              <span className="sm-wn-preview-badge">Official Letterhead</span>
            </div>
            
            <div className="sm-wn-certificate" id="printable-work-note">
              <div className="sm-wn-cert-header">
                <div className="sm-wn-cert-logo-mark">AH</div>
                <div className="sm-wn-cert-clinic-meta">
                  <h3 className="sm-wn-cert-clinic-name">{clinicName}</h3>
                  <p>123 Health Sciences Blvd • Suite 400 • Medical Office Building</p>
                  <p>Tel: (555) 234-5678 • Secure Fax: (555) 234-5679</p>
                </div>
              </div>

              <div className="sm-wn-cert-divider" />

              <div className="sm-wn-cert-title-badge">
                MEDICAL EXCUSE &amp; RETURN TO WORK CERTIFICATE
              </div>

              <div className="sm-wn-cert-meta-grid">
                <div><strong>Date Issued:</strong> {formatDisplayDate(rawDate)}</div>
                <div><strong>Patient Name:</strong> {patientName}</div>
                <div><strong>Encounter Date:</strong> {formatDisplayDate(startDate)}</div>
                {patient?.mrn && <div><strong>MRN:</strong> {patient.mrn}</div>}
              </div>

              <div className="sm-wn-cert-body">
                <p className="sm-wn-cert-salutation">To Whom It May Concern,</p>
                <p>
                  Please be advised that <strong>{patientName}</strong> was evaluated in our medical facility on{' '}
                  <strong>{formatDisplayDate(startDate)}</strong>.
                </p>

                {excuseType === 'off-work' && (
                  <div className="sm-wn-cert-callout sm-wn-cert-callout--off">
                    <p>
                      Due to an active medical condition{includeDiagnosis && diagnosis ? ` (${diagnosis})` : ''}, this patient is temporarily incapacitated and is excused from work/school from{' '}
                      <strong>{formatDisplayDate(startDate)}</strong> through <strong>{formatDisplayDate(returnDate)}</strong>.
                    </p>
                    <p style={{ marginTop: 8 }}>
                      The patient is medically cleared to resume regular work duties on{' '}
                      <strong>{formatDisplayDate(returnDate)}</strong>.
                    </p>
                  </div>
                )}

                {excuseType === 'modified' && (
                  <div className="sm-wn-cert-callout sm-wn-cert-callout--mod">
                    <p>
                      The patient is cleared to resume work activities on{' '}
                      <strong>{formatDisplayDate(returnDate)}</strong> under modified duties with the following physical restrictions:
                    </p>
                    <p className="sm-wn-cert-restrictions">
                      <strong>Restrictions:</strong> {restrictions}
                    </p>
                  </div>
                )}

                {excuseType === 'cleared' && (
                  <div className="sm-wn-cert-callout sm-wn-cert-callout--clear">
                    <p>
                      The patient has undergone clinical assessment and is <strong>fully cleared</strong> to return to work/school immediately with no physical or work restrictions.
                    </p>
                  </div>
                )}

                {customNote.trim() && (
                  <p className="sm-wn-cert-custom-note">
                    <strong>Physician Instructions:</strong> {customNote.trim()}
                  </p>
                )}

                <p className="sm-wn-cert-contact-sub">
                  If your office requires any additional verification, please contact our clinical department.
                </p>
              </div>

              <div className="sm-wn-cert-signature-area">
                <div className="sm-wn-cert-sig-line" />
                <div className="sm-wn-cert-dr-name">{clinicianName}</div>
                <div className="sm-wn-cert-dr-role">{specialty} • Anot Health</div>
                <div className="sm-wn-cert-timestamp">Electronically signed • Encounter ID: #{patient?.id || 'ENC'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sm-work-note-modal__footer">
          <button
            type="button"
            className="sm-btn-wn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <div className="sm-work-note-modal__footer-right">
            <button
              type="button"
              className="sm-btn-wn-secondary"
              onClick={handlePrint}
              title="Print medical excuse certificate"
            >
              🖨 Print Work Note
            </button>
            <button
              type="button"
              className={`sm-btn-wn-primary ${copied ? 'sm-btn-wn-primary--copied' : ''}`}
              onClick={handleCopy}
              title="Copy work note text to clipboard"
            >
              {copied ? '✓ Work Note Copied!' : '📋 Copy Work Note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
