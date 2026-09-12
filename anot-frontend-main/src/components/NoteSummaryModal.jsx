import { useState, useMemo, useEffect } from 'react'
import { parseNote } from '../utils/noteParser'
import './NoteSummaryModal.css'

// Groups of header labels (as they come back from parseNote, case-insensitive, brackets
// like "(A&P)"/"(PE)" stripped) that map onto each field of the summary. Using the shared,
// dictionary-driven parseNote() here — instead of ad hoc regexes — avoids two bugs that
// regexes kept re-introducing: (1) matching "ASSESSMENT" as a substring of the combined
// "ASSESSMENT & PLAN" header and leaving "& PLAN" stuck onto the captured text, and (2) a
// header-boundary lookahead that didn't allow digits, so it ran straight through headers
// like "ICD-10 CODES" and swallowed the Plan/ICD-10/CPT sections into the diagnoses list —
// which is why the Plan items were showing up twice (once mislabeled as diagnoses, once
// correctly under Plan).
const CC_LABELS = ['CHIEF COMPLAINT', 'CC', 'REASON FOR VISIT', 'CHIEF CONCERN']
const VITALS_LABELS = ['VITAL SIGNS', 'VITALS']
const EXAM_LABELS = ['PHYSICAL EXAMINATION', 'PHYSICAL EXAM', 'PE']
const MEDS_LABELS = ['MEDICATIONS', 'CURRENT MEDICATIONS', 'MEDICATION LIST', 'MEDS']
const PLAN_LABELS = ['PLAN', 'TREATMENT PLAN', 'RECOMMENDATIONS']

function normalizeLabel(label) {
  return String(label || '').trim().toUpperCase().replace(/\s*\([^)]*\)\s*$/, '').trim()
}

function bodyForLabels(sections, labels) {
  const match = sections.find((s) => labels.includes(normalizeLabel(s.label)))
  return match ? match.body.trim() : ''
}

function bodyLinesAsList(body, { dropIfContains } = {}) {
  if (!body) return []
  return body
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[0-9]+[.)]|[-•*])\s*/, '').trim())
    .filter((line) => line.length > 2)
    .filter((line) => !dropIfContains || !line.toLowerCase().includes(dropIfContains))
}

/**
 * Intelligent parser to extract key clinical sections from note text
 */
function extractSummarySections(noteText = '') {
  if (!noteText) {
    return {
      chiefComplaint: '',
      diagnoses: [],
      vitals: '',
      exam: '',
      medications: [],
      plan: [],
      raw: '',
    }
  }

  const clean = String(noteText).trim()
  const sections = parseNote(clean)

  // Chief Complaint — first line or two of its own body only
  const ccBody = bodyForLabels(sections, CC_LABELS)
  const chiefComplaint = ccBody.split('\n').slice(0, 2).join(' ').trim().replace(/^[•\-\*.\s]+/, '')

  // Assessment / Diagnoses — the "ASSESSMENT & PLAN" header's own body is usually empty
  // (its Assessment/Plan sub-lines are recognized as their own header lines by parseNote),
  // so fall back to the combined section when no distinct ASSESSMENT sub-section exists.
  let diagnoses = bodyLinesAsList(bodyForLabels(sections, ['ASSESSMENT', 'IMPRESSION', 'DIAGNOSIS', 'DIAGNOSES']))
  if (diagnoses.length === 0) {
    diagnoses = bodyLinesAsList(bodyForLabels(sections, ['ASSESSMENT & PLAN', 'ASSESSMENT AND PLAN', 'A&P']))
  }

  // Vitals
  const vitals = bodyLinesAsList(bodyForLabels(sections, VITALS_LABELS)).join(' · ')

  // Physical Exam
  const exam = bodyForLabels(sections, EXAM_LABELS)

  // Medications
  const medications = bodyLinesAsList(bodyForLabels(sections, MEDS_LABELS), { dropIfContains: 'none documented' })

  // Plan / Treatment directives — distinct PLAN sub-section takes priority; only fall back
  // to the combined ASSESSMENT & PLAN body when there's no separate Plan section (and even
  // then, skip lines already captured as diagnoses so nothing is duplicated).
  let plan = bodyLinesAsList(bodyForLabels(sections, PLAN_LABELS))
  if (plan.length === 0) {
    const combined = bodyLinesAsList(bodyForLabels(sections, ['ASSESSMENT & PLAN', 'ASSESSMENT AND PLAN', 'A&P']))
    plan = combined.filter((line) => !diagnoses.includes(line))
  }

  return {
    chiefComplaint: chiefComplaint || 'Routine medical evaluation',
    diagnoses: diagnoses.length > 0 ? diagnoses : ['Clinical evaluation completed as documented.'],
    vitals,
    exam,
    medications,
    plan: plan.length > 0 ? plan : ['Continue current regimen and follow-up as advised.'],
    raw: clean,
  }
}

