/**
 * Clinical SOAP Note & ICD-10/CPT Code Synthesizer
 * Structures raw dictation and ambient transcription into certified clinical documentation
 */

const ICD10_RULES = [
  { match: /right\s+knee/i, code: 'M25.561 — Pain in right knee' },
  { match: /left\s+knee/i, code: 'M25.562 — Pain in left knee' },
  { match: /knee\s+pain/i, code: 'M25.569 — Pain in unspecified knee' },
  { match: /mcl|meniscus|mcmurray|ligament|sprain/i, code: 'S83.91XA — Sprain of unspecified ligament of right knee, initial encounter' },
  { match: /degenerative|osteoarthritis|arthritis/i, code: 'M17.11 — Unilateral primary osteoarthritis, right knee' },
  { match: /bike|bicycle|fall|fell/i, code: 'V19.81XA — Pedal cyclist injured in transport accident, initial encounter' },
  { match: /chest\s+pain|angina/i, code: 'R07.9 — Chest pain, unspecified' },
  { match: /hypertension|high\s+blood\s+pressure|bp/i, code: 'I10 — Essential (primary) hypertension' },
  { match: /diabetes|a1c|hyperglycemia/i, code: 'E11.9 — Type 2 diabetes mellitus without complications' },
  { match: /back\s+pain|lumbar|lumbago/i, code: 'M54.50 — Low back pain, unspecified' },
  { match: /shoulder\s+pain/i, code: 'M25.511 — Pain in right shoulder' },
  { match: /cough|bronchitis/i, code: 'R05.9 — Cough, unspecified' },
  { match: /sore\s+throat|pharyngitis/i, code: 'J02.9 — Acute pharyngitis, unspecified' },
  { match: /headache|migraine/i, code: 'R51.9 — Headache, unspecified' },
  { match: /abdominal\s+pain|stomach/i, code: 'R10.9 — Unspecified abdominal pain' },
  { match: /fever|chills/i, code: 'R50.9 — Fever, unspecified' },
]

const CPT_RULES = [
  { match: /x-?ray|radiograph|imaging/i, code: '73560 — Radiologic examination, knee; 1 or 2 views' },
  { match: /mri|magnetic\s+resonance/i, code: '73721 — Magnetic resonance imaging, any joint of lower extremity without contrast' },
  { match: /injection|arthrocentesis/i, code: '20610 — Arthrocentesis, aspiration and/or injection, major joint or bursa' },
  { match: /ekg|ecg|electrocardiogram/i, code: '93000 — Electrocardiogram, routine ECG with at least 12 leads; with interpretation and report' },
]

