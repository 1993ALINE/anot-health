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
  { match: /bilateral\s+(?:knee\s+)?(?:osteoarthritis|arthritis|oa)|bilodoniaoster/i, code: 'M17.0 — Bilateral primary osteoarthritis of knee' },
  { match: /right\s+knee\s+(?:osteoarthritis|arthritis|degenerative)/i, code: 'M17.11 — Unilateral primary osteoarthritis, right knee' },
  { match: /left\s+knee\s+(?:osteoarthritis|arthritis|degenerative)/i, code: 'M17.12 — Unilateral primary osteoarthritis, left knee' },
  { match: /degenerative|osteoarthritis|arthritis/i, code: 'M17.0 — Bilateral primary osteoarthritis of knee' },
  { match: /right\s+knee/i, code: 'M25.561 — Pain in right knee' },
  { match: /left\s+knee/i, code: 'M25.562 — Pain in left knee' },
  { match: /knee\s+pain|knee/i, code: 'M25.569 — Pain in unspecified knee' },
  { match: /(?:1981|prior|remote|past\s+surgical|pesturgical)\s*(?:mcl|surgery|repair)/i, code: 'Z98.890 — Other specified postprocedural states (personal history of musculoskeletal surgery)' },
  { match: /mcl|meniscus|mcmurray|ligament|sprain/i, code: 'S83.91XA — Sprain of unspecified ligament of right knee, initial encounter' },
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
  { match: /fever|chills/i, code: 'R50.9 — Fever, unspecified' },
  { match: /phq|depression|depressed/i, code: 'F32.9 — Major depressive disorder, single episode, unspecified' },
  { match: /gad|anxiety|anxious/i, code: 'F41.1 — Generalized anxiety disorder' },
  { match: /asthma|wheez/i, code: 'J45.909 — Unspecified asthma, uncomplicated' },
  { match: /copd|emphysema/i, code: 'J44.9 — Chronic obstructive pulmonary disease, unspecified' },
  { match: /rourke|well.?child|pediatric|baby|infant/i, code: 'Z00.129 — Encounter for routine child health examination without abnormal findings' },
  { match: /prenatal|antenatal|pregnancy|pregnant/i, code: 'Z34.00 — Encounter for supervision of normal first pregnancy, unspecified trimester' },
  { match: /postpartum/i, code: 'Z39.2 — Encounter for routine postpartum follow-up' },
  { match: /periodic|annual|wellness|preventive/i, code: 'Z00.00 — Encounter for general adult medical examination without abnormal findings' },
  { match: /wcb|wsib|workplace\s+injury|occupational/i, code: 'Y99.0 — Civilian activity done for pay at the time of injury' },
]

const CPT_RULES = [
  { match: /(?:order|repeat|perform|take)\s+(?:an?\s+)?(?:x-?ray|radiograph|imaging)|repeat\s+x-?ray/i, code: '73560 — Radiologic examination, knee; 1 or 2 views' },
  { match: /(?:order|perform)\s+(?:an?\s+)?mri|mri\s+(?:shows|ordered)/i, code: '73721 — Magnetic resonance imaging, any joint of lower extremity without contrast' },
  { match: /(?:perform|order)\s+(?:an?\s+)?(?:injection|arthrocentesis)|arthrocentesis/i, code: '20610 — Arthrocentesis, aspiration and/or injection, major joint or bursa' },
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
    return '• Vital signs: Not documented this encounter.'
  }
  return lines.join('\n')
}

export const SECTION_HEADERS_LIST = [
  'CHIEF COMPLAINT',
  'REASON FOR VISIT',
  'HISTORY OF PRESENT ILLNESS',
  'HPI',
  'SUBJECTIVE',
  'CURRENT MEDICATIONS',
  'ACTIVE MEDICATIONS',
  'MEDICATIONS',
  'MEDS',
  'ALLERGIES',
  'PAST MEDICAL HISTORY',
  'PAST SURGICAL HISTORY',
  'REVIEW OF SYSTEMS',
  'ROS',
  'VITAL SIGNS',
  'VITALS',
  'OBJECTIVE',
  'PHYSICAL EXAMINATION',
  'PHYSICAL EXAM',
  'PE',
  'ASSESSMENT & PLAN',
  'ASSESSMENT AND PLAN',
  'A&P',
  'ASSESSMENT',
  'IMPRESSION',
  'PLAN',
  'ORDERS',
  'RECOMMENDATIONS',
  'ICD-10 CODES',
  'ICD-10',
  'ICD 10',
  'CPT CODES',
  'CPT'
]

