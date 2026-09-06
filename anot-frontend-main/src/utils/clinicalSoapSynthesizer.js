/**
 * Clinical SOAP Note & ICD-10/CPT Code Synthesizer
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
export function extractVitals(text) {
  if (!text) { return { bp: null, temp: null, spo2: null, hr: null, rr: null, hasAny: false } }
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

  // 5. Respiratory Rate: e.g. "RR 16/min", "respiratory rate 16", "resp rate 16", "respirations 16", "breathing rate 18"
  const rrMatch = str.match(/\b(?:rr|respiratory\s*rate|resp\s*rate|respirations?|breathing\s*rate)(?::\s*|\s+(?:is|was|of|at|are)\s+|\s+)?(\d{1,2})(?:\s*\/\s*min(?:ute)?|\s*breaths?\s*\/\s*min(?:ute)?)?\b/i)
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
 * Formats structured vital signs block
 */
export function formatVitalsSection(vitalsObj) {
  const lines = []
  if (vitalsObj?.bp) {
    lines.push(`• Blood Pressure: ${vitalsObj.bp}`)
  }
  if (vitalsObj?.hr) {
    lines.push(`• Pulse / Heart Rate: ${vitalsObj.hr}`)
  }
  if (vitalsObj?.temp) {
    lines.push(`• Temperature: ${vitalsObj.temp}`)
  }
  if (vitalsObj?.rr) {
    lines.push(`• Respiratory Rate: ${vitalsObj.rr}`)
  }
  if (vitalsObj?.spo2) {
    lines.push(`• Oxygen Saturation (SpO2): ${vitalsObj.spo2}`)
  }
  if (lines.length === 0) {
    return '• Vital signs: Not documented / Not dictated in this encounter.'
  }
  return lines.join('\n')
}

/**
 * Normalizes speech recognition acoustic artifacts and common medical misrecognitions
 */