/**
 * Builds structured clinical handoff summary text
 */
function buildClinicalExecutiveSummary(parsed, patient, clinician) {
  const pName = patient?.patient_name || patient?.name || 'Patient'
  const pAge = patient?.age ? `${patient.age} yrs` : 'Not specified'
  const pMrn = patient?.mrn || 'N/A'
  const date = patient?.visit_date ? String(patient.visit_date).slice(0, 10) : new Date().toISOString().slice(0, 10)
  const docName = clinician?.name || 'Attending Physician'

  let out = `CLINICAL ENCOUNTER SUMMARY\n`
  out += `=====================================\n`
  out += `Patient: ${pName} | Age: ${pAge} | MRN: ${pMrn}\n`
  out += `Encounter Date: ${date} | Clinician: ${docName}\n`
  out += `Reason for Visit: ${parsed.chiefComplaint}\n\n`

  out += `PRIMARY CLINICAL IMPRESSIONS / DIAGNOSES:\n`
  parsed.diagnoses.forEach((d, i) => {
    out += `  ${i + 1}. ${d}\n`
  })
  out += `\n`

  if (parsed.vitals) {
    out += `VITAL SIGNS: ${parsed.vitals}\n\n`
  }

  if (parsed.medications.length > 0) {
    out += `MEDICATIONS (Active / Prescribed):\n`
    parsed.medications.forEach((m) => {
      out += `  • ${m}\n`
    })
    out += `\n`
  }

  out += `CARE PLAN & ACTION ITEMS:\n`
  parsed.plan.forEach((p, i) => {
    out += `  ${i + 1}. ${p}\n`
  })

  return out
}

/**
 * Builds patient-friendly After-Visit Summary (AVS)
 */
function buildPatientFriendlySummary(parsed, patient, clinician) {
  const pName = patient?.patient_name || patient?.name || 'Patient'
  const docName = clinician?.name ? (clinician.name.startsWith('Dr.') ? clinician.name : `Dr. ${clinician.name}`) : 'your doctor'
  const date = patient?.visit_date ? String(patient.visit_date).slice(0, 10) : new Date().toISOString().slice(0, 10)

  let out = `AFTER-VISIT SUMMARY & INSTRUCTIONS\n`
  out += `=====================================\n`
  out += `Hello ${pName},\n\n`
  out += `Here is a summary of your visit with ${docName} on ${date}.\n\n`

  out += `WHAT WE DISCUSSED TODAY:\n`
  out += `• Main Reason for Visit: ${parsed.chiefComplaint}\n`
  if (parsed.diagnoses.length > 0) {
    out += `• Key Diagnosis: ${parsed.diagnoses.join('; ')}\n`
  }
  out += `\n`

  if (parsed.medications.length > 0) {
    out += `MEDICATIONS TO TAKE:\n`
    parsed.medications.forEach((m) => {
      out += `• ${m}\n`
    })
    out += `\n`
  }

  out += `YOUR TREATMENT PLAN & NEXT STEPS:\n`
  parsed.plan.forEach((p) => {
    out += `• ${p}\n`
  })
  out += `\n`

  out += `WHEN TO SEEK IMMEDIATE CARE:\n`
  out += `If you experience severe shortness of breath, sudden chest pain, high fever, or worsening symptoms, please contact the clinic or proceed to the nearest emergency department immediately.`

  return out
}