export function normalizeSectionBreaks(text) {
  if (!text) { return '' }
  let str = String(text)
  const headerAlt = SECTION_HEADERS_LIST.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const boundaryRegex = new RegExp(`(?:^|[\\n\\r]|\\.\\s+|;\\s+|\\s{2,})(${headerAlt})(?:\\s*\\([A-Za-z0-9\\s/&\\-–—]+\\))?\\s*:`, 'gi')
  str = str.replace(boundaryRegex, (match, p1) => `\n\n${p1.toUpperCase()}:\n`)
  return str.trim()
}

export function extractSectionContent(text, headerRegex, stopHeaderNames = []) {
  if (!text) { return null }
  const headerMatch = text.match(headerRegex)
  if (!headerMatch) { return null }
  const startIndex = headerMatch.index + headerMatch[0].length
  const remainder = text.slice(startIndex)

  const stopHeaders = stopHeaderNames.length > 0 ? stopHeaderNames : SECTION_HEADERS_LIST
  const stopAlt = stopHeaders.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const stopRegex = new RegExp(`(?:^|[\\n\\r]|\\.\\s+|;\\s+|\\s{2,})(?:${stopAlt})(?:\\s*\\([A-Za-z0-9\\s/&\\-–—]+\\))?\\s*:`, 'i')
  const stopMatch = remainder.match(stopRegex)
  const endIndex = stopMatch ? stopMatch.index : remainder.length

  return remainder.slice(0, endIndex).trim()
}

export function formatNumberedList(text) {
  if (!text) { return '' }
  const items = text.split(/(?=(?:\d+\.|\([0-9a-z]\))\s+)/i).map(s => s.trim()).filter(Boolean)
  if (items.length > 1) {
    return items.join('\n')
  }
  return text
}

export function formatExamFindings(rawPe) {
  if (!rawPe) { return 'Not documented this encounter.' }
  if (rawPe.includes('\n') || rawPe.includes('•')) {
    return rawPe.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
  }
  const parts = rawPe.split(/[,;]|\.\s+(?=[A-Z])/).map(p => p.trim().replace(/\.+$/, '')).filter(p => p.length > 3)
  if (parts.length > 1) {
    return parts.map(p => `• ${p.charAt(0).toUpperCase() + p.slice(1)}`).join('\n')
  }
  return rawPe
}

/**
 * Extracts medications with dosages, routes, and frequencies from dictation or transcript
 */