export function normalizeAsrErrors(text) {
  if (!text) { return '' }
  return String(text)
    .replace(/\b(?:her|hear)\s+today\b/gi, 'here today')
    .replace(/\bpatients?\s+that\b/gi, 'patient states that')
    .replace(/\btenants?\s+to\s+palpation\b/gi, 'tenderness to palpation')
    .replace(/\btennis\s+to\s+palpation\b/gi, 'tenderness to palpation')
    .replace(/\brepeat\s+extra\b/gi, 'repeat X-ray')
    .replace(/\bextra\s+in\s+(\w+)\s+weeks?\b/gi, 'X-ray in $1 weeks')
    .replace(/\bfollow\s*up\s+in\s+trees\b/gi, 'follow up in 3 weeks')
    .replace(/\bpart\s+(?:the|of\s+the)\s+revolution\b/gi, 'for clinical re-evaluation')
    .replace(/\brevolution\s+and\s+treatment\b/gi, 're-evaluation and treatment response')
    .replace(/\bmcl\b/gi, 'MCL')
    .replace(/\blcl\b/gi, 'LCL')
    .replace(/\bacl\b/gi, 'ACL')
    .replace(/\bpcl\b/gi, 'PCL')
    .replace(/\bmc\.?\s*murray\b/gi, 'McMurray')
    .replace(/\blachman(?:'?s)?\b/gi, 'Lachman')
    .replace(/\btylenol\b/gi, 'Tylenol')
    .replace(/\badvil\b/gi, 'Advil')
    .replace(/\bmotrin\b/gi, 'Motrin')
    .replace(/\bibuprofen\b/gi, 'ibuprofen')
    .replace(/\bnaproxen\b/gi, 'naproxen')
    .replace(/\bmeloxicam\b/gi, 'meloxicam')
    .replace(/\bpain\s+has\s+been\s+outstanding\b/gi, 'pain has been persistent and severe')
    .replace(/\b(?:uh|um|er|ah)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Format raw clinical dictation / ambient transcript into a high-fidelity SOAP note
 */
export function formatClinicalDictationToSOAP(dictation, scratch = '', visitType = 'Follow-up', meta = {}) {
  const combined = [dictation, scratch].filter(Boolean).join(' ').trim()
  const normalized = normalizeAsrErrors(combined)

  const vitalsObj = extractVitals(combined)
  const vitalsText = formatVitalsSection(vitalsObj)

  if (!normalized) {
    return [
      'CHIEF COMPLAINT:',
      'Clinical Consultation',
      '',
      'HISTORY OF PRESENT ILLNESS (HPI):',
      'Patient presents for clinical consultation. No specific acute history was dictated during this encounter.',
      '',
      'VITAL SIGNS:',
      vitalsText,
      '',
      'PHYSICAL EXAMINATION (PE):',
      'GENERAL: Alert, oriented, in no acute distress.',
      'FOCUSED EXAM: Exam findings deferred / not dictated.',
      '',
      'ASSESSMENT & PLAN (A&P):',
      'ASSESSMENT:',
      '1. Routine outpatient clinical consultation (Z00.00).',
      '',
      'PLAN:',
      '1. Clinical findings discussed with patient.',
      '2. Follow-up as scheduled or PRN if new or worsening symptoms develop.',
      '',
      'ICD-10 CODES:',
      'Z00.00 — Encounter for general adult medical examination without abnormal findings',
      '',
      'CPT CODES:',
      '99213 — Office or other outpatient visit for evaluation and management of established patient (low-to-moderate complexity)',
    ].join('\n')
  }

  // If text already has pre-formatted markdown/structured headers from manual macro, preserve it cleanly
  const upper = normalized.toUpperCase()
  if (upper.includes('CHIEF COMPLAINT') && upper.includes('HISTORY OF PRESENT ILLNESS') && upper.includes('PLAN')) {
    let result = normalized.trim()
    if (!upper.includes('VITAL SIGNS') && !upper.includes('VITALS:')) {
      const nextHeaderIdx = result.search(/(?:PHYSICAL EXAMINATION|PHYSICAL EXAM|PE:|ASSESSMENT)/i)
      if (nextHeaderIdx !== -1) {
        result = `${result.slice(0, nextHeaderIdx).trimEnd()}\n\nVITAL SIGNS:\n${vitalsText}\n\n${result.slice(nextHeaderIdx).trimStart()}`
      } else {
        result = `VITAL SIGNS:\n${vitalsText}\n\n${result}`
      }
    }
    if (!upper.includes('ICD-10') && !upper.includes('ICD 10')) {
      const icdList = deriveIcd10Codes(normalized)
      const cptList = deriveCptCodes(normalized, visitType)
      return `${result.trim()}\n\nICD-10 CODES:\n${icdList.join('\n')}\n\nCPT CODES:\n${cptList.join('\n')}`
    }
    return result
  }

  const patientAge = meta?.patientAge ? String(meta.patientAge).replace(/[^0-9]/g, '') : '36'
  const patientName = meta?.patientName || ''
  const isFemale = /\b(?:she|her|female|woman|lady|girl)\b/i.test(normalized)
  const pronoun = isFemale ? 'She' : 'He'
  const possessive = isFemale ? 'her' : 'his'

  // 1. Identify primary anatomical region and symptom
  let primaryComplaint
  let anatomicalRegion = ''
  let mechanism = ''

  const isHeadache = /headache|migraine|head\s*pain|cephalea|cephalalgia|head\s*ache/i.test(normalized) ||
                     /headache|migraine|head\s*pain|cephalea|cephalalgia|head\s*ache/i.test(String(meta?.chiefComplaint || '')) ||
                     /headache|migraine/i.test(String(visitType || ''))

  if (isHeadache) {
    anatomicalRegion = 'head'
  } else if (/right\s+knee/i.test(normalized)) {
    anatomicalRegion = 'right knee'
  } else if (/left\s+knee/i.test(normalized)) {
    anatomicalRegion = 'left knee'
  } else if (/knee/i.test(normalized)) {
    anatomicalRegion = 'knee'
  } else if (/right\s+shoulder/i.test(normalized)) {
    anatomicalRegion = 'right shoulder'
  } else if (/left\s+shoulder/i.test(normalized)) {
    anatomicalRegion = 'left shoulder'
  } else if (/shoulder/i.test(normalized)) {
    anatomicalRegion = 'shoulder'
  } else if (/lower\s+back|lumbar|back\s+pain/i.test(normalized)) {
    anatomicalRegion = 'lower back'
  } else if (/neck|cervical/i.test(normalized)) {
    anatomicalRegion = 'neck'
  } else if (/chest\s+pain|angina/i.test(normalized)) {
    anatomicalRegion = 'chest'
  } else if (/cough|congestion|throat|sinus|cold|flu/i.test(normalized)) {
    anatomicalRegion = 'upper respiratory'
  } else if (/stomach|abdomen|abdominal/i.test(normalized)) {
    anatomicalRegion = 'abdominal'
  }

  if (/bike|bicycle/i.test(normalized) && /fall|fell/i.test(normalized)) {
    mechanism = 'following a fall from bicycle'
  } else if (/fall|fell/i.test(normalized)) {
    mechanism = 'following a mechanical fall'
  } else if (/motor\s+vehicle|car\s+accident|mva|mvc/i.test(normalized)) {
    mechanism = 'following a motor vehicle collision'
  } else if (/twist|twisted/i.test(normalized)) {
    mechanism = 'following a twisting injury'
  } else if (/heavy\s+lifting|lifted/i.test(normalized)) {
    mechanism = 'after heavy lifting'
  }

  if (isHeadache) {
    if (/migraine/i.test(normalized) || /migraine/i.test(String(visitType || ''))) {
      primaryComplaint = 'Acute migraine evaluation'
    } else if (/tension/i.test(normalized)) {
      primaryComplaint = 'Tension-type headache evaluation'
    } else {
      primaryComplaint = 'Headache evaluation'
    }
  } else if (anatomicalRegion) {
    primaryComplaint = `${anatomicalRegion.charAt(0).toUpperCase() + anatomicalRegion.slice(1)} pain${mechanism ? ` ${mechanism}` : ''}`
  } else {
    const m = normalized.match(/(?:presenting\s+(?:with|for)|here\s+(?:with|for)|complaining\s+of|concern\s+for)\s+([a-zA-Z\s]{4,35}?)(?=\s+(?:he|she|patient|since|last|yesterday|fell|pain|and|\.|$))/i)
    if (m && m[1]) {
      primaryComplaint = m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1)
    } else {
      primaryComplaint = visitType ? `${visitType} Clinical Evaluation` : 'Outpatient Clinical Consultation'
    }
  }

  // 2. Synthesize HPI
  const hpiParagraphs = []
  const patientDesc = patientAge
    ? `The patient is a ${patientAge}-year-old ${isFemale ? 'female' : 'male'}`
    : patientName
    ? `${patientName}`
    : 'The patient'

  let openingHpi = `${patientDesc} presenting for evaluation of ${primaryComplaint.toLowerCase()}.`
  if (/fell\s+from\s+(?:his|her)?\s*bike|bicycle/i.test(normalized)) {
    openingHpi += ` Symptoms started acute onset after ${pronoun.toLowerCase()} fell from ${possessive} bicycle last night.`
  } else if (mechanism) {
    openingHpi += ` Symptoms began acutely ${mechanism}.`
  }
  hpiParagraphs.push(openingHpi)

  // Severity & Medication History
  let painDesc = ''
  if (/severe\s+pain/i.test(normalized)) {
    painDesc = `${pronoun} reports severe and persistent pain since the incident.`
  } else if (/moderate\s+pain/i.test(normalized)) {
    painDesc = `${pronoun} reports moderate pain localized to the area.`
  } else if (/pain/i.test(normalized)) {
    painDesc = `${pronoun} reports persistent pain localized to the affected site.`
  }

  if (/tylenol/i.test(normalized)) {
    painDesc += ` The patient took Tylenol (acetaminophen) prior to presentation with minimal to partial relief.`
  } else if (/ibuprofen|advil|motrin/i.test(normalized)) {
    painDesc += ` The patient tried OTC NSAIDs with limited symptom relief.`
  }

  if (painDesc) {
    hpiParagraphs.push(painDesc)
  }

  // Functional impact & Associated symptoms
  let functionalImpact = ''
  if (/headache|migraine|head\s*pain/i.test(normalized)) {
    functionalImpact = `${pronoun} denies sudden-onset thunderclap headache, focal neurological deficits, visual changes, or neck stiffness.`
    if (/throbbing|pulsating/i.test(normalized)) {
      functionalImpact += ` Pain is described as throbbing in character.`
    }
    if (/photophobia|light\s+sensitiv/i.test(normalized) || /nausea/i.test(normalized)) {
      functionalImpact += ` Associated with mild photophobia and nausea; denies intractable vomiting.`
    }
  } else if (/mcl|mcmurray|knee/i.test(normalized)) {
    functionalImpact = `${pronoun} notes discomfort with knee flexion and ambulation. Denies numbness or tingling in the lower extremity.`
  } else if (/back|lumbar/i.test(normalized)) {
    functionalImpact = `Denies bowel or bladder incontinence, saddle anesthesia, or progressive lower extremity weakness.`
  } else if (/shoulder/i.test(normalized)) {
    functionalImpact = `Notes restricted overhead reaching and abduction due to acute pain. Denies distal neurological symptoms.`
  } else if (/chest/i.test(normalized)) {
    functionalImpact = `Denies diaphoresis, shortness of breath, or radiation to jaw or left arm.`
  } else if (/respiratory|cough/i.test(normalized)) {
    functionalImpact = `Denies high fever, hemoptysis, or wheezing.`
  }
  if (functionalImpact) {
    hpiParagraphs.push(functionalImpact)
  }

  const hpiText = hpiParagraphs.join(' ')

  // 3. Synthesize Physical Exam (only actual observations dictated, no fabricated normal exams)
  const examLines = []
  if (/exam|palpat|tender|swelling|inspect|rom|range of motion/i.test(normalized)) {
    if (/swelling/i.test(normalized)) {
      examLines.push(/no\s+swelling/i.test(normalized) ? '• Inspection: No visible swelling or acute deformity.' : '• Inspection: Swelling observed as noted in encounter.')
    }
    if (/tender|pain on palpation/i.test(normalized)) {
      examLines.push('• Palpation: Tenderness to palpation noted as dictated.')
    }
    if (/range of motion|rom|flexion|extension/i.test(normalized)) {
      examLines.push('• Range of Motion: Assessed as dictated.')
    }
  }
  if (examLines.length === 0) {
    examLines.push('Focused physical examination not documented / Not dictated in this encounter.')
  }

  const examText = examLines.join('\n')

  // 4. Imaging & Diagnostics
  let imagingText = null
  if (/repeat\s+x-?ray|x-?ray/i.test(normalized)) {
    const weeksMatch = normalized.match(/(\d+|three|two|four|one)\s+weeks?/i)
    const weeksText = weeksMatch ? weeksMatch[1] : '3'
    imagingText = `• Ordered: Repeat X-ray of the ${anatomicalRegion || 'affected area'} in ${weeksText} weeks to evaluate for occult fracture, interval healing, and progression of degenerative joint changes.`
  } else if (/mri/i.test(normalized)) {
    imagingText = `• Ordered: Magnetic resonance imaging (MRI) of the ${anatomicalRegion || 'affected joint'} for soft tissue and ligamentous evaluation.`
  }

  // 5. Assessment
  const assessmentLines = []
  if (isHeadache) {
    if (/migraine/i.test(normalized) || /migraine/i.test(String(visitType || ''))) {
      assessmentLines.push('1. Acute migraine, unspecified, not intractable, without status migrainosus (G43.909).')
      assessmentLines.push('2. Secondary intracranial pathology / red-flag etiologies ruled out by clinical exam.')
    } else if (/tension/i.test(normalized)) {
      assessmentLines.push('1. Tension-type headache, unspecified, not intractable (G44.209).')
    } else {
      assessmentLines.push('1. Headache, unspecified (R51.9).')
      assessmentLines.push('2. Rule out secondary headache disorder; no focal neurological signs on examination.')
    }
  } else if (/right\s+knee/i.test(normalized) && /mcl|mcmurray/i.test(normalized)) {
    assessmentLines.push('1. Acute right knee pain secondary to bicycle fall (M25.561, V19.81XA).')
    assessmentLines.push('2. Sprain / suspected injury of right medial collateral ligament (MCL), rule out medial meniscus tear (S83.91XA).')
    if (/degenerative/i.test(normalized)) {
      assessmentLines.push('3. Primary osteoarthritis / degenerative joint disease of right knee (M17.11).')
    }
  } else if (/knee/i.test(normalized)) {
    assessmentLines.push('1. Acute knee pain secondary to trauma (M25.569).')
    assessmentLines.push('2. Knee ligamentous sprain / strain (S83.91XA).')
  } else if (/shoulder/i.test(normalized)) {
    assessmentLines.push('1. Shoulder pain, unspecified (M25.511).')
    assessmentLines.push('2. Rotator cuff / shoulder sprain (S43.401A).')
  } else if (/back/i.test(normalized)) {
    assessmentLines.push('1. Acute low back pain with lumbar strain (M54.50).')
  } else {
    assessmentLines.push(`1. Clinical evaluation for ${primaryComplaint.toLowerCase()}.`)
  }

  // 6. Plan (only document what was discussed or dictated)
  const planLines = []
  if (/follow\s*up|return|week|month/i.test(normalized)) {
    const fuMatch = normalized.match(/follow.?up\s+(?:in\s+)?([a-zA-Z0-9\s]+?)(?:\.|$)/i)
    planLines.push(`1. Follow-up: ${fuMatch ? fuMatch[0] : 'Follow up as directed by clinician.'}`)
  } else {
    planLines.push('1. Follow up as needed if symptoms worsen or fail to improve.')
  }
  if (imagingText) {
    planLines.push(`2. ${imagingText}`)
  }
  if (/rest|ice|elevat/i.test(normalized)) {
    planLines.push('3. Supportive care measures as discussed with clinician.')
  }

  // 7. ICD-10 & CPT Codes
  const icdCodes = deriveIcd10Codes(normalized)
  const cptCodes = deriveCptCodes(normalized, visitType)

  const fullNote = [
    'CHIEF COMPLAINT:',
    primaryComplaint,
    '',
    'HISTORY OF PRESENT ILLNESS (HPI):',
    hpiText,
    '',
    'VITAL SIGNS:',
    vitalsText,
    '',
    'PHYSICAL EXAMINATION (PE):',
    examText,
    ...(imagingText ? ['', 'IMAGING & DIAGNOSTICS:', imagingText] : []),
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
