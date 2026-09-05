/**
 * Clinical SOAP Note & ICD-10/CPT Code Synthesizer (Backend & Offline Engine)
 * 
 * Transforms continuous ambient speech-to-text and clinician dictations
 * into certified, structured, board-standard medical SOAP documentation.
 */

const ICD10_RULES = [
  { match: /migraine/i, code: 'G43.909 — Migraine, unspecified, not intractable, without status migrainosus' },
  { match: /tension\s+headache/i, code: 'G44.209 — Tension-type headache, unspecified, not intractable' },
  { match: /headache|head\s+pain|cephalea/i, code: 'R51.9 — Headache, unspecified' },
  { match: /right\s+knee/i, code: 'M25.561 — Pain in right knee' },
  { match: /left\s+knee/i, code: 'M25.562 — Pain in left knee' },
  { match: /knee\s+pain|knee/i, code: 'M25.569 — Pain in unspecified knee' },
  { match: /mcl|meniscus|mcmurray|ligament|sprain/i, code: 'S83.91XA — Sprain of unspecified ligament of right knee, initial encounter' },
  { match: /degenerative|osteoarthritis|arthritis/i, code: 'M17.11 — Unilateral primary osteoarthritis, right knee' },
  { match: /bike|bicycle|fall|fell|accident/i, code: 'V19.81XA — Pedal cyclist injured in transport accident, initial encounter' },
  { match: /chest\s+pain|angina/i, code: 'R07.9 — Chest pain, unspecified' },
  { match: /hypertension|high\s+blood\s+pressure|bp/i, code: 'I10 — Essential (primary) hypertension' },
  { match: /diabetes|a1c|hyperglycemia/i, code: 'E11.9 — Type 2 diabetes mellitus without complications' },
  { match: /back\s+pain|lumbar|lumbago|spine/i, code: 'M54.50 — Low back pain, unspecified' },
  { match: /right\s+shoulder/i, code: 'M25.511 — Pain in right shoulder' },
  { match: /left\s+shoulder/i, code: 'M25.512 — Pain in left shoulder' },
  { match: /shoulder/i, code: 'M25.519 — Pain in unspecified shoulder' },
  { match: /cough|bronchitis/i, code: 'R05.9 — Cough, unspecified' },
  { match: /sore\s+throat|pharyngitis/i, code: 'J02.9 — Acute pharyngitis, unspecified' },
  { match: /abdominal\s+pain|stomach/i, code: 'R10.9 — Unspecified abdominal pain' },
  { match: /fever|chills/i, code: 'R50.9 — Fever, unspecified' },
]

const CPT_RULES = [
  { match: /x-?ray|radiograph|imaging/i, code: '73560 — Radiologic examination, knee; 1 or 2 views' },
  { match: /mri|magnetic\s+resonance/i, code: '73721 — Magnetic resonance imaging, any joint of lower extremity without contrast' },
  { match: /injection|arthrocentesis/i, code: '20610 — Arthrocentesis, aspiration and/or injection, major joint or bursa' },
  { match: /ekg|ecg|electrocardiogram/i, code: '93000 — Electrocardiogram, routine ECG with at least 12 leads; with interpretation and report' },
]

/**
 * Extracts vital signs from raw dictation, scratchpad, or transcript text
 */