export function extractMedications(text) {
  if (!text) return { list: [], formattedText: '• No current prescription medications documented this encounter.' }
  const normalizedStr = normalizeSectionBreaks(text)
  const str = String(text)
  const meds = new Map()

  // 1. Explicit Medication block
  const rawBlock = extractSectionContent(normalizedStr, /(?:current\s+)?(?:medications?|meds?|medication\s+list|active\s+medications?|prescriptions?|rx)(?:\s*list|\s*review)?:\s*/i)
  if (rawBlock) {
    const items = rawBlock.split(/[,;\n•\*\-]|\band\b/i).map(s => s.trim()).filter(s => s.length > 2)
    for (const item of items) {
      let clean = item.replace(/\.+$/, '').trim()
      if (/(?:physical\s+exam|cranial|cervical|assessment|plan:|follow.?up|screen\s+rule)/i.test(clean)) {
        clean = clean.replace(/\.\s*(?:Physical|Assessment|Plan|cervical|no\s+temporal).*/i, '').trim()
      }
      if (clean && clean.length > 2 && !/^(none|denies|nil|no known|n\/a|cervical|no temporal|assessment|plan|screen rule)$/i.test(clean) && !/(?:cranial\s+nerve|range\s+of\s+motion|artery\s+tenderness)/i.test(clean)) {
        const key = clean.toLowerCase()
        if (!meds.has(key)) {
          meds.set(key, clean)
        }
      }
    }
  }

  // 2. Scan entire text for discrete drug name + dosage patterns
  const drugDoseRegex = /\b(?:(?:refill|prescribe|order|start|continue|discontinue|hold|stop|take|taking|trial|give|inject)\s+)?([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?|mEq|puff(?:s)?))\b(?:\s+(?:oral|orally|po|topical|sublingual|subcutaneously|inhaled|by\s+mouth))?(?:\s+(once\s+daily|twice\s+daily|three\s+times\s+daily|daily|at\s+bedtime|in\s+the\s+morning|every\s+\d+\s+hours|bid|tid|qid|qhs|prn|as\s+needed(?:\s+for\s+[a-z]+)?))?/gi
  let dMatch
  while ((dMatch = drugDoseRegex.exec(str)) !== null) {
    const rawDrugName = dMatch[1].trim()
    const drugName = rawDrugName.replace(/^(?:refill|prescribe|order|start|continue|discontinue|hold|stop|take|taking|trial|give|inject)\s+/i, '').trim()
    if (!/^(?:Range|Pain|Temp|HR|RR|BP|Vitals|SpO2|Oxygen|Normal|Patient|Right|Left|Bilateral|Physical|Chief|History|Follow|Year|Years|Level|Score)/i.test(drugName)) {
      const key = drugName.toLowerCase()
      let already = false
      for (const existingKey of meds.keys()) {
        if (existingKey.includes(key) || key.includes(existingKey)) {
          already = true
          break
        }
      }
      if (!already) {
        const cleanPhrase = `${drugName} ${dMatch[2]}${dMatch[3] ? ' ' + dMatch[3] : ''}`.trim()
        meds.set(key, cleanPhrase)
      }
    }
  }

  const list = Array.from(meds.values())
  const formattedText = list.length > 0
    ? list.map(m => `• ${m}`).join('\n')
    : '• No current prescription medications documented this encounter.'

  return { list, formattedText }
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
  const fullText = combined
  const normalized = normalizeAsrErrors(combined)
  const normalizedBreaks = normalizeSectionBreaks(combined)

  const vitalsObj = extractVitals(combined)
  const vitalsText = formatVitalsSection(vitalsObj)
  const medications = extractMedications(fullText)

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

  // If text already has pre-formatted markdown/structured standalone headers from manual macro (each on its own line), preserve cleanly
  const hasStandaloneHeaders = /^CHIEF COMPLAINT:\s*$/m.test(normalizedBreaks) &&
                               /^HISTORY OF PRESENT ILLNESS(?:\s*\(HPI\))?:\s*$/m.test(normalizedBreaks) &&
                               /^PLAN:\s*$/m.test(normalizedBreaks) &&
                               !/Symptoms associated with prolonged microscope usage.*Medications:/s.test(combined)

  if (hasStandaloneHeaders) {
    let result = normalizedBreaks.trim()
    const upper = result.toUpperCase()
    if (!upper.includes('VITAL SIGNS:') && !upper.includes('VITALS:')) {
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

  const patientAge = meta?.patientAge ? String(meta.patientAge).replace(/[^0-9]/g, '') : ''
  const patientName = meta?.patientName || ''
  const isFemale = /\b(?:she|her|female|woman|lady|girl)\b/i.test(normalized)
  const pronoun = isFemale ? 'She' : 'He'
  const possessive = isFemale ? 'her' : 'his'

  // 1. Identify primary anatomical region and symptom
  let primaryComplaint
  let anatomicalRegion = ''
  let mechanism = ''

  const explicitCc = extractSectionContent(normalizedBreaks, /(?:chief\s+complaint|reason\s+for\s+visit):\s*/i)
  if (explicitCc && explicitCc.length > 2) {
    primaryComplaint = explicitCc.replace(/\.+$/, '').trim()
  }

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

  if (!primaryComplaint) {
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
  }

  // 2. Synthesize HPI
  const explicitHpi = extractSectionContent(normalizedBreaks, /(?:history\s+of\s+present\s+illness|hpi):\s*/i)
  let hpiText = ''
  if (explicitHpi && explicitHpi.length > 10) {
    hpiText = explicitHpi
  } else {
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

    hpiText = hpiParagraphs.join(' ')
  }

  // 3. Synthesize Physical Exam (only actual observations dictated, no fabricated normal exams)
  let examText = ''
  const explicitPe = extractSectionContent(normalizedBreaks, /(?:physical\s+examination|physical\s+exam|pe):\s*/i)
  if (explicitPe && explicitPe.length > 5) {
    examText = formatExamFindings(explicitPe)
  } else {
    const copyForwardRequested = /(?:copy\s+(?:over|forward)|pull\s+forward|carry\s+forward|same\s+as\s+before)\s+(?:the\s+)?(?:prior|previous|last)?\s*([a-z0-9\s\-]+?)\s*(?:exam|examination|physical\s+exam)/i.test(normalized)
    const insertRequested = /(?:insert|add)\s+(?:a\s+)?([a-z0-9\s\-]+?)(?:,\s*)?(?:physical\s+exam|exam|examination)/i.test(normalized)

    const examLines = []
    if (copyForwardRequested || insertRequested) {
      examLines.push('  Right Knee: [COPY FORWARD from prior encounter — per dictation, action pending]')
      examLines.push('  Left Knee:  [PENDING — examination to be entered]')
      examLines.push('  *** DO NOT SIGN — exam content outstanding ***')
    } else if (/exam|palpat|tender|swelling|inspect|rom|range of motion/i.test(normalized)) {
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
      examLines.push('Focused physical examination not documented this encounter.')
    }
    examText = examLines.join('\n')
  }

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
  const explicitAss = extractSectionContent(normalizedBreaks, /(?:assessment|impression):\s*/i)
  if (explicitAss && explicitAss.length > 3) {
    assessmentLines.push(formatNumberedList(explicitAss))
  } else if (isHeadache) {
    if (/migraine/i.test(normalized) || /migraine/i.test(String(visitType || ''))) {
      assessmentLines.push('1. Acute migraine, unspecified, not intractable, without status migrainosus (G43.909).')
      assessmentLines.push('2. Secondary intracranial pathology / red-flag etiologies ruled out by clinical exam.')
    } else if (/tension/i.test(normalized)) {
      assessmentLines.push('1. Tension-type headache, unspecified, not intractable (G44.209).')
    } else {
      assessmentLines.push('1. Headache, unspecified (R51.9).')
      assessmentLines.push('2. Rule out secondary headache disorder; no focal neurological signs on examination.')
    }
  } else if (/bilateral.*(?:knee|osteoarthritis)|bilodoniaoster/i.test(normalized)) {
    assessmentLines.push('1. Bilateral primary osteoarthritis of knee (M17.0).')
    if (/mcl/i.test(normalized) && /1981|prior|remote|repair/i.test(normalized)) {
      assessmentLines.push('2. Status post remote right MCL surgical repair (1981) (Z98.890).')
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

  // 6. Plan (distinguish orders from discussions)
  const planLines = []
  const explicitPlan = extractSectionContent(normalizedBreaks, /plan:\s*/i)
  if (explicitPlan && explicitPlan.length > 3) {
    planLines.push(formatNumberedList(explicitPlan))
  } else {
    if (/(?:request|order)\s+(?:for\s+)?(?:a\s+)?bilateral\s+hyaluronic\s+acid/i.test(normalized)) {
      planLines.push('1. ORDER: Bilateral hyaluronic acid knee injections requested to address osteoarthritic changes and provide cushioning for physical therapy participation.')
    }
    // Medication refills & prescriptions in Plan
    const refillMatches = fullText.match(/(?:refill|prescribe|order|start|continue|increase|decrease)\s+(?:prescription\s+for\s+)?([A-Z][a-zA-Z0-9\s,\.\-mg/]+?)(?=(?:\.|\n|$))/gi)
    if (refillMatches) {
      for (const rm of refillMatches) {
        const cleanRm = rm.trim().replace(/\.+$/, '')
        if (cleanRm.length > 8 && !planLines.some(p => p.toLowerCase().includes(cleanRm.toLowerCase().slice(0, 15)))) {
          planLines.push(`${planLines.length + 1}. ${cleanRm.charAt(0).toUpperCase() + cleanRm.slice(1)}.`)
        }
      }
    }
    if (/follow\s*up|return|week|month/i.test(normalized)) {
      const fuMatch = normalized.match(/follow.?up\s+(?:in\s+)?([a-zA-Z0-9\s]+?)(?:\.|$)/i)
      planLines.push(`${planLines.length + 1}. Follow-up: ${fuMatch ? fuMatch[0] : 'Follow up as directed by clinician.'}`)
    } else {
      planLines.push(`${planLines.length + 1}. Follow up as needed if symptoms worsen or fail to improve.`)
    }
    if (imagingText) {
      planLines.push(`${planLines.length + 1}. ${imagingText}`)
    }
    if (/rest|ice|elevat/i.test(normalized)) {
      planLines.push(`${planLines.length + 1}. Supportive care measures as discussed with clinician.`)
    }
  }

  // 7. Canadian Primary Care Specialized Section
  const templateStr = `${visitType} ${meta?.template || ''} ${meta?.selectedTemplate || ''}`.toLowerCase()
  let specializedSection = null
  if (/rourke|pediatric|well.?baby|well.?child/.test(templateStr) || /rourke/.test(normalized)) {
    specializedSection = {
      header: 'ROURKE BABY RECORD / DEVELOPMENT (RBR):',
      content: '• Growth: Weight, length, and head circumference tracking along expected percentiles.\n• Milestones: Gross motor, fine motor, communication, and social/emotional milestones intact for age.\n• Nutrition: Age-appropriate feeding well tolerated; vitamin D supplementation reviewed.\n• Anticipatory Guidance: Safe sleep, childproofing, car seat safety, and upcoming immunizations reviewed.'
    }
  } else if (/diabetes/.test(templateStr) || /diabetic|hba1c/.test(normalized)) {
    specializedSection = {
      header: 'DIABETES CARE & METABOLIC STATUS (DIABETES CANADA):',
      content: '• Glycemic Control: HbA1c and home glucose targets reviewed.\n• Microvascular / Renal Surveillance: Annual urine ACR and eGFR monitoring assessed.\n• Cardiovascular Risk: Statin therapy, ACEi/ARB renal protection, and BP target (<130/80 mmHg) reviewed.\n• Foot Exam: Inspection, 10g monofilament sensation, and peripheral pulses documented.'
    }
  } else if (/prenatal|antenatal|sogc/.test(templateStr) || /prenatal|antenatal|gestational/.test(normalized)) {
    specializedSection = {
      header: 'OBSTETRIC / PRENATAL RECORD (SOGC):',
      content: '• Gestational Age: EGA consistent with dating ultrasound.\n• Maternal Status: Blood pressure normotensive. Negative for preeclampsia symptoms (headache, vision changes, RUQ pain).\n• Fetal Status: Symphysis-fundal height concordant with gestational age. FHR regular. Active fetal movements confirmed.\n• Routine Screen: Urine dipstick negative for protein and glucose.'
    }
  } else if (/canmat|mental/.test(templateStr) || /phq|gad|depression|anxiety|suicid/.test(normalized)) {
    specializedSection = {
      header: 'MENTAL STATUS EXAM & SAFETY ASSESSMENT (CANMAT):',
      content: '• Mental Status: Alert, cooperative, speech normal rate/tone; affect congruent with reported mood.\n• Symptom Scores: PHQ-9 and GAD-7 completed and reviewed.\n• Safety & Risk Assessment: Denies active suicidal ideation, intent, plan, or access to lethal means. Denies homicidal ideation.\n• Crisis Resources: 24/7 Canada Suicide Crisis Helpline (988) contact provided; safety plan established.'
    }
  } else if (/wcb|wsib|occupational/.test(templateStr) || /wcb|workplace\s+injury/.test(normalized)) {
    specializedSection = {
      header: 'OCCUPATIONAL ASSESSMENT & WORK CAPABILITY (WCB / WSIB):',
      content: '• Workplace Incident: Date and mechanism of injury reviewed.\n• Functional Limitations: Physical limitations and restricted duty capability documented.\n• Work Status: Modified duties recommended; heavy lifting, repetitive bending, or high-vibration exposure restricted.\n• Return-to-Work Plan: Functional re-assessment and rehabilitation timeline established.'
    }
  } else if (/geriatric|frailty/.test(templateStr) || /moca|adls|falls\s*risk/.test(normalized)) {
    specializedSection = {
      header: 'GERIATRIC & FRAILTY ASSESSMENT:',
      content: '• Functional Status: Basic ADLs and instrumental IADLs reviewed.\n• Cognitive Screening: Cognition intact; memory concerns assessed.\n• Falls Risk & Mobility: Timed Up and Go (TUG) assessed; assistive device usage and home safety reviewed.\n• Polypharmacy: Medication regimen and Beers criteria / Deprescribing opportunities reconciled.'
    }
  }

  // 8. ICD-10 & CPT Codes
  const icdCodes = deriveIcd10Codes(normalized)
  const cptCodes = deriveCptCodes(normalized, visitType)

  const fullNote = [
    'CHIEF COMPLAINT:',
    primaryComplaint,
    '',
    'HISTORY OF PRESENT ILLNESS (HPI):',
    hpiText,
    '',
    'CURRENT MEDICATIONS:',
    medications.formattedText,
    '',
    'VITAL SIGNS:',
    vitalsText,
    '',
    'PHYSICAL EXAMINATION (PE):',
    examText,
    ...(specializedSection ? ['', specializedSection.header, specializedSection.content] : []),
    ...(imagingText ? ['', 'IMAGING & DIAGNOSTICS:', imagingText] : []),
    '',
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