export default function NoteSummaryModal({
  isOpen,
  onClose,
  patient,
  clinician,
  noteText = '',
}) {
  const [activeTab, setActiveTab] = useState('clinical') // 'clinical' | 'patient'
  const [isEditing, setIsEditing] = useState(false)
  const [copied, setCopied] = useState(false)

  const parsed = useMemo(() => extractSummarySections(noteText), [noteText])

  const defaultClinicalText = useMemo(
    () => buildClinicalExecutiveSummary(parsed, patient, clinician),
    [parsed, patient, clinician]
  )

  const defaultPatientText = useMemo(
    () => buildPatientFriendlySummary(parsed, patient, clinician),
    [parsed, patient, clinician]
  )

  const [clinicalText, setClinicalText] = useState(defaultClinicalText)
  const [patientText, setPatientText] = useState(defaultPatientText)

  useEffect(() => {
    setClinicalText(defaultClinicalText)
    setPatientText(defaultPatientText)
  }, [defaultClinicalText, defaultPatientText])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const currentText = activeTab === 'clinical' ? clinicalText : patientText
  const setCurrentText = activeTab === 'clinical' ? setClinicalText : setPatientText

  const handleCopy = () => {
    navigator.clipboard.writeText(currentText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2200)
  }

  const handlePrint = () => {
    const printWin = window.open('', '_blank', 'width=800,height=700')
    if (!printWin) return

    const title = activeTab === 'clinical' ? 'Clinical Encounter Summary' : 'After-Visit Patient Summary'
    const clinic = clinician?.clinic_name || 'Anot Health Family Practice'

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 30px; color: #0F172A; line-height: 1.6; }
          h2 { color: #1E3A8A; margin: 0 0 4px 0; border-bottom: 2px solid #2563EB; padding-bottom: 6px; }
          .clinic { font-size: 13px; color: #64748B; margin-bottom: 20px; }
          pre { font-family: inherit; white-space: pre-wrap; word-wrap: break-word; font-size: 13.5px; background: #F8FAFC; padding: 18px; border-radius: 8px; border: 1px solid #E2E8F0; }
          .footer { margin-top: 24px; font-size: 11px; color: #94A3B8; border-top: 1px solid #E2E8F0; padding-top: 8px; }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        <div class="clinic">${clinic} · Confidential Medical Record</div>
        <pre>${currentText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <div class="footer">Generated on ${new Date().toLocaleString()} · HIPAA & PIPEDA Compliant</div>
        <script>window.print();</script>
      </body>
      </html>
    `)
    printWin.document.close()
  }

  return (
    <div
      className="sm-summary-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sm-summary-modal-title"
    >
      <div className="sm-summary-modal-box" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="sm-summary-modal-header">
          <div className="sm-summary-modal-title-group">
            <div className="sm-summary-icon-badge">✨</div>
            <div>
              <h3 id="sm-summary-modal-title">Encounter Summary</h3>
              <p className="sm-summary-subtitle">
                {patient?.patient_name || 'Patient'} · {patient?.mrn ? `MRN: ${patient.mrn} · ` : ''}{patient?.visit_type || 'Consultation'}
              </p>
            </div>
          </div>

          <div className="sm-summary-header-actions">
            {/* View Switcher Tabs */}
            <div className="sm-summary-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'clinical'}
                className={`sm-summary-tab ${activeTab === 'clinical' ? 'sm-summary-tab--active' : ''}`}
                onClick={() => setActiveTab('clinical')}
              >
                🏥 Clinical Brief
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'patient'}
                className={`sm-summary-tab ${activeTab === 'patient' ? 'sm-summary-tab--active' : ''}`}
                onClick={() => setActiveTab('patient')}
              >
                👤 Patient Summary (AVS)
              </button>
            </div>

            <button
              type="button"
              className="sm-summary-close-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close encounter summary"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="sm-summary-modal-body">
          <div className="sm-summary-toolbar">
            <span className="sm-summary-hint">
              {activeTab === 'clinical'
                ? 'High-density physician handoff and EMR summary'
                : 'Plain language instructions and care plan for patient'}
            </span>
            <button
              type="button"
              className="sm-btn-summary-toggle-edit"
              onClick={() => setIsEditing(!isEditing)}
            >
              {isEditing ? '✓ Done Editing' : '✏️ Edit Summary Text'}
            </button>
          </div>

          {isEditing ? (
            <textarea
              className="sm-summary-textarea"
              value={currentText}
              onChange={(e) => setCurrentText(e.target.value)}
              rows={16}
            />
          ) : (
            <div className="sm-summary-card">
              <pre className="sm-summary-preview">{currentText}</pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="sm-summary-modal-footer">
          <span className="sm-summary-footer-meta">
            🔒 HIPAA & PIPEDA Compliant
          </span>

          <div className="sm-summary-footer-btns">
            <button
              type="button"
              className="sm-btn-summary-secondary"
              onClick={handlePrint}
              title="Print or export as PDF"
            >
              🖨 Print / PDF
            </button>
            <button
              type="button"
              className={`sm-btn-summary-primary ${copied ? 'sm-btn-summary-primary--copied' : ''}`}
              onClick={handleCopy}
              title="Copy summary text to clipboard"
            >
              {copied ? '✓ Copied to Clipboard!' : '📋 Copy Summary'}
            </button>
            <button
              type="button"
              className="sm-btn-summary-ghost"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