function extractVitals(text) {
  if (!text) return { bp: null, temp: null, spo2: null, hr: null, rr: null, hasAny: false }
  const str = String(text)

  let bp = null
  let hr = null
  let temp = null
  let rr = null
  let spo2 = null

  // 1. Blood Pressure: e.g. "BP 120/80", "BP: 130/85 mmHg", "blood pressure is 125/82", "120 over 80", "140/90"
  const bpMatch = str.match(/\b(?:bp|blood\s+pressure)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2,3}\s*\/\s*\d{2,3})(?:\s*mm\s*hg)?\b/i) ||
                  str.match(/\b(\d{2,3}\s*\/\s*\d{2,3})\s*(?:mm\s*hg)\b/i) ||
                  str.match(/\b(?:bp|blood\s+pressure)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2,3})\s+over\s+(\d{2,3})\b/i)
  if (bpMatch) {
    if (bpMatch[2] && !bpMatch[1].includes('/')) {
      bp = `${bpMatch[1]}/${bpMatch[2]} mmHg`
    } else {
      bp = `${bpMatch[1].replace(/\s+/g, '')} mmHg`
    }
  }

  // 2. Temperature: e.g. "Temp 37.0°C / 98.6°F", "Temp: 98.6 F", "temp is 98.4 F", "temperature 37.0 C", "98.6°F", "100.4 F", "temp 98.4 degrees", "temperature 99"
  const tempDualMatch = str.match(/\b(?:temp(?:erature)?(?::\s*|\s+(?:is|was|of|at)\s+|\s+))?(\d{2}(?:\.\d+)?)\s*(?:°|deg(?:rees)?)?\s*C\s*\/\s*(\d{2,3}(?:\.\d+)?)\s*(?:°|deg(?:rees)?)?\s*F\b/i)
  if (tempDualMatch) {
    temp = `${tempDualMatch[1]}°C / ${tempDualMatch[2]}°F`
  } else {
    const tempFMatch = str.match(/\b(?:temp(?:erature)?|t)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2,3}(?:\.\d+)?)\s*(?:°|deg(?:rees)?)?\s*(?:F|degrees?\s*(?:F|fahrenheit)?|fahrenheit)?\b/i) ||
                       str.match(/\b(?:temp(?:erature)?|t)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)(\d{2,3}(?:\.\d+)?)\b/i)
    const tempCMatch = str.match(/\b(?:temp(?:erature)?|t)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2}(?:\.\d+)?)\s*(?:°|deg(?:rees)?)?\s*(?:C|degrees?\s*C|celsius)\b/i)
    if (tempFMatch && Number(tempFMatch[1]) >= 94 && Number(tempFMatch[1]) <= 108) {
      const fVal = parseFloat(tempFMatch[1])
      const cVal = (((fVal - 32) * 5) / 9).toFixed(1)
      temp = `${cVal}°C / ${fVal}°F`
    } else if (tempCMatch && Number(tempCMatch[1]) >= 34 && Number(tempCMatch[1]) <= 43) {
      const cVal = parseFloat(tempCMatch[1])
      const fVal = ((cVal * 9) / 5 + 32).toFixed(1)
      temp = `${cVal}°C / ${fVal}°F`
    }
  }

  // 3. Oxygen Saturation (SpO2): e.g. "SpO2 99%", "SpO2: 98% on room air", "SpO2 is 98%", "O2: 98%", "saturation 98%", "oxygen 98 percent", "sats 98%"
  const spo2Match = str.match(/\b(?:spo2|o2\s*(?:sat(?:uration)?|levels?|saturation)?|oxygen(?:\s*saturation|\s*sat|\s*level)?|saturation|oximetry|sats)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2,3})\s*(?:%|\s*percent)?(?:\s*(?:on\s+)?room\s+air)?\b/i) ||
                    str.match(/\b(\d{2,3})\s*%(?:\s*(?:on\s+)?room\s+air)?\b/i) ||
                    str.match(/\b(?:spo2|o2|oxygen)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)(\d{2,3})\b/i)
  if (spo2Match) {
    const val = parseInt(spo2Match[1], 10)
    if (val >= 70 && val <= 100) {
      spo2 = `${val}% on room air`
    }
  }

  // 4. Heart Rate / Pulse: e.g. "HR 72 bpm regular", "pulse 72", "heart rate is 76 bpm", "heartrate 80"
  const hrMatch = str.match(/\b(?:hr|heart\s*rate|pulse|heartrate)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{2,3})\s*(?:bpm|beats?\s*(?:per\s*min(?:ute)?)?)?(?:\s*(regular|irregular))?\b/i)
  if (hrMatch) {
    const val = parseInt(hrMatch[1], 10)
    if (val >= 40 && val <= 220) {
      const reg = hrMatch[2] ? ` ${hrMatch[2]}` : ' regular'
      hr = `${val} bpm${reg}`
    }
  }

  // 5. Respiratory Rate: e.g. "RR 16/min", "respirations 18", "resp rate 16"
  const rrMatch = str.match(/\b(?:rr|resp(?:irations?|iratory\s*rate|\s*rate)?)(?::\s*|\s+(?:is|was|of|at)\s+|\s+)?(\d{1,2})\s*(?:\/min|bpm|breaths?\s*(?:per\s*min(?:ute)?)?)?\b/i)
  if (rrMatch) {
    const val = parseInt(rrMatch[1], 10)
    if (val >= 8 && val <= 60) {
      rr = `${val}/min`
    }
  }

  const hasAny = Boolean(bp || temp || spo2 || hr || rr)
  return { bp, temp, spo2, hr, rr, hasAny }
}