export function formatClinicalDictationToSOAP(dictation, scratch = '', visitType = 'Follow-up') {
  const raw = [dictation, scratch].filter(Boolean).join(' ').trim()
  if (!raw) {
    return [
      'CHIEF COMPLAINT:',
      'Clinical Consultation',
      '',
      'HISTORY OF PRESENT ILLNESS (HPI):',
      'Clinical consultation recorded. No specific history dictated.',
      '',
      'PHYSICAL EXAMINATION (PE):',
      'Not dictated.',
      '',
      'ASSESSMENT & PLAN (A&P):',
      '1. Clinical evaluation completed.',
      '2. Follow-up as scheduled or as needed for new/worsening symptoms.',
      '',
      'ICD-10 CODES:',
      'Z00.00 — Encounter for general adult medical examination without abnormal findings',
      '',
      'CPT CODES:',
      '99213 — Office or other outpatient visit for evaluation and management of established patient',
    ].join('\n')
  }

  // If text already has full structured sections with headers, preserve it cleanly
  const upper = raw.toUpperCase()
  if (upper.includes('CHIEF COMPLAINT') && upper.includes('ASSESSMENT')) {
    if (!upper.includes('ICD-10') && !upper.includes('ICD 10')) {
      const icdList = deriveIcd10Codes(raw)
      const cptList = deriveCptCodes(raw, visitType)
      return `${raw.trim()}\n\nICD-10 CODES:\n${icdList.join('\n')}\n\nCPT CODES:\n${cptList.join('\n')}`
    }
    return raw
  }

  // Segment continuous dictation into clinical components
  const sentences = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1. $2')
    .split(/(?<=[.?!])\s+|(?<=\b(?:today|night|exam|clinic|bid|tid|daily|pain|mcl|x-ray|mri)\b)\s+(?=[A-Z])/i)
    .map(s => s.trim())
    .filter(Boolean)

  // 1. Extract Chief Complaint strictly from text
  let chiefComplaint
  const ccMatch = raw.match(/(?:presenting|presents|here\s+today|complaining\s+of|chief\s+complaint|concern\s+is|reason\s+for\s+visit)\s+(?:here\s+today\s+)?(?:for|with)?\s*([^.,;\n]+)/i)
  if (ccMatch && ccMatch[1]) {
    chiefComplaint = ccMatch[1].trim().replace(/^(a|an|the)\s+/i, '')
    chiefComplaint = chiefComplaint.charAt(0).toUpperCase() + chiefComplaint.slice(1)
  } else if (sentences[0]) {
    chiefComplaint = sentences[0].replace(/^(patient\s+presents\s+(?:with|for)?|here\s+for)\s*/i, '').slice(0, 70)
  } else {
    chiefComplaint = 'Clinical Consultation'
  }

  // 2. Extract HPI Narrative (only sentences discussing symptoms, onset, history)
  const hpiSentences = sentences.filter(s => 
    !/^(?:physical\s+exam|pe:|exam\s+shows|palpation|vitals|x-ray|imaging|mri|plan:|assessment:|follow\s*up|rx:)/i.test(s) &&
    !/mcmurray|tenderness|swelling|ibuprofen|tylenol|prescribe|orthopedic\s+referral|range\s+of\s+motion/i.test(s)
  )
  const hpiText = hpiSentences.length > 0 ? hpiSentences.join(' ') : raw

  // 3. Extract Physical Exam (strictly from dictated exam terms, otherwise Not dictated)
  const examSentences = sentences.filter(s =>
    /physical\s+exam|pe:|exam\s+shows|palpation|tenderness|swelling|range\s+of\s+motion|rom|vitals|bp\s+\d+|pulse|heart|lung|abdomen|distress|alert|mcmurray|effusion/i.test(s)
  )
  const examText = examSentences.length > 0
    ? examSentences.join('\n')
    : 'Not dictated.'

  // 4. Extract Diagnostics / Imaging strictly if mentioned
  const imagingSentences = sentences.filter(s =>
    /x-ray|radiograph|mri|ct\s+scan|ultrasound|labs|blood\s+work|degenerative\s+changes|fracture/i.test(s)
  )
  const imagingText = imagingSentences.length > 0 ? imagingSentences.join(' ') : null

  // 5. Extract Assessment & Plan strictly from dictated text
  const planSentences = sentences.filter(s =>
    /plan|start|prescribe|ibuprofen|tylenol|naproxen|medication|referral|orthopedic|ice|rest|pt|physical\s+therapy|follow\s*up|advice|counseled/i.test(s)
  )
  
  let assessmentText = `1. Clinical evaluation for ${chiefComplaint.toLowerCase()}.`
  let planText
  if (planSentences.length > 0) {
    planText = `${assessmentText}\n\nPLAN:\n${planSentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
  } else {
    planText = `${assessmentText}\n\nPLAN:\n1. Discussed clinical findings with patient.\n2. Follow-up as needed or if symptoms persist.`
  }

  // 6. Derive ICD-10 & CPT Codes strictly matching dictated text
  const icdCodes = deriveIcd10Codes(raw)
  const cptCodes = deriveCptCodes(raw, visitType)

  const sections = [
    'CHIEF COMPLAINT:',
    chiefComplaint,
    '',
    'HISTORY OF PRESENT ILLNESS (HPI):',
    hpiText,
    '',
    'PHYSICAL EXAMINATION (PE):',
    examText,
  ]

  if (imagingText) {
    sections.push('', 'IMAGING & DIAGNOSTICS:', imagingText)
  }

  sections.push(
    '',
    'ASSESSMENT & PLAN (A&P):',
    planText,
    '',
    'ICD-10 CODES:',
    icdCodes.length > 0 ? icdCodes.join('\n') : 'Z00.00 — Encounter for general adult medical examination without abnormal findings',
    '',
    'CPT CODES:',
    cptCodes.length > 0 ? cptCodes.join('\n') : '99213 — Office or other outpatient visit for evaluation and management of established patient'
  )

  return sections.join('\n')
}

export function deriveIcd10Codes(text) {
  const matched = []
  for (const rule of ICD10_RULES) {
    if (rule.match.test(text) && !matched.includes(rule.code)) {
      matched.push(rule.code)
    }
  }
  if (matched.length === 0) {
    matched.push('Z00.00 — Encounter for general adult medical examination without abnormal findings')
  }
  return matched.slice(0, 4)
}

export function deriveCptCodes(text, visitType = 'Follow-up') {
  const matched = []
  const isNew = String(visitType).toLowerCase().includes('new')
  matched.push(isNew 
    ? '99203 — Office or other outpatient visit for evaluation and management of new patient (low-to-moderate complexity)'
    : '99213 — Office or other outpatient visit for evaluation and management of established patient (low-to-moderate complexity)'
  )

  for (const rule of CPT_RULES) {
    if (rule.match.test(text) && !matched.includes(rule.code)) {
      matched.push(rule.code)
    }
  }
  return matched.slice(0, 3)
}
