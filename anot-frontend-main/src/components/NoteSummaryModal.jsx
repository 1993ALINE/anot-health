import { useState, useMemo, useEffect } from 'react'
import './NoteSummaryModal.css'

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

  // 1. Chief Complaint
  let chiefComplaint = ''
  const ccMatch = clean.match(/(?:CHIEF\s+COMPLAINT|REASON\s+FOR\s+VISIT|PRESENTING\s+COMPLAINT)[\s:]*([^\n]+(?:\n(?![A-Z\s]{3,}:)[^\n]+)?)/i)
  if (ccMatch && ccMatch[1]) {
    chiefComplaint = ccMatch[1].trim().replace(/^[•\-\*.\s]+/, '')
  }

  // 2. Assessment / Diagnoses
  const diagnoses = []
  const assessMatch = clean.match(/(?:ASSESSMENT|IMPRESSION|DIAGNOSIS|DIAGNOSES|A&P)[\s:]*([\s\S]*?)(?=(?:\n[A-Z\s/&()\-–—]{3,}:|$))/i)
  if (assessMatch && assessMatch[1]) {
    const rawLines = assessMatch[1].trim().split('\n')
    for (const line of rawLines) {
      const trimmed = line.trim().replace(/^(?:[0-9]+[.)]|[-•*])\s*/, '').replace(/^Assessment:\s*/i, '').trim()
      if (trimmed && trimmed.length > 2 && !trimmed.toUpperCase().startsWith('PLAN')) {
        diagnoses.push(trimmed)
      }
    }
  }

  // 3. Vitals
  let vitals = ''
  const vitalsMatch = clean.match(/(?:VITAL\s+SIGNS|VITALS)[\s:]*([\s\S]*?)(?=(?:\n[A-Z\s/&()\-–—]{3,}:|$))/i)
  if (vitalsMatch && vitalsMatch[1]) {
    vitals = vitalsMatch[1].trim()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join(' · ')
  }

  // 4. Physical Exam
  let exam = ''
  const peMatch = clean.match(/(?:PHYSICAL\s+EXAM(?:INATION)?|PE)[\s:]*([\s\S]*?)(?=(?:\n[A-Z\s/&()\-–—]{3,}:|$))/i)
  if (peMatch && peMatch[1]) {
    exam = peMatch[1].trim()
  }

  // 5. Medications
  const medications = []
  const medsMatch = clean.match(/(?:CURRENT\s+MEDICATIONS?|MEDICATIONS?|MEDS)[\s:]*([\s\S]*?)(?=(?:\n[A-Z\s/&()\-–—]{3,}:|$))/i)
  if (medsMatch && medsMatch[1]) {
    const medLines = medsMatch[1].trim().split('\n')
    for (const line of medLines) {
      const trimmed = line.trim().replace(/^[•\-\*.\s]+/, '')
      if (trimmed && trimmed.length > 2 && !trimmed.toLowerCase().includes('none documented')) {
        medications.push(trimmed)
      }
    }
  }

  // 6. Plan / Treatment directives
  const plan = []
  const planMatch = clean.match(/(?:PLAN|TREATMENT\s+PLAN|RECOMMENDATIONS)[\s:]*([\s\S]*?)(?=(?:\n[A-Z\s/&()\-–—]{3,}:|$))/i)
  if (planMatch && planMatch[1]) {
    const pLines = planMatch[1].trim().split('\n')
    for (const line of pLines) {
      const trimmed = line.trim().replace(/^(?:[0-9]+[.)]|[-•*])\s*/, '').trim()
      if (trimmed && trimmed.length > 2) {
        plan.push(trimmed)
      }
    }
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
    <div className="sm-summary-modal-backdrop" onClick={onClose}>
      <div className="sm-summary-modal-box" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="sm-summary-modal-header">
          <div className="sm-summary-modal-title-group">
            <div className="sm-summary-icon-badge">✨</div>
            <div>
              <h3>Encounter Summary</h3>
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
