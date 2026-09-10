import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import { visitsAPI, notesAPI, patientsAPI, consentAPI, settingsAPI } from '../../services/api'
import RecordingVisualizer from '../../components/RecordingVisualizer'
import { startRecordingKeepAlive, stopRecordingKeepAlive } from '../../utils/recordingKeepAlive'
import { cleanAiDraftForDisplay } from '../../utils/aiDraftFormat'
import { formatClinicalDictationToSOAP } from '../../utils/clinicalSoapSynthesizer'
import * as offlineAudioQueue from '../../utils/offlineAudioQueue'
import { formatEncounterDate } from '../../utils/visitEncounterUtils'
import SaintMaryNoteViewerModal from '../../components/SaintMaryNoteViewerModal'
import ClinicianTemplateModal from '../../components/ClinicianTemplateModal'
import './ClinicianPortal.css'

const CLINICAL_TEMPLATES = [
  // 1. Core Primary Care
  {
    id: 'soap-adult',
    label: 'SOAP Note — Adult (Standard / Episodic)',
    type: 'Follow-up',
    category: 'Core Primary Care',
    description: 'Acute problem or episodic complaint (e.g. URTI, UTI, acute injury, rash).',
  },
  {
    id: 'follow-up',
    label: 'Follow-Up / Chronic Disease Review',
    type: 'Follow-up',
    category: 'Core Primary Care',
    description: 'Interval assessment, treatment response, lab review, and care plan updates.',
  },
  {
    id: 'comprehensive',
    label: 'New Patient Comprehensive Intake (H&P)',
    type: 'New Patient',
    category: 'Core Primary Care',
    description: 'Complete baseline health history, past medical/surgical/family/social, ROS, and full physical exam.',
  },

  // 2. Preventive & Life-Stage
  {
    id: 'periodic-health',
    label: 'Periodic Health Review (CTFPHC Guidelines)',
    type: 'Follow-up',
    category: 'Preventive & Life-Stage',
    description: 'Canadian Task Force preventive screening (FIT, mammography, cervical, bone density, CVD risk).',
  },
  {
    id: 'rourke-pediatric',
    label: 'Well-Baby / Well-Child (Rourke Baby Record)',
    type: 'Follow-up',
    category: 'Preventive & Life-Stage',
    description: 'Canadian RBR standard: growth percentiles, developmental milestones, nutrition, immunizations.',
  },
  {
    id: 'geriatric-frailty',
    label: 'Comprehensive Geriatric & Frailty Assessment',
    type: 'Follow-up',
    category: 'Preventive & Life-Stage',
    description: 'Senior assessment: cognitive screening (MoCA/MMSE), ADLs/IADLs, falls risk, polypharmacy review.',
  },

  // 3. Chronic Disease Management (CDM)
  {
    id: 'diabetes-cdm',
    label: 'Diabetes Mellitus Care (Diabetes Canada)',
    type: 'Follow-up',
    category: 'Chronic Disease Management (CDM)',
    description: 'HbA1c target, home SMBG, hypoglycemia review, 10g monofilament foot exam, ACR/eGFR, statin.',
  },
  {
    id: 'hypertension-cvd',
    label: 'Hypertension & Cardiovascular (Hypertension Canada)',
    type: 'Follow-up',
    category: 'Chronic Disease Management (CDM)',
    description: 'Home/office BP log, cardiovascular risk, DASH lifestyle, medication reconciliation & target review.',
  },
  {
    id: 'respiratory-cts',
    label: 'Asthma & COPD Action Visit (CTS Guidelines)',
    type: 'Follow-up',
    category: 'Chronic Disease Management (CDM)',
    description: 'Canadian Thoracic Society: symptom control (ACT/CAT/mMRC), inhaler technique, spirometry/PEF.',
  },
  {
    id: 'chronic-pain-msk',
    label: 'Chronic Pain & MSK Management Visit',
    type: 'Follow-up',
    category: 'Chronic Disease Management (CDM)',
    description: 'Pain assessment (PEG score), functional impact, non-pharmacologic care, opioid risk, focused exam.',
  },

  // 4. Mental Health & Addictions
  {
    id: 'mental-health-canmat',
    label: 'Mental Health Assessment (CANMAT Guidelines)',
    type: 'Follow-up',
    category: 'Mental Health & Addictions',
    description: 'Depression/anxiety (PHQ-9/GAD-7), stressors, safety/suicide risk assessment, psychotherapy & meds.',
  },
  {
    id: 'addictions-oat',
    label: 'Substance Use & Addictions / OAT Encounter',
    type: 'Follow-up',
    category: 'Mental Health & Addictions',
    description: 'Opioid Agonist Therapy (Methadone/Suboxone/Buprenorphine), cravings, harm reduction, toxicology.',
  },

  // 5. Women\'s Health & Perinatal
  {
    id: 'prenatal-sogc',
    label: 'Prenatal / Antenatal Visit (SOGC Guidelines)',
    type: 'Follow-up',
    category: "Women's Health & Perinatal",
    description: 'SOGC antenatal record: EGA, BP, SFH, FHR, fetal movements, edema, screening labs & ultrasound.',
  },
  {
    id: 'postpartum-6wk',
    label: 'Postpartum & Newborn 6-Week Examination',
    type: 'Follow-up',
    category: "Women's Health & Perinatal",
    description: 'Maternal physical recovery, EPDS mood screen, infant feeding & growth, contraception counseling.',
  },

  // 6. Virtual Care & Occupational
  {
    id: 'virtual-telehealth',
    label: 'Virtual Care / Telehealth Encounter (CMPA)',
    type: 'Virtual Visit',
    category: 'Virtual Care & Occupational',
    description: 'CMPA-compliant virtual consent, patient location, technology modality, red flags & in-person trigger.',
  },
  {
    id: 'specialist-referral',
    label: 'Specialist Referral & Consultation Request',
    type: 'Other',
    category: 'Virtual Care & Occupational',
    description: 'Formal referral letter: clinical question, investigations, medications, failed trials, urgency.',
  },
  {
    id: 'wcb-occupational',
    label: "Occupational Injury / Worker's Comp (WCB / WSIB)",
    type: 'Other',
    category: 'Virtual Care & Occupational',
    description: 'Workplace incident details, mechanism, objective exam, modified duties, return to work timeline.',
  },
]

function renderTemplateOptions(list = CLINICAL_TEMPLATES) {
  const safeList = Array.isArray(list) && list.length > 0 ? list : CLINICAL_TEMPLATES
  const categories = [...new Set(safeList.map((t) => t.category || 'Core Primary Care'))]
  return categories.map((cat) => (
    <optgroup key={cat} label={`── ${cat} ──`}>
      {safeList.filter((t) => (t.category || 'Core Primary Care') === cat).map((t) => (
        <option key={t.id} value={t.label || t.name}>
          {t.label || t.name}
        </option>
      ))}
    </optgroup>
  ))
}

const DEFAULT_MACROS = [
  {
    id: 'm_vitals',
    name: 'Normal Vitals (Canadian Metric)',
    shortcut: '.vitals',
    content: 'VITALS: BP 118/76 mmHg, HR 70 bpm regular, Temp 36.8°C (oral), RR 14/min, SpO2 99% on room air, Weight 74.2 kg, Height 175 cm (BMI 24.2 kg/m²).',
  },
  {
    id: 'm_normexam',
    name: 'Normal Physical Exam',
    shortcut: '.normexam',
    content: 'PHYSICAL EXAM:\nGENERAL: Alert and oriented x3, well-nourished, in no acute distress.\nHEENT: Normocephalic, atraumatic, conjunctivae clear, pharynx normal.\nCARDIOVASCULAR: Regular rate and rhythm, normal S1/S2, no murmurs.\nPULMONARY: Clear to auscultation bilaterally, no wheezes, rales, or rhonchi.\nABDOMEN: Soft, non-tender, non-distended, active bowel sounds, no organomegaly.\nNEURO: Alert, oriented, cranial nerves grossly intact, normal gait.',
  },
  {
    id: 'm_footexam',
    name: 'Diabetic Foot Exam (Diabetes Canada)',
    shortcut: '.footexam',
    content: 'DIABETIC FOOT EXAM:\nInspection: Skin intact bilaterally, no ulcers, fissures, calluses, or fungal nail changes.\nPulses: Dorsalis pedis (DP) and posterior tibial (PT) 2+ bilaterally, capillary refill < 2s.\nNeurological: 10g Semmes-Weinstein monofilament sensation intact (10/10 sites bilaterally). Vibration sense intact.',
  },
  {
    id: 'm_rourke',
    name: 'Rourke Well-Child Milestones',
    shortcut: '.rourke',
    content: 'ROURKE BABY RECORD ASSESSMENT:\nGrowth: Weight, length, and head circumference tracking steadily along expected percentiles.\nNutrition: Age-appropriate feeding well tolerated; vitamin D supplementation discussed.\nDevelopment: Gross motor, fine motor, communication, and social/emotional milestones intact for age.\nSafety & Guidance: Car seat, safe sleep, sun/water safety, and next scheduled immunizations reviewed.',
  },
  {
    id: 'm_canmat',
    name: 'Mental Health & Suicide Risk (CANMAT)',
    shortcut: '.canmat',
    content: 'MENTAL HEALTH & SAFETY ASSESSMENT:\nMood/Affect: Patient reports mood as low/anxious; affect congruent.\nScores: PHQ-9: 12 (Moderate depression); GAD-7: 10 (Moderate anxiety).\nSafety Assessment: Denies active suicidal ideation, intent, plan, or access to lethal means. No homicidal ideation.\nCrisis Protocol: 24/7 Canada Suicide Crisis Helpline (988) provided. Emergency return precautions reviewed.',
  },
  {
    id: 'm_sogc',
    name: 'Prenatal Exam (SOGC Antenatal)',
    shortcut: '.sogc',
    content: 'PRENATAL VISIT (SOGC):\nGestational Age: EGA consistent with dating ultrasound.\nExam: Maternal BP normotensive. No headache, visual changes, or epigastric pain. SFH concordant with dates.\nFetus: FHR regular at 140-150 bpm. Active fetal movement confirmed by mother. Urine dipstick negative.',
  },
  {
    id: 'm_kneemsk',
    name: 'Right Knee MSK Exam',
    shortcut: '.kneemsk',
    content: 'RIGHT KNEE EXAM:\nInspection: Mild joint effusion, no erythema or local warmth.\nPalpation: Tenderness to palpation along medial joint line and MCL.\nSpecial Tests: McMurray positive for medial joint discomfort. Lachman negative, stable to varus/valgus stress.\nROM: Active flexion to 115 degrees limited by pain; full extension (0 degrees).',
  },
  {
    id: 'm_rx_nsaid',
    name: 'Rx NSAID Plan',
    shortcut: '.rx_nsaid',
    content: 'PLAN:\n1. Ibuprofen 600 mg PO TID with meals as needed for pain and inflammation.\n2. Advised patient on gastrointestinal precautions and adequate hydration.\n3. Ice application for 15-20 minutes 3-4 times daily.',
  },
  {
    id: 'm_ortho',
    name: 'Ortho Referral & MRI',
    shortcut: '.ortho',
    content: 'PLAN:\n1. Outpatient orthopedic surgery referral ordered for advanced subspecialty evaluation.\n2. Right knee MRI without contrast ordered to assess meniscal and ligamentous status.\n3. Activity modification and avoid high-impact pivoting activities.',
  },
  {
    id: 'm_headache',
    name: 'Headache / Migraine Plan',
    shortcut: '.headache',
    content: 'PLAN:\n1. Rest in a quiet, dark, well-ventilated room; maintain adequate hydration and sleep schedule.\n2. Acetaminophen 500-1000 mg PO PRN or ibuprofen 400-600 mg PO TID with meals for acute symptom relief.\n3. Red-flag warning signs reviewed: seek emergency care for sudden severe thunderclap headache, high fever, neck stiffness, or focal neurological deficits.\n4. Clinic follow-up in 1-2 weeks or PRN.',
  },
  {
    id: 'm_followup',
    name: '2-Week Follow-up',
    shortcut: '.followup',
    content: 'FOLLOW-UP:\n1. Return to clinic in 2 weeks or sooner if symptoms, swelling, or pain worsen.\n2. Red flag return precautions discussed including severe pain, calf swelling, or inability to bear weight.',
  },
  {
    id: 'm_wcb',
    name: 'WCB Return-to-Work Plan',
    shortcut: '.wcb',
    content: 'WCB WORK CAPABILITY & PLAN:\n1. Modified work duties recommended: No lifting > 5 kg, avoid repetitive twisting or bending for 2 weeks.\n2. WCB Form completed and submitted. Physiotherapy referral initiated.\n3. Clinical review and functional assessment in 2 weeks.',
  },
]

function normalizeVisitTypeForDb(val) {
  const s = String(val || '').toLowerCase()
  const found = CLINICAL_TEMPLATES.find(
    (t) => t.label.toLowerCase() === s || t.id.toLowerCase() === s
  )
  if (found) {return found.type}
  if (s.includes('new') || s.includes('intake') || s.includes('comprehensive')) {return 'New Patient'}
  if (s.includes('virtual') || s.includes('tele')) {return 'Virtual Visit'}
  if (s.includes('referral') || s.includes('wcb') || s.includes('occupational') || s.includes('other')) {return 'Other'}
  return 'Follow-up'
}

function parseNoteSections(noteText) {
  if (!noteText) {return []}
  const text = cleanAiDraftForDisplay(noteText)

  const sectionRegex = /^(?:\[?[A-Z0-9\s/&()\-–—]+\]?|[A-Z\s/&()\-–—]+):\s*$/gm
  const matches = []
  let match
  while ((match = sectionRegex.exec(text)) !== null) {
    const rawHeader = match[0].replace(/:$/, '').trim()
    const cleanHeader = rawHeader.replace(/^\[|\]$/g, '').trim()
    if (cleanHeader.length >= 2 && !/^(NOTE|DATE|TIME|MRN|PATIENT|STATUS)/i.test(cleanHeader)) {
      matches.push({ header: cleanHeader, index: match.index, length: match[0].length })
    }
  }

  if (matches.length === 0) {
    return [{ header: 'CLINICAL NOTE', content: text }]
  }

  const sections = []
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const next = matches[i + 1]
    const contentStart = current.index + current.length
    const contentEnd = next ? next.index : text.length
    const content = text.slice(contentStart, contentEnd).trim()
    if (content) {
      sections.push({
        header: current.header,
        content: content,
      })
    }
  }
  return sections
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) {return ''}
  try {
    const dob = new Date(dateOfBirth)
    if (isNaN(dob.getTime())) {return ''}
    const diffMs = Date.now() - dob.getTime()
    const ageDt = new Date(diffMs)
    const age = Math.abs(ageDt.getUTCFullYear() - 1970)
    return `${age} yrs`
  } catch {
    return ''
  }
}

function getPatientDisplayAge(visitOrPatient, patientList = []) {
  if (!visitOrPatient) {return ''}
  if (visitOrPatient.age) {
    const num = String(visitOrPatient.age).replace(/[^0-9]/g, '')
    return num ? `${num} yrs` : visitOrPatient.age
  }
  if (visitOrPatient.date_of_birth) {
    const a = calculateAge(visitOrPatient.date_of_birth)
    if (a) {return a}
  }
  if (visitOrPatient.dob) {
    const a = calculateAge(visitOrPatient.dob)
    if (a) {return a}
  }
  if (visitOrPatient.patient_id && Array.isArray(patientList)) {
    const p = patientList.find((x) => String(x.id) === String(visitOrPatient.patient_id))
    if (p?.date_of_birth) {
      const a = calculateAge(p.date_of_birth)
      if (a) {return a}
    }
    if (p?.dob) {
      const a = calculateAge(p.dob)
      if (a) {return a}
    }
    if (p?.age) {return `${p.age} yrs`}
  }
  return ''
}

function getLocalDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getYesterdayDateStr() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return getLocalDateStr(d)
}

function normalizeVisitDate(val) {
  if (!val) {return ''}
  if (typeof val === 'string') {
    return val.slice(0, 10)
  }
  try {
    const d = new Date(val)
    return getLocalDateStr(d)
  } catch {
    return ''
  }
}

function formatEncounterDateTime(visitDate, visitTime) {
  const todayStr = getLocalDateStr()
  const yesterdayStr = getYesterdayDateStr()
  const vDate = normalizeVisitDate(visitDate)

  let formattedTime = visitTime || '10:00'
  if (formattedTime.includes(':')) {
    const parts = formattedTime.split(':')
    const hour = parseInt(parts[0], 10)
    const min = parts[1] || '00'
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const h12 = hour % 12 || 12
    formattedTime = `${h12}:${min} ${ampm}`
  }

  if (vDate === todayStr) {
    return `Today, ${formattedTime}`
  }
  if (vDate === yesterdayStr) {
    return `Yesterday, ${formattedTime}`
  }
  if (vDate) {
    try {
      const [y, m, d] = vDate.split('-').map(Number)
      const dt = new Date(y, m - 1, d)
      const monthStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return `${monthStr}, ${formattedTime}`
    } catch {
      return `${vDate}, ${formattedTime}`
    }
  }
  return formattedTime
}