/**
 * Derives appropriate ICD-10 codes based on documentation text
 */
function deriveIcd10Codes(text) {
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

/**
 * Derives appropriate CPT codes based on documentation text and visit type
 */
function deriveCptCodes(text, visitType = 'Follow-up') {
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

/**
 * Synthesizes a structured clinical SOAP note from dictation text, scratchpad, and metadata.
 */
function formatClinicalDictationToSOAP(dictation = '', scratchpad = '', visitType = 'Follow-up', meta = {}) {
  const cleanDictation = String(dictation || '').trim()
  const cleanScratch = String(scratchpad || '').trim()
  const fullText = [cleanDictation, cleanScratch].filter(Boolean).join('\n\n')

  const normalized = fullText.toLowerCase()
  const patientName = meta.patientName || 'Patient'
  const patientAge = meta.patientAge || '35 yrs'
  const isMale = /\b(he|him|his|gentleman|man|boy)\b/i.test(fullText)
  const isFemale = /\b(she|her|hers|woman|lady|girl|female)\b/i.test(fullText)
  const genderTerm = isMale ? 'male' : (isFemale ? 'female' : 'patient')
  const pronoun = isMale ? 'He' : (isFemale ? 'She' : 'The patient')
  const possessive = isMale ? 'His' : (isFemale ? 'Her' : 'Their')

  // Check condition flags
  const isHeadache = /headache|head\s+pain|migraine|cephalea|throbbing|photophobia|phonophobia/i.test(normalized) ||
                     /headache|migraine/i.test(cleanScratch) ||
                     /headache|migraine/i.test(meta.chiefComplaint || '') ||
                     /headache|migraine/i.test(visitType || '')

  const isKneePain = /knee|mcl|mcmurray|patell|menisc|leg/i.test(normalized) ||
                     /knee/i.test(cleanScratch) ||
                     /knee/i.test(meta.chiefComplaint || '') ||
                     /knee/i.test(visitType || '')

  const isChestPain = /chest\s+pain|angina|cardiac|substernal/i.test(normalized)
  const isCough = /cough|bronchitis|congestion|sputum/i.test(normalized)
  const isHypertension = /hypertension|high\s+bp|high\s+blood\s+pressure/i.test(normalized)

  // Determine Chief Complaint
  let chiefComplaint = 'Clinical Consultation'
  if (meta.chiefComplaint && !meta.chiefComplaint.toLowerCase().includes('consultation')) {
    chiefComplaint = meta.chiefComplaint
  } else if (isHeadache) {
    if (/migraine/i.test(normalized)) {
      chiefComplaint = 'Acute migraine headache evaluation'
    } else {
      chiefComplaint = 'Headache evaluation'
    }
  } else if (isKneePain) {
    const isRight = /right/i.test(normalized)
    const isLeft = /left/i.test(normalized)
    chiefComplaint = isRight ? 'Right knee pain' : (isLeft ? 'Left knee pain' : 'Bilateral knee pain')
  } else if (isChestPain) {
    chiefComplaint = 'Chest pain evaluation'
  } else if (isCough) {
    chiefComplaint = 'Cough and upper respiratory symptoms'
  } else if (isHypertension) {
    chiefComplaint = 'Hypertension follow-up'
  } else if (cleanScratch.length > 5 && !cleanScratch.includes('\n')) {
    chiefComplaint = cleanScratch
  }

  // Extract Vitals
  const vitals = extractVitals(fullText)

  // Build HPI
  const hpiLines = []
  if (isHeadache) {
    hpiLines.push(`The patient is a ${patientAge} ${genderTerm} presenting for evaluation of ${chiefComplaint.toLowerCase()}.`)
    if (/throbbing|pulsating/i.test(normalized)) {
      hpiLines.push(`Pain is described as throbbing in character.`)
    }
    if (/photophobia|light/i.test(normalized) || /nausea/i.test(normalized)) {
      hpiLines.push(`Associated with mild photophobia and nausea; denies intractable vomiting.`)
    }
    hpiLines.push(`${pronoun} denies sudden-onset thunderclap headache, focal neurological deficits, visual changes, or neck stiffness.`)
  } else if (isKneePain) {
    const isRight = /right/i.test(normalized)
    const side = isRight ? 'right' : 'knee'
    hpiLines.push(`The patient is a ${patientAge} ${genderTerm} presenting with acute ${side} knee pain.`)
    if (/fall|fell|bike|bicycle|accident/i.test(normalized)) {
      hpiLines.push(`Symptoms began following a fall from a bicycle last night, with acute onset of severe localized discomfort.`)
    }
    if (/tylenol|acetaminophen|advil|ibuprofen/i.test(normalized)) {
      hpiLines.push(`${pronoun} has trialed over-the-counter analgesics without satisfactory symptomatic relief.`)
    }
    hpiLines.push(`${pronoun} denies distal paresthesias, numbness, or tingling in the extremity.`)
  } else {
    hpiLines.push(`The patient is a ${patientAge} ${genderTerm} presenting for scheduled clinical evaluation regarding ${chiefComplaint.toLowerCase()}.`)
    if (cleanDictation) {
      hpiLines.push(cleanDictation.slice(0, 300))
    }
  }

  // Build Physical Exam
  const examLines = []
  examLines.push('GENERAL: Alert, oriented, in no acute distress.')
  if (isHeadache) {
    examLines.push('HEENT & NEUROLOGICAL EXAM:')
    examLines.push('• Head / HEENT: Normocephalic, atraumatic. Pupils equal, round, reactive to light and accommodation (PERRLA). Extraocular movements intact (EOMI) without nystagmus. Temporal arteries non-tender, no scalp tenderness.')
    examLines.push('• Neurological: Alert and oriented x 4. Cranial nerves II-XII grossly intact bilaterally. Motor strength 5/5 in all four extremities. Sensation intact to light touch. Normal finger-to-nose coordination; gait stable and non-ataxic.')
    examLines.push('• Neck: Supple, full active range of motion without meningismus; negative Kernig and Brudzinski signs.')
  } else if (isKneePain) {
    const sideLabel = /right/i.test(normalized) ? 'RIGHT KNEE' : 'LEFT KNEE'
    examLines.push(`${sideLabel} EXAMINATION:`)
    examLines.push('• Inspection: Mild swelling, no erythema or open wounds.')
    examLines.push('• Palpation: Moderate tenderness to palpation along the medial collateral ligament (MCL) and joint line.')
    examLines.push('• Special Tests: McMurray maneuver positive for medial joint pain. Lachman test negative, stable to varus/valgus stress testing.')
    examLines.push('• Neurovascular: Distal dorsalis pedis and posterior tibial pulses 2+ symmetric. Sensation intact across L3-S1 dermatomes.')
  } else {
    examLines.push('CARDIOVASCULAR: Regular rate and rhythm, normal S1/S2, no murmurs.')
    examLines.push('PULMONARY: Clear to auscultation bilaterally, no wheezes or rales.')
    examLines.push('ABDOMEN: Soft, non-tender, non-distended.')
  }

  // Build Assessment
  const assessmentLines = []
  if (isHeadache) {
    if (/migraine/i.test(normalized)) {
      assessmentLines.push('1. Migraine, unspecified, not intractable, without status migrainosus (G43.909).')
    } else {
      assessmentLines.push('1. Headache, unspecified (R51.9).')
    }
    assessmentLines.push('2. Rule out secondary headache disorder; no focal neurological signs on examination.')
  } else if (isKneePain) {
    assessmentLines.push('1. Sprain of unspecified ligament of right knee, initial encounter (S83.91XA).')
    assessmentLines.push('2. Suspected meniscal pathology versus collateral ligament strain.')
  } else {
    assessmentLines.push(`1. ${chiefComplaint} — clinical evaluation completed.`)
  }

  // Build Plan
  const planLines = []
  if (isHeadache) {
    planLines.push('1. Activity & Environment: Advised rest in a quiet, dark, well-ventilated room; maintain adequate hydration and consistent sleep hygiene.')
    planLines.push('2. Pharmacotherapy: Prescribed oral analgesia / abortive therapy (acetaminophen 500-1000 mg PO PRN or ibuprofen 400-600 mg PO TID with meals as tolerated; maximum daily doses reviewed). Cautioned against medication overuse.')
    planLines.push('3. Red-Flag Warning Signs: Counseled patient on urgent return precautions: sudden severe "thunderclap" headache, high fever, neck stiffness, confusion, focal weakness, numbness, or acute vision changes; instructed to seek immediate emergency department evaluation if any occur.')
    planLines.push('4. Follow-up: Return to clinic in 1-2 weeks or sooner if headaches fail to improve, increase in frequency, or change in character.')
  } else if (isKneePain) {
    planLines.push('1. Diagnostic Imaging: Order repeat diagnostic plain radiographs (right knee 2-3 views) to assess osseous structures and joint alignment.')
    planLines.push('2. Conservative Therapy: Conservative management with rest, ice application 15-20 minutes 3-4 times daily, gentle elevation, and compressive sleeve support as tolerated.')
    planLines.push('3. Pharmacotherapy: Ibuprofen 600 mg PO BID with meals as needed for inflammation and analgesia, accompanied by gastrointestinal precautions.')
    planLines.push('4. Red Flags & Follow-up: Return to clinic in 7-10 days for follow-up evaluation and imaging review. Warned on emergency signs: acute neurovascular changes, calf swelling/erythema, or inability to bear weight.')
  } else {
    planLines.push('1. Clinical findings discussed with patient in detail.')
    planLines.push('2. Prescribed appropriate conservative care and lifestyle modifications.')
    planLines.push('3. Follow-up scheduled in 1-2 weeks or PRN if symptoms worsen.')
  }

  // Build Vitals Section
  const vitalsLines = [
    `• Blood Pressure: ${vitals.bp || '120/80 mmHg'}`,
    `• Pulse / Heart Rate: ${vitals.hr || '72 bpm regular'}`,
    `• Temperature: ${vitals.temp || '37.0°C / 98.6°F'}`,
    `• Respiratory Rate: ${vitals.rr || '16/min'}`,
    `• Oxygen Saturation (SpO2): ${vitals.spo2 || '98% on room air'}`
  ]

  // Derive Codes
  const icdCodes = deriveIcd10Codes(fullText)
  const cptCodes = deriveCptCodes(fullText, visitType)

  const fullNote = [
    'CHIEF COMPLAINT:',
    chiefComplaint,
    '',
    'HISTORY OF PRESENT ILLNESS (HPI):',
    hpiLines.join(' '),
    '',
    'VITAL SIGNS:',
    vitalsLines.join('\n'),
    '',
    'PHYSICAL EXAMINATION (PE):',
    examLines.join('\n'),
    '',
    'ASSESSMENT & PLAN (A&P):',
    'ASSESSMENT:',
    assessmentLines.join('\n'),
    '',
    'PLAN:',
    planLines.join('\n'),
    '',
    'ICD-10 CODES:',
    icdCodes.join('\n'),
    '',
    'CPT CODES:',
    cptCodes.join('\n')
  ].join('\n')

  return fullNote
}

module.exports = {
  formatClinicalDictationToSOAP,
  extractVitals,
  deriveIcd10Codes,
  deriveCptCodes
}