function getNoteSnippet(visit) {
  const raw = visit?.final_note || visit?.ai_draft || visit?.transcription || ''
  if (!raw) {return 'Ambient consultation — no note recorded yet.'}
  const clean = cleanAiDraftForDisplay(raw)
    .replace(/^#+\s+/gm, '')
    .replace(/^(?:\[?[A-Z0-9\s/&()\-–—]+\]?|[A-Z\s/&()\-–—]+):\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) {return 'Clinical note recorded.'}
  return clean.length > 110 ? `${clean.slice(0, 110)}…` : clean
}

function isUnassignedPatient(v) {
  if (!v) {return false}
  const name = String(v.patient_name || '').trim()
  return !name || name === 'Quick Dictation (Unassigned)' || name === 'Patient Encounter' || name === 'Unnamed Patient'
}

function isCompletedVisit(v) {
  if (!v) { return false }
  return (
    v.status === 'completed' ||
    v.status === 'uploaded' ||
    v.note_status === 'uploaded' ||
    Boolean(v.locked_at)
  )
}

const DEV_MOCK_VISITS = [
  {
    id: 101,
    patient_name: 'Farhan Kabir',
    mrn: 'MRN-271370',
    visit_date: '2026-09-06T00:00:00.000Z',
    visit_time: '07:47',
    visit_type: 'Follow-up',
    status: 'draft',
    ai_draft: 'CHIEF COMPLAINT: Right knee pain following a mechanical fall HISTORY OF PRESENT ILLNESS (HPI): The patient is a 36-year-old male presenting with acute right knee pain following a fall onto concrete. Reports joint stiffness, effusion, and localized tenderness along medial joint line.',
  },
  {
    id: 102,
    patient_name: 'Patient Encounter',
    mrn: 'MRN-489389',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '22:41',
    visit_type: 'Follow-up',
    status: 'pending',
  },
  {
    id: 103,
    patient_name: 'David Headache-Test',
    mrn: 'MRN-HA-9092',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '15:45',
    visit_type: 'Follow-up',
    status: 'completed',
    locked_at: '2026-09-05T16:00:00.000Z',
    final_note: 'CHIEF COMPLAINT: Headache evaluation HISTORY OF PRESENT ILLNESS (HPI): The patient is a 45 yrs patient presenting for evaluation of headache. Symptoms have been recurring for 2 weeks with throbbing frontal discomfort, photophobia, and no focal neurological deficit.',
  },
  {
    id: 104,
    patient_name: 'David Headache-Test',
    mrn: 'MRN-HA-9092',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '15:45',
    visit_type: 'Follow-up',
    status: 'pending',
  },
  {
    id: 105,
    patient_name: 'Priya Patel',
    mrn: 'MRN-249018',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '14:30',
    visit_type: 'Virtual Visit',
    status: 'completed',
    locked_at: '2026-09-05T15:00:00.000Z',
    final_note: 'ANOT HEALTH AMBIENT CLINICAL DOCUMENTATION ATTENDING PHYSICIAN: Dr. A. McKnight, MD | Family Medicine CLINICAL SCRIBE: Shahib Hasib, Certified Medical Scribe. Comprehensive assessment of metabolic panel, hypertension review, and medication titration.',
  },
  {
    id: 106,
    patient_name: 'Marcus Vance',
    mrn: 'MRN-882103',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '13:15',
    visit_type: 'Annual Wellness',
    status: 'completed',
    locked_at: '2026-09-05T13:50:00.000Z',
    final_note: 'Annual wellness exam completed. Blood pressure 122/78 mmHg. Fasting lipid panel reviewed. Recommended continued lifestyle modifications.',
  },
  {
    id: 107,
    patient_name: 'Elena Rostova',
    mrn: 'MRN-339102',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '11:30',
    visit_type: 'Follow-up',
    status: 'draft',
    ai_draft: 'Follow-up for type 2 diabetes mellitus management. HbA1c 7.2%. Tolerating Metformin 1000mg BID without GI distress. Foot exam unremarkable.',
  },
  {
    id: 108,
    patient_name: 'James Wilson',
    mrn: 'MRN-672194',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '10:00',
    visit_type: 'Consultation',
    status: 'completed',
    locked_at: '2026-09-05T10:45:00.000Z',
    final_note: 'Cardiology consult follow-up. Normal sinus rhythm on EKG. Echocardiogram shows preserved EF 60%. Continued on current anti-hypertensive regimen.',
  },
  {
    id: 109,
    patient_name: 'Sophia Chang',
    mrn: 'MRN-512890',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '09:15',
    visit_type: 'Follow-up',
    status: 'draft',
    ai_draft: 'Asthma maintenance visit. Peak flow at 90% of personal best. Refilled Albuterol MDI and Symbicort inhaler.',
  },
  {
    id: 110,
    patient_name: 'Robert Miller',
    mrn: 'MRN-449102',
    visit_date: '2026-09-05T00:00:00.000Z',
    visit_time: '08:30',
    visit_type: 'New Patient',
    status: 'completed',
    locked_at: '2026-09-05T09:15:00.000Z',
    final_note: 'Comprehensive new patient intake. Past surgical history and social history documented. Baseline laboratory panel ordered.',
  },
  {
    id: 111,
    patient_name: 'Amara Okafor',
    mrn: 'MRN-781923',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '16:00',
    visit_type: 'Follow-up',
    status: 'completed',
    locked_at: '2026-09-04T16:35:00.000Z',
    final_note: 'Post-operative incision check at day 14. Surgical site clean, well-approximated, no signs of erythema or drainage. Sutures removed.',
  },
  {
    id: 112,
    patient_name: 'Lucas Dupont',
    mrn: 'MRN-993210',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '14:45',
    visit_type: 'Virtual Visit',
    status: 'draft',
    ai_draft: 'Telehealth visit for seasonal allergic rhinitis. Prescribed Flonase nasal spray and Loratadine 10mg daily.',
  },
  {
    id: 113,
    patient_name: 'Chloe Bennett',
    mrn: 'MRN-662381',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '13:30',
    visit_type: 'Follow-up',
    status: 'completed',
    locked_at: '2026-09-04T14:10:00.000Z',
    final_note: 'Dermatology follow-up for mild eczema. Triamcinolone 0.1% cream applied with good response.',
  },
  {
    id: 114,
    patient_name: 'Benjamin Wright',
    mrn: 'MRN-119283',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '11:00',
    visit_type: 'Follow-up',
    status: 'completed',
    locked_at: '2026-09-04T11:40:00.000Z',
    final_note: 'Chronic low back pain management. Referred to physical therapy for core strengthening program.',
  },
  {
    id: 115,
    patient_name: 'Hannah Abbott',
    mrn: 'MRN-884129',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '10:15',
    visit_type: 'Follow-up',
    status: 'draft',
    ai_draft: 'Migraine follow-up. Sumatriptan 50mg effective for acute abortive therapy.',
  },
  {
    id: 116,
    patient_name: 'Tariq Al-Mansoor',
    mrn: 'MRN-330192',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '09:00',
    visit_type: 'Follow-up',
    status: 'completed',
    locked_at: '2026-09-04T09:35:00.000Z',
    final_note: 'Routine hypertension follow-up. BP 124/82 mmHg. Lisinopril 20mg daily continued.',
  },
  {
    id: 117,
    patient_name: 'Olivia Martinez',
    mrn: 'MRN-552910',
    visit_date: '2026-09-04T00:00:00.000Z',
    visit_time: '08:15',
    visit_type: 'Follow-up',
    status: 'draft',
    ai_draft: 'Gastroenterology follow-up for GERD symptoms. Omeprazole 20mg QD continued with dietary adjustments advised.',
  },
]

export default function ClinicianPortal({ currentUser, onLogout }) {
  const [tab, setTab] = useState('ambient') // 'ambient' | 'history'
  const [visits, setVisits] = useState([])
  const [patientList, setPatientList] = useState([])
  const [toast, setToast] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [scheduleFilter, setScheduleFilter] = useState('all') // 'all' | 'pending' | 'ready' | 'draft'
  const [scheduleDateFilter, setScheduleDateFilter] = useState('today') // 'today' | 'yesterday' | 'all'
  const hasUserManuallySelectedDateTabRef = useRef(false)
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all') // 'all' | 'signed' | 'draft'

  // Smart-default date tab on initial load if today and yesterday have no visits
  useEffect(() => {
    if (hasUserManuallySelectedDateTabRef.current) return
    if (visits.length === 0) return

    const todayStr = getLocalDateStr()
    const yesterdayStr = getYesterdayDateStr()
    const countToday = visits.filter((v) => normalizeVisitDate(v.visit_date) === todayStr).length
    const countYesterday = visits.filter((v) => normalizeVisitDate(v.visit_date) === yesterdayStr).length

    if (countToday > 0) {
      setScheduleDateFilter('today')
    } else if (countYesterday > 0) {
      setScheduleDateFilter('yesterday')
    } else {
      setScheduleDateFilter('all')
    }
  }, [visits])

  // Edit / Add Patient Details Modal
  const [patientModalOpen, setPatientModalOpen] = useState(false)
  const [patientModalTab, setPatientModalTab] = useState('edit') // 'edit' | 'link'
  const [patientFormData, setPatientFormData] = useState({
    visitId: null,
    patientId: null,
    name: '',
    age: '',
    dob: '',
    mrn: '',
    selectedExistingId: '',
  })

  // Delete Encounter / Patient Confirmation Dialog
  const [deleteDialog, setDeleteDialog] = useState({
    open: false,
    visit: null,
    deletePatientAlso: false,
  })

  // Selected Patient for next/active encounter
  const [selectedPatientIdForEncounter, setSelectedPatientIdForEncounter] = useState('')
  const [patientNameInput, setPatientNameInput] = useState('')
  const [patientAgeInput, setPatientAgeInput] = useState('')
  const [patientMrnInput, setPatientMrnInput] = useState('')
  const [patientDateInput, setPatientDateInput] = useState(() => getLocalDateStr())
  const [patientTimeInput, setPatientTimeInput] = useState(() => {
    const d = new Date()
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })

  // Custom Free-Text Macros / SmartPhrases
  const [macros, setMacros] = useState(() => {
    try {
      const saved = localStorage.getItem('anot_clinician_macros_v2')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) {return parsed}
      }
    } catch { /* ignore */ }
    return DEFAULT_MACROS
  })
  const [macroModalOpen, setMacroModalOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [editingMacro, setEditingMacro] = useState(null)
  const [macroForm, setMacroForm] = useState({ name: '', shortcut: '', content: '' })

  // Recording State
  const [activeVisit, setActiveVisit] = useState(null)
  const [isPaused, setIsPaused] = useState(false)
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [_uploadStatus, setUploadStatus] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('SOAP Note — Adult (Standard / Episodic)')
  const [providerTemplates, setProviderTemplates] = useState(CLINICAL_TEMPLATES)
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [audioStream, setAudioStream] = useState(null)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [micLevel, setMicLevel] = useState(0)

  // Ambient Dictation scratchpad
  const [dictationNotes, setDictationNotes] = useState('')

  // After-recording Review state (1c)
  const [recordedDuration, setRecordedDuration] = useState('00:00')
  const [activeDraftNote, setActiveDraftNote] = useState(null)
  const [loadingNoteVisitId, setLoadingNoteVisitId] = useState(null)
  const [isEditingNote, setIsEditingNote] = useState(false)
  const [editedNoteText, setEditedNoteText] = useState('')

  // Note detail modal & copy feedback
  const [selectedNoteModal, setSelectedNoteModal] = useState(null)
  const [copiedSectionIndex, setCopiedSectionIndex] = useState(null)
  const [copiedFullNote, setCopiedFullNote] = useState(false)
  const [_selectedAssignPatientId, setSelectedAssignPatientId] = useState('')

  // Real-time mobile activity & live sync state
  const [liveSyncConnected, setLiveSyncConnected] = useState(false)
  const [mobileActivityBanner, setMobileActivityBanner] = useState(null)

  // MediaRecorder & SpeechRecognition refs
  const mediaRecorderRef = useRef(null)
  const speechRecRef = useRef(null)
  const liveTranscriptRef = useRef('')
  const audioChunksRef = useRef([])
  const timerIntervalRef = useRef(null)
  const animFrameRef = useRef(null)
  const audioContextRef = useRef(null)
  const transcriptScrollRef = useRef(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  useEffect(() => {
    let isMounted = true
    settingsAPI.getClinicianTemplates()
      .then((res) => {
        if (isMounted && Array.isArray(res?.templates) && res.templates.length > 0) {
          const mapped = res.templates.map((t) => ({
            ...t,
            label: t.name,
            type: t.type || normalizeVisitTypeForDb(t.name),
            category: t.category || 'Core Primary Care',
          }))
          setProviderTemplates(mapped)
        }
      })
      .catch((err) => {
        console.warn('Could not load custom provider templates, using defaults:', err)
      })
    return () => { isMounted = false }
  }, [])

  const handleSaveProviderTemplates = async (updatedList) => {
    const formatted = updatedList.map((t) => ({
      id: t.id,
      name: t.name || t.label,
      category: t.category || 'Core Primary Care',
      icon: t.icon || '📋',
      color: t.color || '#E3F2FD',
      accent: t.accent || '#1565C0',
      content: t.content || '',
    }))
    const res = await settingsAPI.saveClinicianTemplates(formatted)
    const savedList = Array.isArray(res?.templates) ? res.templates : formatted
    const mapped = savedList.map((t) => ({
      ...t,
      label: t.name,
      type: t.type || normalizeVisitTypeForDb(t.name),
      category: t.category || 'Core Primary Care',
    }))
    setProviderTemplates(mapped)
    showToast('✓ Clinical note templates updated for your profile!')
  }

  const fmtTime = (secs) => {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const getNoteSnippet = (v) => {
    const text = v.final_note || v.ai_draft || v.transcription || ''
    if (!text) {return ''}
    const clean = text.replace(/(\r\n|\n|\r)/gm, ' ').replace(/\s+/g, ' ').trim()
    return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean
  }

  const loadData = useCallback(async () => {
    try {
      const today = getLocalDateStr()
      const [vRes, allRes, pRes] = await Promise.all([
        visitsAPI.getByDate(today).catch(() => null),
        visitsAPI.getAll().catch(() => null),
        patientsAPI.getAll().catch(() => null),
      ])

      const todayVisits = Array.isArray(vRes?.visits) ? vRes.visits : []
      const allVisitsList = Array.isArray(allRes?.visits) ? allRes.visits : []

      setVisits((prev) => {
        const visitMap = new Map()
        // 1. Preserve existing visits in state to prevent disappearance on transient failures/slow responses
        if (Array.isArray(prev)) {
          for (const v of prev) {
            if (v && v.id) visitMap.set(v.id, v)
          }
        }
        // 2. Overlay allVisits (historical records)
        for (const v of allVisitsList) {
          if (v && v.id) {
            visitMap.set(v.id, { ...(visitMap.get(v.id) || {}), ...v })
          }
        }
        // 3. Overlay todayVisits (freshest live statuses for today's visits)
        for (const v of todayVisits) {
          if (v && v.id) {
            visitMap.set(v.id, { ...(visitMap.get(v.id) || {}), ...v })
          }
        }

        // Fallback to sample visits when previewing in local dev server without live backend
        if (visitMap.size === 0 && import.meta.env.DEV && typeof window !== 'undefined' && !window.__VITEST__) {
          for (const v of DEV_MOCK_VISITS) {
            visitMap.set(v.id, v)
          }
        }

        return Array.from(visitMap.values()).sort((a, b) => {
          const dateA = `${a.visit_date || ''} ${a.visit_time || ''}`.trim()
          const dateB = `${b.visit_date || ''} ${b.visit_time || ''}`.trim()
          return dateB.localeCompare(dateA) || (b.id - a.id)
        })
      })

      if (Array.isArray(pRes?.patients)) {
        setPatientList(pRes.patients)
      }

      const candidateVisits = [
        ...todayVisits,
        ...allVisitsList,
        ...(import.meta.env.DEV && !todayVisits.length && !allVisitsList.length && typeof window !== 'undefined' && !window.__VITEST__ ? DEV_MOCK_VISITS : []),
      ]
      if (candidateVisits.length > 0) {
        setActiveDraftNote((prev) => {
          if (!prev) {return null}
          const found = candidateVisits.find((v) => v.id === prev.id)
          if (found) {
            const updatedFinalNote = found.final_note || found.ai_draft || prev.final_note
            if (found.final_note && found.final_note !== prev.final_note) {
              setEditedNoteText((prevText) => {
                if (!prevText || prevText === prev.final_note || prevText === prev.ai_draft) {
                  return found.final_note
                }
                return prevText
              })
            } else if (!prev.final_note && found.ai_draft && !prev.ai_draft) {
              setEditedNoteText((prevText) => {
                if (!prevText) {
                  return found.ai_draft
                }
                return prevText
              })
            }
            return {
              ...prev,
              ...found,
              final_note: updatedFinalNote,
              ai_draft: found.ai_draft || prev.ai_draft,
              status: found.status || prev.status,
            }
          }
          return prev
        })
      }
      return candidateVisits.length > 0 ? candidateVisits : todayVisits
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    let mounted = true

    // Initial load
    void Promise.resolve().then(() => {
      if (mounted) {
        loadData()
      }
    })

    // Immediate sync when window gets focus or tab becomes visible (switching from phone to desktop)
    const handleFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        loadData()
      }
    }
    window.addEventListener('focus', handleFocusOrVisible)
    document.addEventListener('visibilitychange', handleFocusOrVisible)
    window.addEventListener('online', handleFocusOrVisible)

    // Real-time SSE subscription for instant push updates from mobile & server
    const unsubscribeSSE = visitsAPI.subscribeToEvents(
      (eventData) => {
        if (!mounted) {return}
        setLiveSyncConnected(true)

        loadData().then((latestVisits) => {
          if (!mounted || !Array.isArray(latestVisits)) {return}
          const targetVisit = latestVisits.find((v) => v.id === eventData.visitId) || eventData.visit
          const pName = targetVisit?.patient_name || 'Patient'

          if (eventData.source === 'mobile' || eventData.action === 'draft_ready' || eventData.type === 'AI_DRAFT_READY') {
            if (eventData.action === 'created') {
              showToast(`📱 Mobile dictation started for ${pName}`, 'info')
              setMobileActivityBanner({
                visitId: eventData.visitId,
                patientName: pName,
                status: 'recording',
                text: `Mobile dictation in progress for ${pName}`,
              })
            } else if (eventData.action === 'audio_uploaded') {
              showToast(`📱 Mobile audio received for ${pName}. Processing note...`, 'info')
              setMobileActivityBanner({
                visitId: eventData.visitId,
                patientName: pName,
                status: 'processing',
                text: `Audio uploaded from mobile for ${pName} — generating AI draft...`,
              })
            } else if (eventData.action === 'draft_ready' || eventData.type === 'AI_DRAFT_READY') {
              showToast(`✨ Mobile clinical note ready for ${pName}!`, 'success')
              setMobileActivityBanner({
                visitId: eventData.visitId,
                patientName: pName,
                status: 'ready',
                text: `AI clinical note ready for ${pName} from mobile dictation`,
                actionable: true,
                visit: targetVisit,
              })
            }
          }
        })
      },
      () => {
        if (mounted) {
          setLiveSyncConnected(false)
        }
      },
      () => {
        if (mounted) {
          setLiveSyncConnected(true)
        }
      }
    )

    // Adaptive foreground polling: 4s interval (or 2.5s if active processing)
    const hasActiveProcessing = activeDraftNote && !isCompletedVisit(activeDraftNote)
    const pollInterval = hasActiveProcessing ? 2500 : 4000
    const pollId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData()
      }
    }, pollInterval)

    return () => {
      mounted = false
      window.removeEventListener('focus', handleFocusOrVisible)
      document.removeEventListener('visibilitychange', handleFocusOrVisible)
      window.removeEventListener('online', handleFocusOrVisible)
      unsubscribeSSE()
      clearInterval(pollId)
    }
  }, [loadData, activeDraftNote, showToast])

  useEffect(() => {
    const handleSessionExpired = (e) => {
      const msg = e.detail?.message || 'Your session has ended. Please sign in again.'
      showToast(msg, 'error')
    }
    window.addEventListener('anot:session-expired', handleSessionExpired)
    return () => {
      window.removeEventListener('anot:session-expired', handleSessionExpired)
    }
  }, [showToast])

  useEffect(() => {
    return () => {
      clearInterval(timerIntervalRef.current)
      if (animFrameRef.current) {cancelAnimationFrame(animFrameRef.current)}
      if (audioContextRef.current) {
        try { audioContextRef.current.close() } catch { /* ignore */ }
      }
      if (speechRecRef.current) {
        try { speechRecRef.current.stop() } catch { /* ignore */ }
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
          mediaRecorderRef.current.stream?.getTracks().forEach((t) => t.stop())
        } catch { /* ignore */ }
      }
      stopRecordingKeepAlive().catch(() => {})
    }
  }, [])

  // Auto-scroll live transcript
  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight
    }
  }, [liveTranscript])

  const startRecordingSession = async (visit) => {
    if (activeVisit) {
      showToast('A recording is already active.', 'warn')
      return
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Audio recording is not supported on this browser or connection.', 'error')
        return
      }

      if (visit?.id) {
        await consentAPI.recordPatientConsent(visit.id).catch(() => {})
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find(
        (x) => window.MediaRecorder && window.MediaRecorder.isTypeSupported(x)
      ) || ''
      const rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : {})

      audioChunksRef.current = []
      mediaRecorderRef.current = rec
      setAudioStream(stream)

      // Audio meter for mic volume responsiveness
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (AudioCtx) {
          const audioCtx = new AudioCtx()
          audioContextRef.current = audioCtx
          const source = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 64
          source.connect(analyser)
          const dataArr = new Uint8Array(analyser.frequencyBinCount)

          const updateVolume = () => {
            if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {return}
            analyser.getByteFrequencyData(dataArr)
            let sum = 0
            for (let i = 0; i < dataArr.length; i++) {sum += dataArr[i]}
            const avg = sum / dataArr.length
            setMicLevel(Math.min(100, Math.round((avg / 128) * 100)))
            animFrameRef.current = requestAnimationFrame(updateVolume)
          }
          updateVolume()
        }
      } catch { /* ignore */ }

      rec.ondataavailable = (e) => {
        if (e.data?.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      rec.start(1000)
      startRecordingKeepAlive(stream).catch(() => {})

      // Speech Recognition
      setLiveTranscript('')
      liveTranscriptRef.current = ''
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      if (SpeechRecognition) {
        try {
          const sr = new SpeechRecognition()
          sr.continuous = true
          sr.interimResults = true
          sr.lang = 'en-US'

          sr.onresult = (event) => {
            let current = ''
            for (let i = 0; i < event.results.length; i++) {
              current += event.results[i][0].transcript + ' '
            }
            const trimmed = current.trim()
            if (trimmed) {
              setLiveTranscript(trimmed)
              liveTranscriptRef.current = trimmed
            }
          }

          sr.onerror = () => { /* ignore */ }
          sr.onend = () => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              try { sr.start() } catch { /* ignore */ }
            }
          }

          sr.start()
          speechRecRef.current = sr
        } catch { /* ignore */ }
      }

      setActiveVisit(visit)
      setIsPaused(false)
      setTimerSeconds(0)
      setActiveDraftNote(null)

      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)

      showToast(`🎙 Ambient Scribe active! Consulting for ${visit.patient_name || 'Patient'}.`)
    } catch (err) {
      showToast(err?.message || 'Could not access microphone.', 'error')
    }
  }

  const _handleSelectScheduledPatient = (val) => {
    setSelectedPatientIdForEncounter(val)
    if (!val) {
      setPatientNameInput('')
      setPatientMrnInput('')
      setPatientAgeInput('')
      return
    }

    if (val.startsWith('visit-')) {
      const vId = val.replace('visit-', '')
      const v = visits.find((x) => String(x.id) === String(vId))
      if (v) {
        setPatientNameInput(v.patient_name || '')
        setPatientMrnInput(v.mrn || '')
        setPatientAgeInput(getPatientDisplayAge(v, patientList) || '')
      }
    } else {
      const p = patientList.find((x) => String(x.id) === String(val))
      if (p) {
        setPatientNameInput(p.name || '')
        setPatientMrnInput(p.mrn || '')
        setPatientAgeInput(getPatientDisplayAge(p, patientList) || '')
      }
    }
  }

  const handleStartInstantDictation = async (customPatientId = null) => {
    try {
      const now = new Date()
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      
      let patientId = customPatientId || selectedPatientIdForEncounter
      let patientName = patientNameInput.trim()
      let patientMrn = patientMrnInput.trim()
      let patientAge = patientAgeInput.trim()

      let existingVisitId = null
      if (typeof patientId === 'string' && patientId.startsWith('visit-')) {
        existingVisitId = patientId.replace('visit-', '')
        const foundV = visits.find((v) => String(v.id) === String(existingVisitId))
        if (foundV) {
          patientId = foundV.patient_id
          if (!patientName) {patientName = foundV.patient_name || 'Patient'}
          if (!patientMrn) {patientMrn = foundV.mrn || 'Auto-MRN'}
          if (!patientAge) {patientAge = getPatientDisplayAge(foundV, patientList)}
        }
      }

      if (patientId && !patientName && !existingVisitId) {
        const found = patientList.find((p) => String(p.id) === String(patientId))
        if (found) {
          patientName = found.name
          patientMrn = found.mrn
          patientAge = getPatientDisplayAge(found, patientList)
        }
      }

      if (!patientName) {
        patientName = 'Quick Dictation (Unassigned)'
      }

      if (!patientMrn) {
        patientMrn = `TEMP-${now.getTime().toString().slice(-6)}`
      }

      if (!patientAge) {
        patientAge = ''
      }

      // Create or ensure patient record in DB if new name is provided
      if (!patientId && !existingVisitId) {
        try {
          const pRes = await patientsAPI.create({
            name: patientName,
            mrn: patientMrn,
          })
          if (pRes?.patient?.id) {
            patientId = pRes.patient.id
          }
        } catch (e) {
          if (e.payload?.patient?.id) {
            patientId = e.payload.patient.id
          }
        }
      }

      const dbVisitType = normalizeVisitTypeForDb(selectedTemplate)
      let visitId = existingVisitId
      if (!visitId) {
        const vRes = await visitsAPI.create({
          patient_id: patientId || undefined,
          visit_date: patientDateInput || getLocalDateStr(now),
          visit_time: patientTimeInput || timeStr,
          visit_type: dbVisitType,
        })
        visitId = vRes?.visit?.id
      } else {
        await visitsAPI.updateStatus(visitId, 'in-progress').catch(() => {})
      }

      const newVisit = {
        id: visitId,
        patient_id: patientId,
        patient_name: patientName,
        mrn: patientMrn,
        age: patientAge,
        visit_date: getLocalDateStr(now),
        visit_time: timeStr,
        visit_type: dbVisitType,
        status: 'in-progress',
      }

      await startRecordingSession(newVisit)
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to initialize consultation.', 'error')
    }
  }

  const handleStartNewConsultation = () => {
    setActiveDraftNote(null)
    setIsEditingNote(false)
    setEditedNoteText('')
    setSelectedPatientIdForEncounter('')
    setPatientNameInput('')
    setPatientAgeInput('')
    setPatientMrnInput('')
    setPatientDateInput(getLocalDateStr())
    const d = new Date()
    setPatientTimeInput(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
    setDictationNotes('')
    setTab('ambient')
  }

  const openEditPatientModal = (v) => {
    if (!v) {return}
    const isUnassigned = isUnassignedPatient(v)
    setPatientFormData({
      visitId: v.id,
      patientId: v.patient_id || null,
      name: isUnassigned ? '' : (v.patient_name || ''),
      age: (v.age && v.age !== 'Not specified') ? v.age : '',
      dob: v.date_of_birth || '',
      mrn: (v.mrn && !v.mrn.startsWith('TEMP-')) ? v.mrn : '',
      selectedExistingId: v.patient_id ? String(v.patient_id) : '',
    })
    setPatientModalTab('edit')
    setPatientModalOpen(true)
  }

  const handleSavePatientModal = async () => {
    try {
      const { visitId, patientId, name, dob, mrn, selectedExistingId } = patientFormData
      if (patientModalTab === 'link') {
        if (!selectedExistingId) {
          showToast('Please select a patient from the roster.', 'warn')
          return
        }
        const chosen = patientList.find((p) => String(p.id) === String(selectedExistingId))
        if (!chosen) {return}
        await visitsAPI.updateVisit(visitId, { patient_id: chosen.id })
        showToast(`Linked encounter to ${chosen.name}.`, 'success')
      } else {
        const cleanName = name.trim() || 'Patient Encounter'
        const cleanMrn = mrn.trim() || `MRN-${Date.now().toString().slice(-6)}`
        let targetPatientId = patientId

        if (targetPatientId) {
          try {
            await patientsAPI.update(targetPatientId, {
              name: cleanName,
              mrn: cleanMrn,
              date_of_birth: dob || null,
            })
          } catch {
            const created = await patientsAPI.create({
              name: cleanName,
              mrn: cleanMrn,
              date_of_birth: dob || null,
            })
            if (created?.patient?.id) {
              targetPatientId = created.patient.id
              await visitsAPI.updateVisit(visitId, { patient_id: targetPatientId })
            }
          }
        } else {
          const created = await patientsAPI.create({
            name: cleanName,
            mrn: cleanMrn,
            date_of_birth: dob || null,
          })
          if (created?.patient?.id) {
            targetPatientId = created.patient.id
            await visitsAPI.updateVisit(visitId, { patient_id: targetPatientId })
          }
        }
        showToast('Patient details saved successfully.', 'success')
      }

      setPatientModalOpen(false)
      await loadData()

      setActiveDraftNote((prev) => {
        if (!prev || String(prev.id) !== String(visitId)) {return prev}
        const chosen = patientModalTab === 'link'
          ? patientList.find((p) => String(p.id) === String(selectedExistingId))
          : null
        return {
          ...prev,
          patient_name: chosen?.name || patientFormData.name.trim() || prev.patient_name,
          mrn: chosen?.mrn || patientFormData.mrn.trim() || prev.mrn,
          age: chosen?.age || patientFormData.age.trim() || prev.age,
        }
      })
    } catch (err) {
      showToast(err?.message || 'Failed to save patient details.', 'error')
    }
  }

  const handleDeleteClick = (e, visit) => {
    e.stopPropagation()
    setDeleteDialog({
      open: true,
      visit,
      deletePatientAlso: false,
    })
  }

  const handleConfirmDelete = async () => {
    const { visit, deletePatientAlso } = deleteDialog
    if (!visit) {return}
    try {
      if (deletePatientAlso && visit.patient_id) {
        await patientsAPI.delete(visit.patient_id)
        showToast(`Deleted patient ${visit.patient_name || ''} and associated records.`, 'success')
      } else {
        await visitsAPI.deleteVisit(visit.id)
        showToast('Encounter deleted successfully.', 'success')
      }

      if (activeDraftNote?.id === visit.id) {
        setActiveDraftNote(null)
        setIsEditingNote(false)
        setEditedNoteText('')
      }
      if (selectedPatientIdForEncounter === `visit-${visit.id}`) {
        setSelectedPatientIdForEncounter('')
        setPatientNameInput('')
        setPatientAgeInput('')
        setPatientMrnInput('')
      }

      setVisits((prev) => prev.filter((v) => v.id !== visit.id))
      if (deletePatientAlso && visit.patient_id) {
        setPatientList((prev) => prev.filter((p) => p.id !== visit.patient_id))
      }

      setDeleteDialog({ open: false, visit: null, deletePatientAlso: false })
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to delete encounter.', 'error')
    }
  }

  const handlePauseResume = () => {
    const rec = mediaRecorderRef.current
    if (!rec) {return}

    if (isPaused) {
      rec.resume()
      setIsPaused(false)
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = setInterval(() => {
        setTimerSeconds((prev) => prev + 1)
      }, 1000)
      try { speechRecRef.current?.start() } catch { /* ignore */ }
      showToast('Recording resumed')
    } else {
      rec.pause()
      setIsPaused(true)
      clearInterval(timerIntervalRef.current)
      try { speechRecRef.current?.stop() } catch { /* ignore */ }
      showToast('Recording paused')
    }
  }

  const handleEndVisit = async () => {
    const rec = mediaRecorderRef.current
    if (!rec || !activeVisit) {return}

    const duration = timerSeconds
    const durationFormatted = fmtTime(duration)
    setRecordedDuration(durationFormatted)

    clearInterval(timerIntervalRef.current)
    if (speechRecRef.current) {
      try { speechRecRef.current.stop() } catch { /* ignore */ }
      speechRecRef.current = null
    }

    setUploading(true)
    setUploadStatus('Synthesizing structured SOAP documentation & medical coding...')

    const currentActive = { ...activeVisit }
    const capturedSpeech = (liveTranscriptRef.current || liveTranscript || '').trim()
    const scratch = dictationNotes.trim()
    const combinedClinicalText = [capturedSpeech, scratch].filter(Boolean).join('\n\n')

    rec.onstop = async () => {
      try {
        const audioBlob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' })

        if (audioBlob.size > 0) {
          try {
            await visitsAPI.uploadAudio(currentActive.id, audioBlob)
          } catch {
            offlineAudioQueue.addToQueue(audioBlob, currentActive.patient_id, currentActive.id, {
              patientName: currentActive.patient_name,
              durationSeconds: duration,
            }).catch(() => {})
          }
        }

        try {
          await visitsAPI.endVisit(currentActive.id, duration)
        } catch {
          await visitsAPI.updateStatus(currentActive.id, 'recording-uploaded').catch(() => {})
        }

        const generatedSOAP = formatClinicalDictationToSOAP(
          combinedClinicalText,
          scratch,
          currentActive.visit_type,
          {
            patientName: currentActive.patient_name || patientNameInput,
            patientAge: patientAgeInput || getPatientDisplayAge(currentActive, patientList),
            mrn: currentActive.mrn || patientMrnInput,
            template: selectedTemplate,
          }
        )
        try {
          await notesAPI.saveDraft(
            currentActive.id,
            generatedSOAP,
            combinedClinicalText || capturedSpeech,
            generatedSOAP
          )
          const nRes = await notesAPI.getByVisit(currentActive.id)
          if (nRes?.note?.id) {
            await notesAPI.updateNote(nRes.note.id, generatedSOAP)
          }

          const enriched = {
            id: currentActive.id,
            visit_id: currentActive.id,
            note_id: nRes?.note?.id,
            patient_name: currentActive.patient_name,
            mrn: currentActive.mrn || 'Auto-generated',
            visit_type: currentActive.visit_type,
            visit_date: currentActive.visit_date,
            visit_time: currentActive.visit_time,
            final_note: generatedSOAP,
            ai_draft: generatedSOAP,
            transcription: combinedClinicalText || capturedSpeech,
            status: 'draft',
            duration: durationFormatted,
          }

          setActiveDraftNote(enriched)
          setEditedNoteText(generatedSOAP)
          setSelectedAssignPatientId(currentActive.patient_id ? String(currentActive.patient_id) : '')
          showToast(`✓ Clinical SOAP Note & ICD-10 Codes generated!`)

          // Background Claude enhancement
          visitsAPI.generateDraft(currentActive.id, { template: selectedTemplate }).then(async (dRes) => {
            const isUnavailable = !dRes?.ai_draft || dRes.ai_draft.includes('unavailable')

            if (dRes?.ai_draft && !isUnavailable) {
              const refreshedNote = dRes.ai_draft
              if (nRes?.note?.id) {
                await notesAPI.updateNote(nRes.note.id, refreshedNote).catch(() => {})
              }
              setActiveDraftNote((prev) => (prev && prev.id === currentActive.id ? { ...prev, final_note: refreshedNote, ai_draft: refreshedNote } : prev))
              setEditedNoteText(refreshedNote)
              if (dRes.ai_used === false) {
                showToast('⚠ AI note generation failed — note generated from template. Check Admin → Settings → Anthropic API key.', 'error')
              } else {
                showToast('✓ AI note generated by Claude!')
              }
            } else if (dRes?.ai_used === false) {
              showToast('⚠ AI note generation failed — check Anthropic API key in Admin → Settings.', 'error')
            }
          }).catch(() => {})
        } catch (noteErr) {
          console.error('Note formulation error:', noteErr)
        }

        rec.stream?.getTracks().forEach((t) => t.stop())
        stopRecordingKeepAlive().catch(() => {})
        audioChunksRef.current = []
        mediaRecorderRef.current = null
        setAudioStream(null)
        setActiveVisit(null)
        setTimerSeconds(0)
        setIsPaused(false)
        setLiveTranscript('')
        liveTranscriptRef.current = ''
        await loadData()
      } catch (err) {
        showToast(err?.message || 'Failed to complete encounter', 'error')
      } finally {
        setUploading(false)
      }
    }

    if (rec.state !== 'inactive') {
      rec.stop()
    }
  }

  const handleCancelRecording = () => {
    if (speechRecRef.current) {
      try { speechRecRef.current.stop() } catch { /* ignore */ }
      speechRecRef.current = null
    }
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      rec.ondataavailable = null
      rec.stop()
    }
    rec?.stream?.getTracks().forEach((t) => t.stop())
    stopRecordingKeepAlive().catch(() => {})
    audioChunksRef.current = []
    mediaRecorderRef.current = null
    setAudioStream(null)
    setActiveVisit(null)
    setTimerSeconds(0)
    setIsPaused(false)
    setLiveTranscript('')
    liveTranscriptRef.current = ''
    showToast('Recording cancelled and discarded.', 'info')
  }

  const handleCopyFullNote = () => {
    const textToCopy = isEditingNote ? editedNoteText : (activeDraftNote?.final_note || activeDraftNote?.ai_draft || '')
    if (!textToCopy) {return}

    navigator.clipboard.writeText(cleanAiDraftForDisplay(textToCopy)).then(() => {
      setCopiedFullNote(true)
      showToast('✓ Full Note copied to clipboard! Ready to paste into EMR.')
      setTimeout(() => setCopiedFullNote(false), 2500)
    })
  }

  const handleCopySection = (content, index) => {
    if (!content) {return}
    navigator.clipboard.writeText(cleanAiDraftForDisplay(content)).then(() => {
      setCopiedSectionIndex(index)
      showToast('✓ Section copied to clipboard!')
      setTimeout(() => setCopiedSectionIndex(null), 2000)
    })
  }

  const handleSaveEditedNote = async () => {
    if (!activeDraftNote?.note_id) {
      showToast('No note record found to save.', 'warn')
      return
    }
    try {
      await notesAPI.updateNote(activeDraftNote.note_id, editedNoteText)
      setActiveDraftNote((prev) => ({ ...prev, final_note: editedNoteText, ai_draft: editedNoteText }))
      setIsEditingNote(false)
      showToast('✓ Clinical note changes saved successfully!')
      await loadData()
    } catch (err) {
      showToast(err?.message || 'Failed to save note edits.', 'error')
    }
  }

  const handleReviewAndSign = async (visit) => {
    const target = visit || activeDraftNote
    if (!target?.id) {
      showToast('Note record not found to sign.', 'warn')
      return
    }
    try {
      // Call the official clinician lock endpoint POST /api/visits/:id/lock-note
      await visitsAPI.lockNote(target.id)
      showToast('✓ Note locked & signed by clinician!')

      if (activeDraftNote && activeDraftNote.id === target.id) {
        setActiveDraftNote((prev) => ({ ...prev, status: 'uploaded', locked_at: new Date().toISOString() }))
      }

      const freshVisits = await loadData()
      const allVisits = Array.isArray(freshVisits) && freshVisits.length > 0 ? freshVisits : visits

      // Reset filter to 'all' so signed encounters are visible in schedule
      setScheduleFilter('all')

      // Filter remaining pending visits (not completed/signed)
      const remainingPending = allVisits.filter(
        (v) => String(v.id) !== String(target.id) && !isCompletedVisit(v)
      )

      if (remainingPending.length > 0) {
        const nextPatient = remainingPending[0]
        showToast(`Next encounter ready: ${nextPatient.patient_name || 'Patient'}`)
        await handleSelectVisitFromSchedule(nextPatient)
      } else {
        setSelectedPatientIdForEncounter('')
        setPatientNameInput('')
        setPatientMrnInput('')
        setPatientAgeInput('')
        setActiveDraftNote(null)
        setIsEditingNote(false)
        setEditedNoteText('')
        setDictationNotes('')
        setTab('ambient')
      }
    } catch (err) {
      showToast(err?.message || 'Failed to lock note.', 'error')
    }
  }

  const handleRegenerateNote = async () => {
    if (!activeDraftNote?.id) {return}
    setUploading(true)
    setUploadStatus('Generating AI clinical note...')
    try {
      const res = await visitsAPI.generateDraft(activeDraftNote.id).catch(() => null)
      let refreshedText = res?.ai_draft
      const aiUsed = res?.ai_used !== false

      if (!refreshedText || refreshedText.includes('unavailable')) {
        const trans = activeDraftNote.transcription || activeDraftNote.final_note || ''
        refreshedText = formatClinicalDictationToSOAP(
          trans,
          '',
          activeDraftNote.visit_type,
          {
            patientName: activeDraftNote.patient_name,
            patientAge: getPatientDisplayAge(activeDraftNote, patientList),
            mrn: activeDraftNote.mrn,
          }
        )
      }
      if (refreshedText) {
        if (activeDraftNote.note_id) {
          await notesAPI.updateNote(activeDraftNote.note_id, refreshedText).catch(() => {})
        }
        setActiveDraftNote((p) => ({ ...p, final_note: refreshedText, ai_draft: refreshedText }))
        setEditedNoteText(refreshedText)
        if (!aiUsed) {
          showToast('⚠ Claude AI failed — note generated from template. Please check your Anthropic API key in Admin → Settings.', 'error')
        } else {
          showToast('✓ AI Note generated by Claude!')
        }
        await loadData()
      }
    } catch {
      showToast('Failed to regenerate note.', 'error')
    } finally {
      setUploading(false)
    }
  }

  const saveMacrosToStorage = (newList) => {
    setMacros(newList)
    try {
      localStorage.setItem('anot_clinician_macros_v2', JSON.stringify(newList))
    } catch { /* ignore */ }
  }

  const handleOpenAddMacro = () => {
    setEditingMacro(null)
    setMacroForm({ name: '', shortcut: '.', content: '' })
    setMacroModalOpen(true)
  }

  const handleOpenEditMacro = (macro) => {
    setEditingMacro(macro)
    setMacroForm({ name: macro.name, shortcut: macro.shortcut, content: macro.content })
    setMacroModalOpen(true)
  }

  const handleDeleteMacro = (id) => {
    const updated = macros.filter((m) => m.id !== id)
    saveMacrosToStorage(updated)
    showToast('Macro removed.', 'info')
  }

  const handleResetMacros = () => {
    saveMacrosToStorage(DEFAULT_MACROS)
    showToast('Reset macros to standard presets.')
  }

  const handleSaveMacroForm = (e) => {
    if (e && e.preventDefault) {e.preventDefault()}
    if (!macroForm.name.trim() || !macroForm.content.trim()) {
      showToast('Macro Name and Free Text Content are required.', 'warn')
      return
    }

    let shortcut = macroForm.shortcut.trim()
    if (shortcut && !shortcut.startsWith('.')) {
      shortcut = `.${shortcut}`
    }

    if (editingMacro) {
      const updated = macros.map((m) =>
        m.id === editingMacro.id
          ? { ...m, name: macroForm.name.trim(), shortcut: shortcut || `.${macroForm.name.toLowerCase().replace(/\s+/g, '')}`, content: macroForm.content.trim() }
          : m
      )
      saveMacrosToStorage(updated)
      showToast('✓ Macro updated successfully!')
    } else {
      const newMacro = {
        id: `m_${Date.now()}`,
        name: macroForm.name.trim(),
        shortcut: shortcut || `.${macroForm.name.toLowerCase().replace(/\s+/g, '')}`,
        content: macroForm.content.trim(),
      }
      saveMacrosToStorage([...macros, newMacro])
      showToast('✓ New Macro added successfully!')
    }

    setMacroModalOpen(false)
    setEditingMacro(null)
  }

  const handleInsertMacro = (macro) => {
    const textToInsert = macro.content || macro.text || ''
    if (!textToInsert) {return}
    setDictationNotes((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${trimmed}\n\n${textToInsert}` : textToInsert
    })
    showToast(`✓ Added macro: ${macro.name || macro.shortcut}`)
  }

  const _handleInsertSmartChip = (chipText) => {
    setDictationNotes((prev) => {
      const trimmed = prev.trim()
      return trimmed ? `${trimmed}\n${chipText}` : chipText
    })
    showToast(`Added: ${chipText.slice(0, 30)}...`)
  }

  const handleSelectVisitFromSchedule = async (visit) => {
    if (!visit) {return}
    if (activeVisit) {
      showToast('Please finish or pause the active recording before switching encounters.', 'warn')
      return
    }

    const pAge = getPatientDisplayAge(visit, patientList)
    setSelectedPatientIdForEncounter(`visit-${visit.id}`)
    setPatientNameInput(visit.patient_name || '')
    setPatientMrnInput(visit.mrn || '')
    setPatientAgeInput(pAge || '')
    setPatientDateInput(normalizeVisitDate(visit.visit_date) || getLocalDateStr())
    setPatientTimeInput(visit.visit_time || '10:00')

    if (visit.visit_type) {
      const matched = CLINICAL_TEMPLATES.find((t) => t.type === visit.visit_type || t.label.toLowerCase().includes(String(visit.visit_type).toLowerCase()))
      if (matched) {
        setSelectedTemplate(matched.label)
      }
    }

    const hasNoteInMemory = Boolean(visit.final_note || visit.ai_draft)

    if (hasNoteInMemory) {
      // Note is already present in memory: immediately switch to review state with ZERO flash of recording screen
      const initialCombined = {
        ...visit,
        note_id: visit.note_id,
        final_note: visit.final_note,
        ai_draft: visit.ai_draft,
        transcription: visit.transcription,
        status: visit.status,
      }
      setLoadingNoteVisitId(null)
      setActiveDraftNote(initialCombined)
      setIsEditingNote(false)
      setEditedNoteText(initialCombined.final_note || initialCombined.ai_draft || '')
      setDictationNotes('')
      setSelectedAssignPatientId(visit.patient_id ? String(visit.patient_id) : '')
      setRecordedDuration(visit.duration_seconds ? fmtTime(visit.duration_seconds) : '04:12')
      setTab('ambient')
    } else {
      // For any encounter where the note is not yet in memory, show a clean medical loader
      // while querying the backend, guaranteeing ZERO flash of the recording/idle screen
      setLoadingNoteVisitId(visit.id)
      setActiveDraftNote(null)
      setIsEditingNote(false)
      setEditedNoteText('')
      setDictationNotes('')
      setTab('ambient')
    }

    try {
      const res = await notesAPI.getByVisit(visit.id).catch(() => null)
      const noteData = res?.note
      const hasNote = Boolean(noteData?.final_note || noteData?.ai_draft || visit.final_note || visit.ai_draft)

      if (hasNote) {
        const combined = {
          ...visit,
          note_id: noteData?.id || visit.note_id,
          final_note: noteData?.final_note || visit.final_note,
          ai_draft: noteData?.ai_draft || visit.ai_draft,
          transcription: noteData?.transcription || visit.transcription,
          status: noteData?.status || visit.status,
        }
        setActiveDraftNote((prev) => {
          if (prev && prev.id && String(prev.id) !== String(visit.id)) return prev
          return combined
        })
        setEditedNoteText((prevText) => {
          return combined.final_note || combined.ai_draft || prevText
        })
        setSelectedAssignPatientId(visit.patient_id ? String(visit.patient_id) : '')
        setRecordedDuration(visit.duration_seconds ? fmtTime(visit.duration_seconds) : '04:12')
      } else if (!hasNoteInMemory) {
        // No note found on server: encounter is an upcoming/scheduled visit ready to record
        setActiveDraftNote(null)
        setEditedNoteText('')
        setDictationNotes('')
        showToast(`✓ Selected ${visit.patient_name || 'Patient'} · Ready to record!`)
      }
    } catch {
      if (!hasNoteInMemory) {
        setActiveDraftNote(null)
        setEditedNoteText('')
        setDictationNotes('')
        showToast(`✓ Selected ${visit.patient_name || 'Patient'} · Ready to record!`)
      }
    } finally {
      setLoadingNoteVisitId((cur) => (cur === visit.id ? null : cur))
    }
  }

  const handleAfterVisitCreated = async (createdVisit, meta) => {
    const freshVisits = await loadData()
    if (createdVisit?.id) {
      const match = freshVisits?.find((v) => String(v.id) === String(createdVisit.id))
      if (match) {
        await handleSelectVisitFromSchedule(match)
        return
      }
    }
    // Fallback if not immediately in fresh list
    if (createdVisit?.id) {
      setSelectedPatientIdForEncounter(`visit-${createdVisit.id}`)
    }
    if (meta?.finalName) {setPatientNameInput(meta.finalName)}
    if (meta?.newAge) {setPatientAgeInput(meta.newAge)}
    if (meta?.newMrn) {setPatientMrnInput(meta.newMrn)}
    setActiveDraftNote(null)
    setTab('ambient')
  }

  // Determine current active display state
  const isLoadingNote = Boolean(loadingNoteVisitId)
  const isRecordingState = Boolean(activeVisit)
  const isReviewState = Boolean(!activeVisit && activeDraftNote && (activeDraftNote.final_note || activeDraftNote.ai_draft))
  const isIdleState = !isRecordingState && !isReviewState && !isLoadingNote

  const activeNoteSections = isReviewState
    ? parseNoteSections(activeDraftNote.final_note || activeDraftNote.ai_draft)
    : []

  // Filter today's visits vs past encounters
  const todayStr = getLocalDateStr()
  const yesterdayStr = getYesterdayDateStr()

  const countToday = visits.filter((v) => normalizeVisitDate(v.visit_date) === todayStr).length
  const countYesterday = visits.filter((v) => normalizeVisitDate(v.visit_date) === yesterdayStr).length
  const countAll = visits.length

  const dateFilteredVisits = visits.filter((v) => {
    const vDate = normalizeVisitDate(v.visit_date)
    if (scheduleDateFilter === 'today') {
      return vDate === todayStr
    }
    if (scheduleDateFilter === 'yesterday') {
      return vDate === yesterdayStr
    }
    return true
  })

  // Sort reverse chronologically (newest first)
  const sortedVisits = [...dateFilteredVisits].sort((a, b) => {
    const dateA = normalizeVisitDate(a.visit_date) || ''
    const dateB = normalizeVisitDate(b.visit_date) || ''
    if (dateA !== dateB) {
      return dateB.localeCompare(dateA)
    }
    const timeA = a.visit_time || ''
    const timeB = b.visit_time || ''
    return timeB.localeCompare(timeA)
  })

  const filteredVisits = sortedVisits.filter((v) => {
    const hasNote = Boolean(v.final_note || v.ai_draft)
    const isCompleted = isCompletedVisit(v)
    if (scheduleFilter === 'pending' && isCompleted) {return false}
    if (scheduleFilter === 'ready' && !(isCompleted || (hasNote && v.status === 'ready'))) {return false}
    if (scheduleFilter === 'draft' && !(hasNote && !isCompleted)) {return false}
    if (scheduleFilter === 'upcoming' && (hasNote || isCompleted)) {return false}

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      const matchName = (v.patient_name || '').toLowerCase().includes(term)
      const matchMrn = (v.mrn || '').toLowerCase().includes(term)
      const matchNote = (v.final_note || v.ai_draft || '').toLowerCase().includes(term)
      if (!matchName && !matchMrn && !matchNote) {return false}
    }
    return true
  })

  return (
    <div className="sm-portal">
      {/* Toast Notification */}
      {toast && (
        <div className={`sm-toast sm-toast--${toast.type}`}>
          <span className="sm-toast__icon">
            {toast.type === 'error' ? '❌' : toast.type === 'amber' ? '⚠️' : '✓'}
          </span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Real-time Mobile Activity Banner */}
      {mobileActivityBanner && (
        <div className="sm-mobile-banner">
          <div className="sm-mobile-banner__content">
            <span className="sm-mobile-banner__icon">📱</span>
            <div className="sm-mobile-banner__text">
              <strong className="sm-mobile-banner__title">Mobile Activity Detected</strong>
              <span className="sm-mobile-banner__desc">{mobileActivityBanner.text}</span>
            </div>
          </div>
          <div className="sm-mobile-banner__actions">
            {mobileActivityBanner.actionable && mobileActivityBanner.visit && (
              <button
                type="button"
                className="sm-btn-mobile-banner sm-btn-mobile-banner--action"
                onClick={() => {
                  handleSelectVisitFromSchedule(mobileActivityBanner.visit)
                  setMobileActivityBanner(null)
                }}
              >
                Review Note →
              </button>
            )}
            <button
              type="button"
              className="sm-btn-mobile-banner sm-btn-mobile-banner--close"
              onClick={() => setMobileActivityBanner(null)}
              title="Dismiss notification"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Global Clinical Header */}
      <header className="sm-header">
        <div className="sm-header__brand-group">
          <div className="sm-brand" title="Anot Health">
            <img
              src="/brand/anot-logo.png"
              alt="Anot Health"
              className="sm-brand__logo"
            />
          </div>

          <div className="sm-header__divider" />

          <nav className="sm-nav">
            <button
              type="button"
              className={`sm-nav__btn ${tab === 'ambient' ? 'sm-nav__btn--active' : ''}`}
              onClick={() => setTab('ambient')}
            >
              <span className="sm-nav__icon">🎙</span>
              <span>Ambient Scribe</span>
            </button>
            <button
              type="button"
              className={`sm-nav__btn ${tab === 'history' ? 'sm-nav__btn--active' : ''}`}
              onClick={() => setTab('history')}
            >
              <span className="sm-nav__icon">📁</span>
              <span>Note History</span>
              <span className="sm-nav__count">{visits.length}</span>
            </button>
          </nav>
        </div>

        <div className="sm-header__user-group">
          {/* Active Recording Badge with Audio Sensitivity Meter & Sleep Prevention */}
          {isRecordingState && (
            <div className="sm-live-badge-group">
              <div className="sm-live-badge">
                <span className="sm-live-badge__dot" />
                <span className="sm-live-badge__text">LIVE REC</span>
                <div className="sm-mic-meter" title={`Mic sensitivity: ${micLevel}%`}>
                  <span className="sm-mic-meter__bar" style={{ height: `${Math.max(20, micLevel)}%` }} />
                  <span className="sm-mic-meter__bar" style={{ height: `${Math.max(10, micLevel * 0.8)}%` }} />
                  <span className="sm-mic-meter__bar" style={{ height: `${Math.max(30, micLevel * 1.1)}%` }} />
                </div>
              </div>
              <div className="sm-nosleep-badge" title="Screen and system sleep prevention active: PC and mobile will stay awake during consultation">
                <span className="sm-nosleep-icon">☕</span>
                <span className="sm-nosleep-text">No Sleep</span>
              </div>
            </div>
          )}

          <button
            type="button"
            className="sm-btn-nav-tmpl"
            onClick={() => setTemplateModalOpen(true)}
            title="Manage and customize your personal clinical templates"
          >
            <span>📋</span>
            <span>Templates</span>
          </button>

          <div className="sm-clinician-badge">
            <div className="sm-clinician-avatar">
              {currentUser?.name ? currentUser.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() : 'MD'}
            </div>
            <div className="sm-clinician-meta">
              <span className="sm-clinician-name">{currentUser?.name || 'Doctor'}</span>
              {currentUser?.specialty ? (
                <span className="sm-clinician-role">{currentUser.specialty}</span>
              ) : null}
            </div>
          </div>

          <button type="button" className="sm-logout-link" onClick={onLogout} title="Sign Out">
            Sign out
          </button>
        </div>
      </header>

      {/* Main 2-Column Clinical Layout */}
      <main className="sm-workspace">
        {/* ─── LEFT COLUMN: CLINICAL WORKSPACE ─── */}
        <section className="sm-canvas">
          {/* TAB 1: AMBIENT SCRIBE */}
          {tab === 'ambient' && (
            <>
              {/* STATE: LOADING NOTE — smooth medical-grade loading while fetching documentation */}
              {isLoadingNote && (
                <div className="sm-state-loading-note">
                  <div className="sm-note-loading-card">
                    <div className="sm-note-loading-spinner" />
                    <h3 className="sm-note-loading-title">Loading Clinical Documentation</h3>
                    <p className="sm-note-loading-sub">
                      Retrieving clinical note for <strong>{patientNameInput || 'Patient'}</strong>...
                    </p>
                  </div>
                </div>
              )}

              {/* STATE 1a: IDLE — Ready to Record */}
              {isIdleState && (
                <div className="sm-state-idle">
                  {/* 1. TOP: Patient Demographic & Intake Bar */}
                  <div className="sm-patient-intake-card">
                    <div className="sm-patient-intake-header">
                      <div className="sm-patient-intake-badge">
                        <span className="sm-intake-icon">👤</span>
                        <span className="sm-intake-title">Patient Encounter Details</span>
                      </div>
                      <div className="sm-patient-intake-actions-group">
                        {patientNameInput && (
                          <div className="sm-intake-selected-actions">
                            {selectedPatientIdForEncounter && (
                              <span className="sm-intake-linked-tag">
                                ✓ Linked to Visit
                              </span>
                            )}
                            <button
                              type="button"
                              className="sm-btn-clear-patient"
                              onClick={() => {
                                setSelectedPatientIdForEncounter('')
                                setPatientNameInput('')
                                setPatientAgeInput('')
                                setPatientMrnInput('')
                              }}
                              title="Clear patient / start new encounter"
                            >
                              ✕ Clear / New Patient
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="sm-patient-intake-inputs-row">
                      <div className="sm-intake-field sm-intake-field--name">
                        <label className="sm-intake-label">Patient Name *</label>
                        <input
                          type="text"
                          className="sm-intake-input sm-intake-input--name"
                          placeholder="Type patient name (e.g. Jack Smith, Sarah Miller)..."
                          value={patientNameInput}
                          onChange={(e) => {
                            setPatientNameInput(e.target.value)
                            if (selectedPatientIdForEncounter) {setSelectedPatientIdForEncounter('')}
                          }}
                        />
                      </div>

                      <div className="sm-intake-field sm-intake-field--datetime">
                        <label className="sm-intake-label">Date &amp; Time</label>
                        <div className="sm-intake-datetime-group">
                          <input
                            type="date"
                            className="sm-intake-input sm-intake-input--date"
                            value={patientDateInput}
                            onChange={(e) => setPatientDateInput(e.target.value)}
                          />
                          <input
                            type="time"
                            className="sm-intake-input sm-intake-input--time"
                            value={patientTimeInput}
                            onChange={(e) => setPatientTimeInput(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="sm-intake-field sm-intake-field--age">
                        <label className="sm-intake-label">Age / DOB</label>
                        <input
                          type="text"
                          className="sm-intake-input"
                          placeholder="e.g. 36 yrs"
                          value={patientAgeInput}
                          onChange={(e) => setPatientAgeInput(e.target.value)}
                        />
                      </div>

                      <div className="sm-intake-field sm-intake-field--mrn">
                        <label className="sm-intake-label">MRN / PHN / Health Card #</label>
                        <input
                          type="text"
                          className="sm-intake-input"
                          placeholder="e.g. MRN-849201 or PHN / OHIP"
                          value={patientMrnInput}
                          onChange={(e) => setPatientMrnInput(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {/* 2. CENTER: Ultra-Attractive Concentric Halo with In-Orb Timer Console */}
                  <div className="sm-halo-console">
                    {/* Concentric Halo Acoustic Stage */}
                    <div className="sm-halo-stage">
                      <div className="sm-halo-ring sm-halo-ring--3" />
                      <div className="sm-halo-ring sm-halo-ring--2" />
                      <div className="sm-halo-ring sm-halo-ring--1" />

                      {/* Central Frosted Glassmorphic Orb with In-Orb Timer */}
                      <button
                        type="button"
                        className="sm-halo-orb"
                        onClick={() => handleStartInstantDictation()}
                        title={`Click to start ambient consultation${patientNameInput ? ` for ${patientNameInput}` : ''}`}
                      >
                        <div className="sm-halo-orb__mic-icon">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                          </svg>
                        </div>
                        <div className="sm-halo-orb__timer">00:00</div>
                      </button>
                    </div>

                    {/* Prominent Clinical Template Option */}
                    <div className="sm-halo-template-wrapper">
                      <span className="sm-halo-template-label">📋 Template:</span>
                      <select
                        className="sm-halo-template-select"
                        value={selectedTemplate}
                        onChange={(e) => {
                          if (e.target.value === '__manage_templates__') {
                            setTemplateModalOpen(true)
                          } else {
                            setSelectedTemplate(e.target.value)
                          }
                        }}
                      >
                        {renderTemplateOptions(providerTemplates)}
                        <option value="__manage_templates__">⚙️ Edit / Customize Templates...</option>
                      </select>
                      <button
                        type="button"
                        className="sm-btn-edit-templates"
                        onClick={() => setTemplateModalOpen(true)}
                        title="Edit or customize documentation templates for your individual profile"
                      >
                        <span className="sm-edit-tmpl-icon">⚙️</span>
                        <span>Edit Templates</span>
                      </button>
                    </div>

                    {/* High-Impact Glowing Primary Record Button */}
                    <button
                      type="button"
                      className="sm-btn-hero-record sm-btn-hero-record--halo"
                      onClick={() => handleStartInstantDictation()}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                      <span>
                        {patientNameInput ? `Start Recording for ${patientNameInput}` : 'Start Ambient Recording'}
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* STATE 1b: RECORDING — Mic is Live */}
              {isRecordingState && (
                <div className="sm-state-recording">
                  <div className="sm-recording-card">
                    {/* Active Patient Demographic Strip */}
                    <div className="sm-recording-patient-badge">
                      <span className="sm-patient-avatar-mini">👤</span>
                      <span className="sm-rec-patient-name">{activeVisit?.patient_name || 'Quick Dictation'}</span>
                      <span className="sm-meta-divider">•</span>
                      <span className="sm-rec-patient-age">
                        Age: <strong>{getPatientDisplayAge(activeVisit, patientList) || 'Not specified'}</strong>
                      </span>
                      <span className="sm-meta-divider">•</span>
                      <span className="sm-rec-patient-mrn">
                        MRN: <strong>{(activeVisit?.mrn && !activeVisit.mrn.startsWith('TEMP-')) ? activeVisit.mrn : 'Pending'}</strong>
                      </span>
                      <button
                        type="button"
                        className="sm-btn-rec-edit-patient"
                        onClick={() => openEditPatientModal(activeVisit)}
                        title="Add or edit patient details"
                      >
                        ✏️ Edit Patient
                      </button>
                    </div>

                    {/* Live Glowing Mic */}
                    <div className={`sm-rec-mic-halo ${isPaused ? 'sm-rec-mic-halo--paused' : ''}`}>
                      <div className="sm-rec-mic-btn">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                      </div>
                    </div>

                    <div className="sm-clock-display sm-clock-display--live">{fmtTime(timerSeconds)}</div>
                    <div className="sm-status-line">
                      <span className={`sm-status-dot ${isPaused ? 'sm-status-dot--paused' : 'sm-status-dot--live'}`} />
                      <span>{isPaused ? 'Consultation paused' : 'Listening — ambient scribe active'}</span>
                      <span className="sm-nosleep-pill" title="Screen and device sleep prevention active: PC and mobile stay awake">
                        ☕ No Sleep Active
                      </span>
                    </div>

                    {/* Audio Waveform Reaction */}
                    <div className="sm-waveform-wrap">
                      <RecordingVisualizer stream={audioStream} isPaused={isPaused} barCount={24} theme="danger" />
                    </div>

                    {/* Live Speech Recognition Auto-Scroll Bubble */}
                    <div className="sm-live-transcript-card" ref={transcriptScrollRef}>
                      <div className="sm-live-transcript-header">
                        <span className="sm-live-transcript-badge">LIVE TRANSCRIPT</span>
                        <span className="sm-live-transcript-meta">AI streaming dictation...</span>
                      </div>
                      <div className="sm-live-transcript-text">
                        {liveTranscript ? `“${liveTranscript}”` : 'Start speaking naturally with the patient. The ambient scribe is capturing clinical insights in real-time...'}
                      </div>
                    </div>

                    {/* Action Button Controls */}
                    <div className="sm-rec-actions-row">
                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--pause"
                        onClick={handlePauseResume}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>

                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--stop"
                        onClick={handleEndVisit}
                      >
                        <span className="sm-square-icon" />
                        <span>Stop & generate</span>
                      </button>

                      <button
                        type="button"
                        className="sm-btn-action sm-btn-action--cancel"
                        onClick={handleCancelRecording}
                        title="Cancel recording"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Template Selection Pill */}
                    <div className="sm-template-pill">
                      <span className="sm-template-pill__tag">Template</span>
                      <select
                        className="sm-template-pill__select"
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                      >
                        {renderTemplateOptions()}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 1c: AFTER STOP — Review & Complete SOAP Note */}
              {isReviewState && (
                <div className="sm-state-review">
                  {/* Top Back Navigation Bar */}
                  <div className="sm-review-top-bar">
                    <button
                      type="button"
                      className="sm-btn-back-recording"
                      onClick={handleStartNewConsultation}
                      title="Return to Ready to Record (New Consultation)"
                    >
                      <span className="sm-back-arrow">←</span>
                      <span>Back to Recording</span>
                    </button>

                    <div className="sm-review-top-meta">
                      <span className="sm-badge-ai">AI SCRIBED</span>
                      <span className="sm-review-duration">{recordedDuration || '04:12'} recording</span>
                      <span className="sm-review-template">{selectedTemplate || 'SOAP Note — Adult'}</span>
                    </div>
                  </div>

                  {/* Clinical Patient Demographic Header */}
                  <div className="sm-patient-clinical-header">
                    {isUnassignedPatient(activeDraftNote) && (
                      <div className="sm-unassigned-banner">
                        <div className="sm-unassigned-banner__text">
                          <span className="sm-unassigned-icon">⚠️</span>
                          <span><strong>Dictation recorded without patient info.</strong> Add name, age, and MRN to complete this encounter.</span>
                        </div>
                        <button
                          type="button"
                          className="sm-btn-assign-patient"
                          onClick={() => openEditPatientModal(activeDraftNote)}
                        >
                          + Add Patient Details
                        </button>
                      </div>
                    )}

                    <div className="sm-patient-card-main">
                      <div className="sm-patient-avatar-badge">
                        <span className="sm-patient-avatar-icon">👤</span>
                      </div>
                      <div className="sm-patient-identifiers">
                        <div className="sm-patient-name-row">
                          <h2 className="sm-patient-name-title">
                            {activeDraftNote?.patient_name || 'Quick Dictation (Unassigned)'}
                          </h2>
                          <button
                            type="button"
                            className="sm-btn-inline-edit"
                            onClick={() => openEditPatientModal(activeDraftNote)}
                            title="Edit patient details"
                          >
                            ✏️ Edit Patient Info
                          </button>
                          {(() => {
                            const isNoteSigned = isCompletedVisit(activeDraftNote)
                            return (
                              <span className={`sm-patient-status-chip ${isNoteSigned ? 'sm-patient-status-chip--signed' : 'sm-patient-status-chip--draft'}`}>
                                {isNoteSigned ? '🔒 Signed & Locked' : 'Draft Note'}
                              </span>
                            )
                          })()}
                        </div>
                        <div className="sm-patient-meta-row">
                          <span className="sm-meta-item">
                            <strong>Age:</strong> {getPatientDisplayAge(activeDraftNote, patientList) || 'Not specified'}
                          </span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item">
                            <strong>MRN:</strong> {(activeDraftNote?.mrn && !activeDraftNote.mrn.startsWith('TEMP-')) ? activeDraftNote.mrn : 'Not assigned'}
                          </span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item"><strong>Encounter:</strong> {activeDraftNote?.visit_type || selectedTemplate}</span>
                          <span className="sm-meta-divider">•</span>
                          <span className="sm-meta-item"><strong>Date:</strong> {formatEncounterDateTime(activeDraftNote?.visit_date, activeDraftNote?.visit_time)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="sm-patient-actions-group">
                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--copy"
                        onClick={handleCopyFullNote}
                      >
                        {copiedFullNote ? '✓ Copied to EMR!' : '📋 Copy to EMR'}
                      </button>

                      {(() => {
                        const isNoteSigned = isCompletedVisit(activeDraftNote)
                        return (
                          <>
                            <button
                              type="button"
                              className={`sm-btn-doc ${isEditingNote ? 'sm-btn-doc--save' : 'sm-btn-doc--edit'} ${isNoteSigned ? 'sm-btn-doc--disabled' : ''}`}
                              onClick={isNoteSigned ? () => showToast('This note is locked & signed. Edits are disabled.', 'warn') : (isEditingNote ? handleSaveEditedNote : () => {
                                setEditedNoteText(activeDraftNote?.final_note || activeDraftNote?.ai_draft || '')
                                setIsEditingNote(true)
                              })}
                              title={isNoteSigned ? 'Note is locked and cannot be edited' : undefined}
                            >
                              {isEditingNote ? '💾 Save Changes' : (isNoteSigned ? '🔒 Locked' : '✏️ Edit Note')}
                            </button>

                            {!isNoteSigned && (
                              <button
                                type="button"
                                className="sm-btn-doc sm-btn-doc--edit"
                                onClick={handleRegenerateNote}
                                disabled={uploading}
                                title="Regenerate this note using Claude AI"
                              >
                                🤖 AI Regenerate
                              </button>
                            )}

                            <button
                              type="button"
                              className={`sm-btn-doc sm-btn-doc--sign ${isNoteSigned ? 'sm-btn-doc--disabled' : ''}`}
                              onClick={() => !isNoteSigned && handleReviewAndSign(activeDraftNote)}
                              disabled={isNoteSigned}
                              title={isNoteSigned ? 'Note is locked & signed by clinician' : 'Review & Sign note'}
                            >
                              {isNoteSigned ? '✓ Signed & Locked' : '✍️ Review & Sign'}
                            </button>
                          </>
                        )
                      })()}

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--delete"
                        onClick={(e) => handleDeleteClick(e, activeDraftNote)}
                        title="Delete this encounter"
                      >
                        🗑 Delete
                      </button>

                      <button
                        type="button"
                        className="sm-btn-doc sm-btn-doc--new"
                        onClick={handleStartNewConsultation}
                        title="Start another patient consultation"
                      >
                        + New Consultation
                      </button>
                    </div>
                  </div>

                  {/* Note Body: Structured Medical Document View */}
                  {isEditingNote ? (
                    <div className="sm-edit-note-box">
                      <textarea
                        className="sm-edit-note-textarea"
                        value={editedNoteText}
                        onChange={(e) => setEditedNoteText(e.target.value)}
                        rows={18}
                      />
                    </div>
                  ) : (
                    <div className="sm-doc-body">
                      {activeNoteSections.map((sec, idx) => (
                        <div key={idx} className="sm-doc-section">
                          <div className="sm-doc-section__header-row">
                            <span className="sm-doc-section__title">{sec.header}</span>
                            <button
                              type="button"
                              className="sm-btn-copy-sec"
                              onClick={() => handleCopySection(sec.content, idx)}
                              title="Copy this section"
                            >
                              {copiedSectionIndex === idx ? '✓ Copied' : 'Copy'}
                            </button>
                          </div>
                          <div className="sm-doc-section__content">{sec.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* TAB 2: NOTE HISTORY */}
          {tab === 'history' && (
            <div className="sm-history-panel">
              <div className="sm-panel-header sm-panel-header--flex">
                <div>
                  <h2>📁 Consultation & Note History</h2>
                  <p>Review signed and draft clinical documentation for {currentUser?.name ? `${currentUser.name}'s` : 'your'} patients.</p>
                </div>
                <div className="sm-history-header-actions">
                  <div className="sm-history-filter-chips">
                    <button
                      type="button"
                      className={`sm-filter-chip ${historyStatusFilter === 'all' ? 'sm-filter-chip--active' : ''}`}
                      onClick={() => setHistoryStatusFilter('all')}
                    >
                      All ({visits.length})
                    </button>
                    <button
                      type="button"
                      className={`sm-filter-chip ${historyStatusFilter === 'signed' ? 'sm-filter-chip--active' : ''}`}
                      onClick={() => setHistoryStatusFilter('signed')}
                    >
                      Signed ({visits.filter((v) => v.status === 'completed' || v.status === 'uploaded' || v.note_status === 'uploaded' || Boolean(v.locked_at)).length})
                    </button>
                    <button
                      type="button"
                      className={`sm-filter-chip ${historyStatusFilter === 'draft' ? 'sm-filter-chip--active' : ''}`}
                      onClick={() => setHistoryStatusFilter('draft')}
                    >
                      Drafts ({visits.filter((v) => !(v.status === 'completed' || v.status === 'uploaded' || v.note_status === 'uploaded' || Boolean(v.locked_at))).length})
                    </button>
                  </div>
                  <div className="sm-history-search-wrapper">
                    <input
                      type="text"
                      className="sm-search-control"
                      placeholder="🔍 Search name, MRN, date, notes..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                    {searchTerm && (
                      <button
                        type="button"
                        className="sm-search-clear-btn"
                        onClick={() => setSearchTerm('')}
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {(() => {
                const term = searchTerm.trim().toLowerCase()
                const filtered = visits
                  .filter((v) => {
                    // Status filter
                    const isSigned = v.status === 'completed' || v.status === 'uploaded' || v.note_status === 'uploaded' || Boolean(v.locked_at)
                    if (historyStatusFilter === 'signed' && !isSigned) {return false}
                    if (historyStatusFilter === 'draft' && isSigned) {return false}

                    // Search filter
                    if (!term) {return true}
                    const nameMatch = (v.patient_name || '').toLowerCase().includes(term)
                    const mrnMatch = (v.mrn || '').toLowerCase().includes(term)
                    const typeMatch = (v.visit_type || '').toLowerCase().includes(term)
                    const dateMatch = (v.visit_date || '').toLowerCase().includes(term) || formatEncounterDate(v.visit_date).toLowerCase().includes(term)
                    const noteMatch = (v.final_note || '').toLowerCase().includes(term)
                    const draftMatch = (v.ai_draft || '').toLowerCase().includes(term)
                    const txMatch = (v.transcription || '').toLowerCase().includes(term)
                    return nameMatch || mrnMatch || typeMatch || dateMatch || noteMatch || draftMatch || txMatch
                  })
                  .sort((a, b) => {
                    const dateA = `${a.visit_date || ''} ${a.visit_time || ''}`.trim()
                    const dateB = `${b.visit_date || ''} ${b.visit_time || ''}`.trim()
                    return dateB.localeCompare(dateA) || (b.id - a.id)
                  })

                if (filtered.length === 0) {
                  return (
                    <div className="sm-history-empty-card">
                      {visits.length === 0 ? (
                        <>
                          <div className="sm-history-empty-icon">📁</div>
                          <h3>No Consultation Notes Found</h3>
                          <p>All recorded encounters and generated clinical notes will appear here once saved.</p>
                          <button
                            type="button"
                            className="sm-btn-primary sm-history-empty-btn"
                            onClick={() => setTab('ambient')}
                          >
                            + Start Ambient Consultation
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="sm-history-empty-icon">🔍</div>
                          <h3>No matching consultation notes</h3>
                          <p>No notes matched {searchTerm ? `"${searchTerm}"` : 'the active filter'}.</p>
                          <button
                            type="button"
                            className="sm-btn-secondary sm-history-empty-btn"
                            onClick={() => {
                              setSearchTerm('')
                              setHistoryStatusFilter('all')
                            }}
                          >
                            Reset Filters
                          </button>
                        </>
                      )}
                    </div>
                  )
                }

                return (
                  <div className="sm-history-grid">
                    {filtered.map((v) => {
                      const isSigned = v.status === 'completed' || v.status === 'uploaded' || v.note_status === 'uploaded' || Boolean(v.locked_at)
                      const snippet = getNoteSnippet(v)
                      return (
                        <div key={v.id} className="sm-history-card" onClick={() => handleSelectVisitFromSchedule(v)}>
                          <div className="sm-history-card__left">
                            <div className="sm-history-card__name-row">
                              <strong>{v.patient_name || 'Patient'}</strong>
                              <span className="sm-history-card__mrn">{v.mrn || 'Auto-MRN'}</span>
                            </div>
                            <span className="sm-history-card__meta">
                              📅 {formatEncounterDate(v.visit_date)} {v.visit_time ? `· ⏰ ${v.visit_time}` : ''} {v.visit_type ? `· ${v.visit_type}` : ''}
                            </span>
                            {snippet && (
                              <p className="sm-history-card__snippet" title={snippet}>
                                {snippet}
                              </p>
                            )}
                          </div>
                          <div className="sm-history-card__right">
                            <span className={`sm-badge ${isSigned ? 'sm-badge--ready' : 'sm-badge--draft'}`}>
                              {isSigned ? 'SIGNED' : (v.final_note || v.ai_draft ? 'DRAFT' : 'PENDING')}
                            </span>
                            <button
                              type="button"
                              className="sm-btn-sm-view"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedNoteModal(v)
                              }}
                            >
                              View Note
                            </button>
                            <button
                              type="button"
                              className="sm-btn-sm-edit"
                              onClick={(e) => {
                                e.stopPropagation()
                                openEditPatientModal(v)
                              }}
                              title="Edit patient details"
                            >
                              ✏️ Edit
                            </button>
                            <button
                              type="button"
                              className="sm-btn-sm-delete"
                              onClick={(e) => handleDeleteClick(e, v)}
                              title="Delete encounter"
                            >
                              🗑 Delete
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )}
        </section>

        {/* ─── RIGHT COLUMN: CLINICAL SCHEDULE & SCRATCHPAD ─── */}
        <aside className="sm-sidebar">
          {/* Modernized Scribes / Encounters Side Card */}
          <div className="sm-side-card sm-side-card--scribes">
            <div className="sm-side-card__header">
              <div className="sm-side-card__title-group">
                <div className="sm-side-card__title-left">
                  <span className="sm-side-card__title">Scribes</span>
                  <span className="sm-side-card__count">{countAll}</span>
                  <div
                    className="sm-live-sync-indicator"
                    title={liveSyncConnected ? 'Live Sync Active: automatically syncing with mobile app' : 'Syncing with mobile app'}
                  >
                    <span className={`sm-pulse-dot ${liveSyncConnected ? 'sm-pulse-dot--live' : 'sm-pulse-dot--syncing'}`} />
                    <span className="sm-live-sync-label">{liveSyncConnected ? 'Live' : 'Syncing'}</span>
                  </div>
                  <button
                    type="button"
                    className="sm-btn-sync-now"
                    onClick={() => {
                      showToast('↻ Synced with mobile and server', 'info')
                      loadData()
                    }}
                    title="Force refresh from mobile and server"
                  >
                    ↻
                  </button>
                </div>
                <div className="sm-sidebar-actions-group">
                  <button
                    type="button"
                    className="sm-btn-new-patient"
                    onClick={handleStartNewConsultation}
                    title="Start a new patient consultation"
                  >
                    + New patient
                  </button>
                </div>
              </div>

              {/* Date Filter Tabs: Today / Yesterday / All */}
              <div className="sm-date-tabs">
                <button
                  type="button"
                  className={`sm-date-tab ${scheduleDateFilter === 'today' ? 'sm-date-tab--active' : ''}`}
                  onClick={() => {
                    hasUserManuallySelectedDateTabRef.current = true
                    setScheduleDateFilter('today')
                  }}
                >
                  Today ({countToday})
                </button>
                <button
                  type="button"
                  className={`sm-date-tab ${scheduleDateFilter === 'yesterday' ? 'sm-date-tab--active' : ''}`}
                  onClick={() => {
                    hasUserManuallySelectedDateTabRef.current = true
                    setScheduleDateFilter('yesterday')
                  }}
                >
                  Yesterday ({countYesterday})
                </button>
                <button
                  type="button"
                  className={`sm-date-tab ${scheduleDateFilter === 'all' ? 'sm-date-tab--active' : ''}`}
                  onClick={() => {
                    hasUserManuallySelectedDateTabRef.current = true
                    setScheduleDateFilter('all')
                  }}
                >
                  All ({countAll})
                </button>
              </div>

              {/* Option 2: Clean Today Schedule Action Bar */}
              {scheduleDateFilter === 'today' && (
                <div className="sm-today-action-bar">
                  <span className="sm-today-action-label">Today's Schedule</span>
                  <button
                    type="button"
                    className="sm-btn-schedule-patient-link"
                    onClick={() => setScheduleModalOpen(true)}
                    title="Add a patient to today's schedule"
                  >
                    <span className="sm-schedule-icon">📅</span>
                    <span>+ Schedule Patient</span>
                  </button>
                </div>
              )}

              {/* Combined Search Bar + Status Dropdown */}
              <div className="sm-side-controls-row">
                <div className="sm-side-search-wrap">
                  <span className="sm-side-search-icon">🔍</span>
                  <input
                    type="text"
                    className="sm-side-search-input"
                    placeholder="Search patients..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      className="sm-side-search-clear"
                      onClick={() => setSearchTerm('')}
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <select
                  className="sm-side-status-select"
                  value={scheduleFilter}
                  onChange={(e) => setScheduleFilter(e.target.value)}
                  aria-label="Filter encounters by status"
                >
                  <option value="all">All Status</option>
                  <option value="draft">Draft</option>
                  <option value="ready">Signed</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
            </div>

            <div className="sm-visits-container">
              {filteredVisits.length === 0 ? (
                <div className="sm-empty-state sm-empty-state--minimal">
                  <p className="sm-empty-state__message">
                    {scheduleDateFilter === 'today'
                      ? 'No visits recorded for today.'
                      : scheduleDateFilter === 'yesterday'
                        ? 'No scribes recorded for yesterday.'
                        : 'No scribes matching filter.'}
                  </p>
                </div>
              ) : (
                filteredVisits.map((v, index) => {
                  const hasNote = Boolean(v.final_note || v.ai_draft)
                  const isCompleted = isCompletedVisit(v)
                  const isSelected = selectedPatientIdForEncounter === `visit-${v.id}` || activeDraftNote?.id === v.id || activeVisit?.id === v.id
                  const isUnassigned = isUnassignedPatient(v)

                  let badgeText = 'PENDING'
                  let badgeType = 'pending'
                  if (v.status === 'in-progress') {
                    badgeText = '🎙 RECORDING'
                    badgeType = 'recording'
                  } else if (v.status === 'recording-uploaded' || v.transcription_status === 'processing') {
                    badgeText = '⚡ TRANSCRIBING'
                    badgeType = 'transcribing'
                  } else if (isCompleted) {
                    badgeText = 'SIGNED'
                    badgeType = 'signed'
                  } else if (hasNote && v.status === 'ready') {
                    badgeText = 'READY'
                    badgeType = 'ready'
                  } else if (hasNote) {
                    badgeText = 'DRAFT'
                    badgeType = 'draft'
                  } else if (isUnassigned) {
                    badgeText = 'UNASSIGNED'
                    badgeType = 'unassigned'
                  }

                  const currDate = normalizeVisitDate(v.visit_date)
                  const prevDate = index > 0 ? normalizeVisitDate(filteredVisits[index - 1].visit_date) : null
                  const showDateHeader = scheduleDateFilter === 'all' && currDate !== prevDate

                  let dateHeaderTitle = formatEncounterDate(v.visit_date)
                  if (currDate === todayStr) {
                    dateHeaderTitle = 'Today'
                  } else if (currDate === yesterdayStr) {
                    dateHeaderTitle = 'Yesterday'
                  }

                  return (
                    <Fragment key={v.id}>
                      {showDateHeader && (
                        <div className="sm-date-group-header">
                          <span>{dateHeaderTitle}</span>
                        </div>
                      )}
                      <div
                        className={`sm-visit-card sm-visit-card--compact ${isSelected ? 'sm-visit-card--selected' : ''} ${isUnassigned ? 'sm-visit-card--unassigned' : ''}`}
                        onClick={() => handleSelectVisitFromSchedule(v)}
                      >
                        <div className="sm-visit-card__row-main">
                          <strong className="sm-visit-card__name">
                            {v.patient_name || 'Quick Dictation'}
                          </strong>
                          <span className="sm-visit-card__time-badge">
                            {v.visit_time || '10:00'}
                          </span>
                        </div>

                        <div className="sm-visit-card__row-sub">
                          <span className="sm-visit-card__meta-text">
                            {getPatientDisplayAge(v, patientList) ? `Age: ${getPatientDisplayAge(v, patientList)} · ` : ''}
                            {(v.mrn && !v.mrn.startsWith('TEMP-')) ? v.mrn : (isUnassigned ? 'No MRN' : 'Auto-MRN')}
                          </span>
                          <div className="sm-visit-card__status-group">
                            {isSelected && <span className="sm-tag sm-tag--selected">ACTIVE</span>}
                            <span className={`sm-tag sm-tag--${badgeType}`}>{badgeText}</span>
                          </div>
                        </div>
                      </div>
                    </Fragment>
                  )
                })
              )}
            </div>
          </div>
        </aside>
      </main>

      {/* Note Viewer Modal */}
      {selectedNoteModal && (
        <SaintMaryNoteViewerModal
          note={selectedNoteModal}
          noteData={selectedNoteModal}
          currentUser={currentUser}
          onClose={() => setSelectedNoteModal(null)}
          onNoteUpdated={loadData}
          onRegenerateNote={handleRegenerateNote}
          showToast={showToast}
        />
      )}

      {/* Schedule Visit Modal */}
      {scheduleModalOpen && (
        <ScheduleVisitModal
          isOpen={scheduleModalOpen}
          patientList={patientList}
          onClose={() => setScheduleModalOpen(false)}
          onVisitCreated={handleAfterVisitCreated}
          showToast={showToast}
          onLogout={onLogout}
        />
      )}

      {/* Clinical Macros Manager Modal */}
      {macroModalOpen && (
        <ManageMacrosModal
          macros={macros}
          editingMacro={editingMacro}
          macroForm={macroForm}
          setMacroForm={setMacroForm}
          onClose={() => {
            setMacroModalOpen(false)
            setEditingMacro(null)
          }}
          onSave={handleSaveMacroForm}
          onStartAdd={handleOpenAddMacro}
          onStartEdit={handleOpenEditMacro}
          onDelete={handleDeleteMacro}
          onReset={handleResetMacros}
          onInsert={handleInsertMacro}
        />
      )}

      {/* Patient Details Modal */}
      <PatientDetailsModal
        isOpen={patientModalOpen}
        tab={patientModalTab}
        setTab={setPatientModalTab}
        formData={patientFormData}
        setFormData={setPatientFormData}
        patientList={patientList}
        onClose={() => setPatientModalOpen(false)}
        onSave={handleSavePatientModal}
        contextNote={activeDraftNote}
      />

      {/* Delete Encounter Modal */}
      <DeleteEncounterModal
        dialog={deleteDialog}
        setDialog={setDeleteDialog}
        onConfirm={handleConfirmDelete}
      />

      {/* Clinician Template Studio Modal */}
      <ClinicianTemplateModal
        isOpen={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        templates={providerTemplates}
        onSaveTemplates={handleSaveProviderTemplates}
        defaultTemplates={CLINICAL_TEMPLATES}
        currentDoctorName={currentUser?.name || 'Doctor'}
      />
    </div>
  )
}

/**
 * ScheduleVisitModal
 * Allows clinicians to quickly schedule an encounter for Today with an existing or new patient
 */
function ScheduleVisitModal({ isOpen, onClose, patientList, onVisitCreated, showToast, onLogout }) {
  const [patientMode, setPatientMode] = useState('existing')
  const [selectedPatientId, setSelectedPatientId] = useState(patientList[0]?.id ? String(patientList[0].id) : '')
  const [newName, setNewName] = useState('')
  const [newAge, setNewAge] = useState('')
  const [newMrn, setNewMrn] = useState('')
  const [modalError, setModalError] = useState(null)
  const [visitTime, setVisitTime] = useState(() => {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  })
  const [visitType, setVisitType] = useState('SOAP Note — Adult (Standard / Episodic)')
  const [submitting, setSubmitting] = useState(false)

  if (!isOpen) {return null}

  const handleSubmit = async (e) => {
    e.preventDefault()
    setModalError(null)
    setSubmitting(true)
    try {
      let patientId = selectedPatientId
      let finalName = ''

      if (patientMode === 'existing') {
        if (!patientId && patientList.length > 0) {
          patientId = String(patientList[0].id)
        }
        const p = patientList.find((x) => String(x.id) === String(patientId))
        finalName = p?.name || 'Patient'
      } else {
        finalName = newName.trim() || 'New Patient'
        const finalMrn = newMrn.trim() || `MRN-${Date.now().toString().slice(-6)}`
        const pRes = await patientsAPI.create({
          name: finalName,
          mrn: finalMrn,
        })
        patientId = pRes?.patient?.id
      }

      const today = getLocalDateStr()
      const dbVisitType = normalizeVisitTypeForDb(visitType)
      const vRes = await visitsAPI.create({
        patient_id: patientId || undefined,
        visit_date: today,
        visit_time: visitTime,
        visit_type: dbVisitType,
      })

      showToast(`✓ Visit for ${finalName} scheduled for today at ${visitTime}!`)
      if (onVisitCreated) {
        await onVisitCreated(vRes?.visit, { finalName, patientId, newAge, newMrn, visitType })
      }
      onClose()
    } catch (err) {
      const isAuthErr = err?.status === 401 || err?.code === 'SESSION_TERMINATED'
      const msg = err?.message || (isAuthErr ? 'Session expired. Please sign in again.' : 'Failed to schedule visit')
      setModalError(msg)
      if (isAuthErr) {
        showToast(msg, 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal__header">
          <div className="sm-modal__title-group">
            <h3>📅 Schedule Today's Visit</h3>
            <p>Add a new appointment to today's schedule.</p>
          </div>
          <button type="button" className="sm-btn-close-modal" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="sm-schedule-form">
          <div className="sm-schedule-form-body">
            {modalError && (
              <div className="sm-modal-error-banner" role="alert">
                <span>⚠️ {modalError}</span>
                {(modalError.toLowerCase().includes('session') ||
                  modalError.toLowerCase().includes('device') ||
                  modalError.toLowerCase().includes('sign in') ||
                  modalError.toLowerCase().includes('authorized') ||
                  modalError.toLowerCase().includes('authenticat')) && (
                  <a
                    href="/login"
                    onClick={(e) => {
                      e.preventDefault()
                      if (onLogout) {
                        onLogout()
                      } else {
                        globalThis.location.replace('/login')
                      }
                    }}
                  >
                    Sign In Again →
                  </a>
                )}
              </div>
            )}

            {/* Patient Mode Selection */}
            <div className="sm-form-group">
              <label className="sm-form-label">Patient Option</label>
              <div className="sm-segmented-ctrl">
                <button
                  type="button"
                  className={`sm-segmented-btn ${patientMode === 'existing' ? 'sm-segmented-btn--active' : ''}`}
                  onClick={() => {
                    setPatientMode('existing')
                    setModalError(null)
                  }}
                >
                  👥 Registered Patient
                </button>
                <button
                  type="button"
                  className={`sm-segmented-btn ${patientMode === 'new' ? 'sm-segmented-btn--active' : ''}`}
                  onClick={() => {
                    setPatientMode('new')
                    setModalError(null)
                  }}
                >
                  ➕ New Patient
                </button>
              </div>
            </div>

            {patientMode === 'existing' ? (
              <div className="sm-form-group">
                <label className="sm-form-label">Select Clinic Patient *</label>
                <select
                  className="sm-form-select"
                  value={selectedPatientId}
                  onChange={(e) => {
                    setSelectedPatientId(e.target.value)
                    setModalError(null)
                  }}
                  required
                >
                  {patientList.length === 0 && <option value="">No patients found</option>}
                  {patientList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — Age: {getPatientDisplayAge(p, patientList)} ({p.mrn})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="sm-form-grid-3">
                <div className="sm-form-group">
                  <label className="sm-form-label">Patient Name *</label>
                  <input
                    type="text"
                    className="sm-form-input"
                    placeholder="e.g. Eleanor Vance"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value)
                      setModalError(null)
                    }}
                    required
                  />
                </div>
                <div className="sm-form-group">
                  <label className="sm-form-label">Age / DOB</label>
                  <input
                    type="text"
                    className="sm-form-input"
                    placeholder="e.g. 52 yrs"
                    value={newAge}
                    onChange={(e) => {
                      setNewAge(e.target.value)
                      setModalError(null)
                    }}
                  />
                </div>
                <div className="sm-form-group">
                  <label className="sm-form-label">MRN / ID</label>
                  <input
                    type="text"
                    className="sm-form-input"
                    placeholder="e.g. MRN-948123"
                    value={newMrn}
                    onChange={(e) => {
                      setNewMrn(e.target.value)
                      setModalError(null)
                    }}
                  />
                </div>
              </div>
            )}

            <div className="sm-form-grid-2">
              <div className="sm-form-group">
                <label className="sm-form-label">Appointment Time *</label>
                <input
                  type="time"
                  className="sm-form-input"
                  value={visitTime}
                  onChange={(e) => {
                    setVisitTime(e.target.value)
                    setModalError(null)
                  }}
                  required
                />
              </div>

              <div className="sm-form-group">
                <label className="sm-form-label">Encounter Template *</label>
                <select
                  className="sm-form-select"
                  value={visitType}
                  onChange={(e) => {
                    setVisitType(e.target.value)
                    setModalError(null)
                  }}
                >
                  {renderTemplateOptions()}
                </select>
              </div>
            </div>
          </div>

          <div className="sm-schedule-form-footer">
            <button type="button" className="sm-btn-cancel-modal" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="sm-btn-save-schedule" disabled={submitting}>
              {submitting ? 'Scheduling...' : '➕ Add to Today\'s Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * ManageMacrosModal
 * Dedicated modal for creating, editing, and deleting clinician DotPhrases / Free-Text Macros
 */
function ManageMacrosModal({
  macros,
  editingMacro,
  macroForm,
  setMacroForm,
  onClose,
  onSave,
  onStartAdd,
  onStartEdit,
  onDelete,
  onReset,
  onInsert,
}) {
  const [activeTab, setActiveTab] = useState(editingMacro ? 'form' : 'list') // 'list' | 'form'

  const handleEditClick = (m) => {
    onStartEdit(m)
    setActiveTab('form')
  }

  const handleNewClick = () => {
    onStartAdd()
    setActiveTab('form')
  }

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-macro-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal__header">
          <div className="sm-modal__title-group">
            <h3>⚡ Clinical Macros & DotPhrases</h3>
            <p>Create and customize reusable free-text clinical templates for ambient dictation and notes.</p>
          </div>
          <button type="button" className="sm-btn-close-modal" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Subnav */}
        <div className="sm-macro-tabs">
          <button
            type="button"
            className={`sm-macro-tab ${activeTab === 'list' ? 'sm-macro-tab--active' : ''}`}
            onClick={() => setActiveTab('list')}
          >
            📋 All Macros ({macros.length})
          </button>
          <button
            type="button"
            className={`sm-macro-tab ${activeTab === 'form' ? 'sm-macro-tab--active' : ''}`}
            onClick={handleNewClick}
          >
            {editingMacro ? `✏️ Edit: ${editingMacro.name}` : '➕ Add New Macro'}
          </button>
        </div>

        <div className="sm-modal__body sm-macro-modal-body">
          {/* TAB 1: MACRO LIST */}
          {activeTab === 'list' && (
            <div className="sm-macro-list-view">
              <div className="sm-macro-list-header">
                <span>Click <strong>Insert</strong> to add to notes, or <strong>Edit</strong> to modify free text.</span>
                <button type="button" className="sm-btn-reset-macros" onClick={onReset}>
                  ↺ Reset Presets
                </button>
              </div>

              <div className="sm-macro-cards-grid">
                {macros.map((m) => (
                  <div key={m.id} className="sm-macro-card">
                    <div className="sm-macro-card__top">
                      <div className="sm-macro-card__title-row">
                        <span className="sm-macro-card__shortcut">{m.shortcut || '.macro'}</span>
                        <strong className="sm-macro-card__name">{m.name}</strong>
                      </div>
                      <div className="sm-macro-card__actions">
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--insert"
                          onClick={() => {
                            onInsert(m)
                            onClose()
                          }}
                          title="Insert into active scratchpad"
                        >
                          Insert ↵
                        </button>
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--edit"
                          onClick={() => handleEditClick(m)}
                          title="Edit this macro"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          type="button"
                          className="sm-btn-macro-action sm-btn-macro-action--delete"
                          onClick={() => onDelete(m.id)}
                          title="Delete macro"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    <pre className="sm-macro-card__content-preview">{m.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: ADD / EDIT FORM */}
          {activeTab === 'form' && (
            <form onSubmit={onSave} className="sm-macro-form">
              <div className="sm-macro-form__row">
                <div className="sm-macro-field">
                  <label className="sm-macro-label">Macro Name *</label>
                  <input
                    type="text"
                    className="sm-macro-input"
                    placeholder="e.g. Right Knee MSK Exam, Shoulder Findings, Diabetes Plan..."
                    value={macroForm.name}
                    onChange={(e) => setMacroForm((p) => ({ ...p, name: e.target.value }))}
                    required
                  />
                </div>

                <div className="sm-macro-field sm-macro-field--short">
                  <label className="sm-macro-label">Shortcut / DotPhrase</label>
                  <input
                    type="text"
                    className="sm-macro-input"
                    placeholder=".kneemsk"
                    value={macroForm.shortcut}
                    onChange={(e) => setMacroForm((p) => ({ ...p, shortcut: e.target.value }))}
                  />
                </div>
              </div>

              <div className="sm-macro-field">
                <div className="sm-macro-label-row">
                  <label className="sm-macro-label">Free-Text Template Content *</label>
                  <span className="sm-macro-hint">Type or paste your complete clinical documentation text below</span>
                </div>
                <textarea
                  className="sm-macro-textarea"
                  placeholder="Type your clinical template text here... e.g.&#10;PHYSICAL EXAM:&#10;Alert and oriented x3. Lungs clear bilaterally. Heart regular rate and rhythm.&#10;PLAN:&#10;1. Start anti-inflammatory therapy..."
                  value={macroForm.content}
                  onChange={(e) => setMacroForm((p) => ({ ...p, content: e.target.value }))}
                  rows={9}
                  required
                />
              </div>

              <div className="sm-macro-form-footer">
                <button
                  type="button"
                  className="sm-btn-macro-cancel"
                  onClick={() => {
                    setActiveTab('list')
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="sm-btn-macro-save">
                  💾 {editingMacro ? 'Save Macro Changes' : 'Create & Save Macro'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * PatientDetailsModal
 * Allows clinicians to add or edit patient name, age/dob, and MRN, or link to existing patient roster.
 */
function PatientDetailsModal({
  isOpen,
  tab,
  setTab,
  formData,
  setFormData,
  patientList,
  onClose,
  onSave,
  contextNote,
}) {
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

  const detected = useMemo(() => {
    if (!contextNote) return null
    const sourceText = [
      contextNote.transcription,
      contextNote.final_note,
      contextNote.ai_draft,
    ].filter(Boolean).join(' ')
    if (!sourceText) return null

    // Check for "patient [is] Name" or "Mr./Ms./Mrs. Name"
    const nameMatch = sourceText.match(/(?:patient(?:\s+is)?|named?|mr\.|mrs\.|ms\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/i)
    // Check for age pattern
    const ageMatch = sourceText.match(/(\b\d{1,3}\b)\s*(?:-|–|\s)?(?:year-old|years-old|year\s+old|years\s+old|yr|yo|y\.?o\.?)/i)
    const name = nameMatch ? nameMatch[1].trim() : ''
    const age = ageMatch ? ageMatch[1].trim() : ''
    if (name || age) {
      return { name, age }
    }
    return null
  }, [contextNote])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onSave()
  }

  return (
    <div className="sm-modal-backdrop" onClick={onClose}>
      <div className="sm-modal-box sm-modal-box--patient" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal-header">
          <div className="sm-modal-title-group">
            <h3>👤 Patient Encounter Details</h3>
            <span className="sm-modal-subtitle">Add or edit patient information for this consultation</span>
          </div>
          <button type="button" className="sm-modal-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="sm-modal-tabs">
          <button
            type="button"
            className={`sm-modal-tab ${tab === 'edit' ? 'sm-modal-tab--active' : ''}`}
            onClick={() => setTab('edit')}
          >
            Enter Details (New / Edit)
          </button>
          <button
            type="button"
            className={`sm-modal-tab ${tab === 'link' ? 'sm-modal-tab--active' : ''}`}
            onClick={() => setTab('link')}
          >
            Link to Existing Patient ({patientList.length})
          </button>
        </div>

        {detected && tab === 'edit' && (!formData.name || !formData.age) && (
          <div className="sm-ai-detect-banner">
            <span className="sm-ai-detect-icon">💡</span>
            <span className="sm-ai-detect-text">
              <strong>AI Detected:</strong> {detected.name || 'Patient'}{detected.age ? `, ${detected.age} yrs` : ''}
            </span>
            <button
              type="button"
              className="sm-ai-detect-btn"
              onClick={() => {
                setFormData((prev) => ({
                  ...prev,
                  name: prev.name || detected.name || '',
                  age: prev.age || detected.age || '',
                }))
              }}
            >
              Click to Apply
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="sm-modal-body">
            {tab === 'edit' ? (
              <div className="sm-modal-form">
                <div className="sm-form-group">
                  <label>Patient Full Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Sarah Connor, Jack Smith"
                    value={formData.name}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    autoFocus
                    required
                  />
                </div>

                <div className="sm-form-row">
                  <div className="sm-form-group">
                    <label>Age</label>
                    <input
                      type="text"
                      placeholder="e.g. 42 yrs"
                      value={formData.age}
                      onChange={(e) => setFormData((prev) => ({ ...prev, age: e.target.value }))}
                    />
                  </div>

                  <div className="sm-form-group">
                    <label>Date of Birth</label>
                    <input
                      type="date"
                      value={formData.dob}
                      onChange={(e) => setFormData((prev) => ({ ...prev, dob: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="sm-form-group">
                  <label>MRN / PHN / Health Card #</label>
                  <input
                    type="text"
                    placeholder="e.g. MRN-849201"
                    value={formData.mrn}
                    onChange={(e) => setFormData((prev) => ({ ...prev, mrn: e.target.value }))}
                  />
                </div>
              </div>
            ) : (
              <div className="sm-modal-form">
                <div className="sm-form-group">
                  <label>Select Patient from Roster</label>
                  <select
                    value={formData.selectedExistingId}
                    onChange={(e) => setFormData((prev) => ({ ...prev, selectedExistingId: e.target.value }))}
                    autoFocus
                  >
                    <option value="">-- Choose an existing patient --</option>
                    {patientList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.mrn ? `(${p.mrn})` : ''} {p.age ? `· ${p.age} yrs` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="sm-modal-footer">
            <button type="button" className="sm-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="sm-btn-primary">
              Save Patient Details
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * DeleteEncounterModal
 * Confirms deletion of an encounter, with optional deletion of the entire patient.
 */
function DeleteEncounterModal({
  dialog,
  setDialog,
  onConfirm,
}) {
  const closeDialog = () => setDialog({ open: false, visit: null, deletePatientAlso: false })

  useEffect(() => {
    if (!dialog.open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeDialog()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dialog.open])

  if (!dialog.open) {
    return null
  }

  return (
    <div className="sm-modal-backdrop" onClick={closeDialog}>
      <div className="sm-modal-box sm-modal-box--delete" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal-header sm-modal-header--danger">
          <div className="sm-modal-title-group">
            <h3>🗑 Confirm Deletion</h3>
            <span className="sm-modal-subtitle">Permanent action cannot be undone</span>
          </div>
          <button type="button" className="sm-modal-close" onClick={closeDialog} title="Close (Esc)">✕</button>
        </div>
        <div className="sm-modal-body">
          <p>
            Are you sure you want to delete this encounter for <strong>{dialog.visit?.patient_name || 'this patient'}</strong>?
          </p>
          <p className="sm-modal-subtext">
            This action will delete the consultation note, draft, and associated audio permanently.
          </p>

          {dialog.visit?.patient_id && (
            <label className="sm-delete-checkbox-label">
              <input
                type="checkbox"
                checked={dialog.deletePatientAlso}
                onChange={(e) => setDialog((prev) => ({ ...prev, deletePatientAlso: e.target.checked }))}
              />
              <span>Also delete patient <strong>{dialog.visit?.patient_name}</strong> from patient roster</span>
            </label>
          )}
        </div>
        <div className="sm-modal-footer">
          <button
            type="button"
            className="sm-btn-secondary"
            onClick={closeDialog}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sm-btn-danger"
            onClick={onConfirm}
          >
            Delete Encounter
          </button>
        </div>
      </div>
    </div>
  )
}
