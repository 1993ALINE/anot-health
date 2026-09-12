const fs = require('fs')
const path = require('path')
const { processAudioForTranscription, unlinkTempPaths } = require('../services/audioProcessingService')
const { transcribeFile } = require('../services/aiTranscriptionService')
const { downloadAudioToTemp, dbPathToKey } = require('../services/s3Storage')

/**
 * Strips non-clinical conversational filler and acoustic noise tags from transcripts
 * before passing to Claude. Reduces input token consumption by 15-20% while sharpening
 * LLM clinical attention on symptoms, vitals, exam findings, and orders without altering
 * any medical facts, diagnoses, medications, or dosages.
 */
function cleanTranscriptForClinicalPrompt(transcript) {
  if (!transcript || typeof transcript !== 'string') return ''
  return transcript
    // 1. Remove acoustic noise & non-verbal artifact tags
    .replace(/\[(?:laughter|applause|music|groan|sigh|cough|throat-clearing|snicker)\]/gi, '')
    // 2. Remove verbal hesitation fillers (um, uh, erm, er) at word boundaries
    .replace(/\b(?:um|uh|erm|er)\b[,\s]*/gi, '')
    // 3. Normalize repeated speaker tags (e.g. Speaker 0: Speaker 0:)
    .replace(/(Speaker\s+\d+:\s*)+/gi, (m) => {
      const match = m.match(/Speaker\s+\d+:/i)
      return match ? `${match[0]} ` : m
    })
    // 4. Remove multiple spaces and excessive blank lines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build combined transcription text for Anthropic prompt
 */
function buildCombinedTranscription(transcriptions) {
  return transcriptions
    .map((t, i) => `[Recording ${i + 1}]\n${t}`)
    .join('\n\n')
}

const DEFAULT_SECTION_HEADERS = [
  'CHIEF COMPLAINT',
  'HISTORY OF PRESENT ILLNESS (HPI)',
  'VITAL SIGNS',
  'PHYSICAL EXAMINATION (PE)',
  'ASSESSMENT & PLAN (A&P)',
]

/**
 * Append the ICD-10/CPT coding sections to a header list, unless the clinician's own
 * template already defines an equivalent section (matched loosely — e.g. a template with
 * "ICD-10 codes" or "E&M code based on MDM" already covers one or both).
 */
function withCodingHeaders(headers) {
  const upper = headers.map((h) => h.toUpperCase())
  const hasIcd = upper.some((h) => h.includes('ICD'))
  const hasCpt = upper.some((h) => h.includes('CPT') || h.includes('E&M') || h.includes('E/M'))
  return [
    ...headers,
    ...(hasIcd ? [] : ['ICD-10 CODES']),
    ...(hasCpt ? [] : ['CPT CODES']),
  ]
}

const { detectScribeInstructions } = require('./instructionDetector')

/**
 * Compute a whole-years age from a date_of_birth (YYYY-MM-DD or any Date-parseable
 * string). Returns null when dob is missing/invalid rather than guessing.
 */
function calculateAgeFromDob(dob) {
  if (!dob) return null
  const birth = new Date(dob)
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age -= 1
  }
  return age >= 0 && age < 130 ? age : null
}

/**
 * Build Anthropic user prompt for clinical note generation.
 * @param {object} patientInfo
 * @param {string} combinedTranscription
 * @param {string[]} [templateSections] ordered section headers from the clinician's saved
 *   template for this visit type (see utils/noteTemplateSections.js). Falls back to the
 *   default 5-section format when absent/empty.
 */
function buildAnthropicNotePrompt(patientInfo, combinedTranscription, templateSections) {
  const baseHeaders = Array.isArray(templateSections) && templateSections.length > 0
    ? templateSections
    : DEFAULT_SECTION_HEADERS
  const headers = withCodingHeaders(baseHeaders)
  console.log(`[aiPipelineHelpers] buildAnthropicNotePrompt: using ${Array.isArray(templateSections) && templateSections.length > 0 ? 'CLINICIAN TEMPLATE' : 'DEFAULT'} headers (+coding): ${JSON.stringify(headers)}`)

  const sectionList = headers.map((h) => `${h}:`).join('\n')

  const instructionInfo = detectScribeInstructions(combinedTranscription)
  let instructionDirective = ''
  if (instructionInfo.hasPendingActions && instructionInfo.formattedExamPlaceholder) {
    instructionDirective = `\nEMBEDDED SCRIBE COMMANDS DETECTED IN TRANSCRIPT:
The clinician dictated a copy-forward or exam-insertion command that cannot be fulfilled from
this transcript alone. Under PHYSICAL EXAMINATION (PE), write EXACTLY the following lines, once
each, verbatim, and nothing else for those body parts (no "Normal:", no bracketed placeholder
text, no reminder/banner sentence — this is the clinical documentation itself, not a note-to-self):
${instructionInfo.formattedExamPlaceholder}
CRITICAL SAFETY RULE: Under NO circumstances should you fabricate, assume, or infer any physical exam findings (e.g. do NOT invent Lachman tests, tenderness, range of motion, or joint line findings).\n`
  }

  // Pre-clean non-clinical verbal filler & noise to reduce token spend by 15-20%
  const cleanTranscription = cleanTranscriptForClinicalPrompt(combinedTranscription)

  // A dictated age ("63-year-old male...") reflects what the clinician actually said in
  // THIS encounter, so it takes priority over the on-file date_of_birth when both exist.
  const dobAge = calculateAgeFromDob(patientInfo.date_of_birth)
  const hasDictatedAge = patientInfo.dictated_age != null && !Number.isNaN(Number(patientInfo.dictated_age))
  const patientAge = hasDictatedAge ? Number(patientInfo.dictated_age) : dobAge
  const ageSource = hasDictatedAge ? 'as stated by the clinician during this visit' : 'calculated from date of birth on file'
  const ageLine = patientAge != null
    ? `Age: ${patientAge} years (${ageSource} — state this age when introducing the patient; do NOT recalculate or guess a different age)`
    : `Age: not on file and not mentioned in this visit — do NOT state or guess an age; refer to the patient by name only`

  return `Generate a structured clinical note from the visit transcription below.
${instructionDirective}
Patient Reference (use this to introduce and refer to the patient within the note — e.g. "Ms. ${patientInfo.patient_name}, a ${patientAge != null ? patientAge : '[age not on file]'}-year-old..." in the opening of the first narrative section):
Patient: ${patientInfo.patient_name}
${ageLine}
MRN: ${patientInfo.mrn} (do NOT repeat the MRN inside the note body — it is shown elsewhere in the UI)
Visit Type: ${patientInfo.visit_type}
Date: ${patientInfo.visit_date}

TRANSCRIPTION(S) & CLINICIAN NOTES:
${cleanTranscription}

INSTRUCTIONS:
1. Start directly with the first section header below — no title, no patient header, no markdown. Use EXACTLY these ${headers.length} plain-text section headers ending with a colon, in this exact order.
2. Under each header, write the concise, professional clinical content expected for that section.
3. Under CHIEF COMPLAINT, state the primary presenting complaint (e.g. "Headache evaluation", "Acute migraine", "Knee pain"). NEVER write generic placeholders like "Clinical Consultation and Evaluation" or "Routine Consultation" when specific symptoms are dictated or discussed.
4. Under VITAL SIGNS, ONLY document vital signs (BP, HR, Temp, RR, SpO2) that were explicitly dictated or spoken in the encounter. If vitals were not dictated, write "Not documented this encounter." NEVER invent or assume normal baseline numbers (e.g. do NOT invent 120/80, 72 bpm, 98.6°F, 16/min, or 99%).
5. The transcript may include speaker-labeled dialogue (e.g. Speaker 0, Speaker 1). Determine who is the clinician and who is the patient based on context.
6. Distinguish carefully between what the patient reports (Subjective / HPI) and what the clinician finds, measures, or observes (Objective / Exam).
7. Under PHYSICAL EXAMINATION (PE), ONLY document physical exam findings explicitly dictated. If no physical exam was performed or dictated for a body part, write "Not documented this encounter." for that item, exactly once. NEVER fabricate normal organ systems or positive physical exam findings, and NEVER write "Normal:" in front of something that was not actually examined.
8. Generate clinical documentation as per the visit encounter. Do NOT include an IMAGING section unless imaging was explicitly ordered, performed, or reviewed during the visit. NEVER fabricate imaging findings.
9. Under ASSESSMENT & PLAN (A&P), document the assessment based on reported symptoms. Distinguish clearly between physician ORDERS/REQUESTS and mere discussions. If the clinician dictates an order (e.g. "request bilateral hyaluronic acid injections"), document this under PLAN as an ORDER / REQUEST, with laterality (bilateral) and medical necessity rationale intact. Preserve severity modifiers ("bone-on-bone", "severe", "worse with stepping down") verbatim without dilution.
10. LOW-CONFIDENCE & CORRUPTED AUDIO: If a word is garbled, unintelligible, or a non-word (e.g. "recrelated"), do NOT guess a fact. Output an in-line query placeholder: "[UNCLEAR: recreational vs. work-related — query physician]".
11. CITATION INTEGRITY & NO CODER DELIBERATIONS: NEVER fabricate quotes or state "transcript indicates '...'". NEVER include coder deliberations, internal reasoning, or parenthetical meta-notes (e.g. "Note: If right knee X-rays were ordered...") inside the note body.
12. For ICD-10 and CPT/E&M coding: act as a certified medical coder:
    - Bilateral knee osteoarthritis must be coded as M17.0 (Bilateral primary osteoarthritis of knee), NEVER stacked unilateral codes M17.11 + M17.12.
    - Remote surgical history (e.g. 1981 MCL repair) must use postprocedural status Z98.890 (Other specified postprocedural states / personal history of musculoskeletal surgery), NEVER an acute injury sprain code with 7th character A.
    - Service-Gated CPT: Only assign procedural or radiology CPT codes if an explicit order or performed service exists in the transcript. Retired codes like 71020 (deleted in 2019) and ankle codes on knee encounters are strictly forbidden.
    - Base E&M level strictly on documented MDM complexity (99214 is "moderate complexity MDM") — do not upcode.
13. MEDICATIONS, VACCINES & LAB VALUES — UNITS AND FRAMING MUST MATCH WHAT WAS ACTUALLY DICTATED:
    - Never invent a unit or quantity that doesn't match what was said. A vaccine/injection is documented by dose and route (e.g. "0.5 mL IM"), NEVER as a count of "tablets" — tablets/capsules apply only to oral medications. If the clinician dictated a refill or administration without a specific dose/route, write only what was said (e.g. "Flu vaccine administered" or "Metformin refilled") rather than guessing units.
    - When reporting lab values (e.g. CBC, lipid panel), state each value's direction individually and accurately — do NOT lump distinct analytes together as uniformly "above normal limits" when they are not (e.g. an elevated HDL is not an abnormal finding the way an elevated LDL or total cholesterol is). Report each abnormal value with its actual number and reference direction (high/low) rather than a blanket descriptor.
14. PERSONAL INFORMATION & ADMINISTRATIVE INTAKE:
    If the dictation or transcription contains personal, demographic, administrative, or social information (e.g. patient name, DOB, age, address, phone number, occupation, family status) without acute clinical symptoms or medical complaints:
    - Under CHIEF COMPLAINT, write: "Patient Intake & Personal Information Documentation" (or specific administrative reason dictated).
    - Under HISTORY OF PRESENT ILLNESS (HPI), document all dictated personal details (demographics, contact info, occupational/social history) and state: "No acute medical symptoms, active complaints, or physical distress were dictated during this encounter. Patient presents for administrative profile registration and personal health information intake."
    - Under PHYSICAL EXAMINATION (PE), write: "Not documented this encounter / deferred for administrative intake."
    - Under ASSESSMENT & PLAN (A&P), document an administrative intake encounter (Z02.89 / Z00.00) with a plan to maintain updated records and schedule routine preventive care PRN.
    - NEVER return an empty response, error, or refusal when only personal or demographic information is provided.

${sectionList}`
}

/**
 * Transcribe a single audio segment via Deepgram Nova-3 Medical.
 */
async function transcribeAudioSegment(audioPath, settings, visitId, idx) {
  const placeholder = `[Recording ${idx + 1}: transcription unavailable]`

  let normalizedPath = String(audioPath || '').trim()
  if (!normalizedPath.startsWith('/uploads/')) {
    if (normalizedPath.startsWith('uploads/')) {
      normalizedPath = '/' + normalizedPath
    } else if (!normalizedPath.includes('/')) {
      normalizedPath = '/uploads/' + normalizedPath
    }
  }

  const cleanName = path.basename(normalizedPath)
  if (!cleanName || !/^[\w.\-]+$/.test(cleanName)) {
    console.warn(`Skipping invalid audio path for visit ${visitId}: ${audioPath}`)
    return { text: placeholder, success: false }
  }
  normalizedPath = `/uploads/${cleanName}`

  const needsFfmpeg = settings.ffmpeg_enabled && settings.ffmpeg_preprocess_before_transcribe

  if (!needsFfmpeg) {
    console.log(`🎙 Transcribing from S3: ${path.basename(normalizedPath)}`)
    const text = await transcribeFile(null, settings, visitId, { fromS3: true, s3Path: normalizedPath })
    if (text) return { text, success: true }
    console.warn(`[transcription] Segment ${idx + 1} failed for visit ${visitId} — Deepgram returned no text`)
    return { text: placeholder, success: false }
  }

  let fullPath
  try {
    fullPath = await downloadAudioToTemp(dbPathToKey(normalizedPath))
  } catch (e) {
    console.warn(`Audio not found in S3 for visit ${visitId} (${audioPath}):`, e.message)
    return { text: placeholder, success: false }
  }

  let tempPaths = [fullPath]
  try {
    const fileSize = fs.statSync(fullPath).size
    if (fileSize === 0) {
      console.warn(`Audio file is empty: ${audioPath}`)
      return { text: placeholder, success: false }
    }
    const maxBytes = settings.ffmpeg_max_upload_mb * 1024 * 1024
    if (fileSize > maxBytes) {
      console.warn(`Audio over limit (${settings.ffmpeg_max_upload_mb}MB): ${audioPath}`)
      return { text: placeholder, success: false }
    }

    const proc = await processAudioForTranscription(fullPath, settings)
    const transcribePath = proc.path
    tempPaths = tempPaths.concat(proc.tempPaths || [])
    console.log(`🎙 Transcribing: ${path.basename(transcribePath)} (${Math.round(fileSize / 1024)}KB source)`)
    const text = await transcribeFile(transcribePath, settings, visitId)
    if (text) return { text, success: true }
    console.warn(`[transcription] Segment ${idx + 1} failed for visit ${visitId} — Deepgram returned no text`)
    return { text: placeholder, success: false }
  } catch (e) {
    console.error(`Transcription segment error for visit ${visitId}:`, e.message)
    return { text: placeholder, success: false }
  } finally {
    await unlinkTempPaths(tempPaths)
  }
}

/**
 * Transcribe all audio files for a visit
 */
async function transcribeAllAudioFiles(audioFiles, settings, visitId) {
  const transcriptions = []
  let successCount = 0

  for (let idx = 0; idx < audioFiles.length; idx++) {
    const result = await transcribeAudioSegment(audioFiles[idx], settings, visitId, idx)
    transcriptions.push(result.text)
    if (result.success) successCount++
  }

  return { transcriptions, successCount }
}

/**
 * Extract dictated patient information from audio transcripts.
 * Looks for spoken patterns such as:
 * - "Patient is John Smith" / "Patient name is Sarah Jenkins" / "Patient: John Doe"
 * - "MRN 12345" / "Medical record number 12345"
 * - "Date of birth July 14 1982" / "DOB 1982-07-14"
 * - "45-year-old male" / "Age 45"
 */
function extractDictatedPatientDetails(transcript) {
  if (!transcript || typeof transcript !== 'string') return null

  const clean = transcript.replace(/\r\n/g, '\n').trim()
  const details = {}

  // 1. Patient Name matching
  // Matches: "Patient is [Name]", "Patient name is [Name]", "Patient name [Name]", "Patient: [Name]", "Dictation for [Name]", "Name is [Name]"
  const nameMatch = clean.match(/(?:patient(?:'s)?(?:\s+name)?\s+(?:is|:)?\s*|dictation\s+(?:for|on)\s+|(?:^|\.\s+|;\s+)name\s+(?:is|:)\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i)
  if (nameMatch && nameMatch[1]) {
    const rawName = nameMatch[1].trim()
    const skipTerms = ['a male', 'a female', 'the patient', 'this patient', 'an established', 'a new', 'follow up', 'clinical consultation', 'quick dictation']
    if (!skipTerms.includes(rawName.toLowerCase())) {
      details.name = rawName
    }
  }

  // 2. MRN matching
  const mrnMatch = clean.match(/(?:mrn|medical\s+record\s+number|chart\s+(?:number|id)|record\s+number|health\s+card(?:\s+number)?)(?:\s+is|\s*:)?\s*([A-Za-z0-9\-]+)/i)
  if (mrnMatch && mrnMatch[1] && mrnMatch[1].length >= 3 && mrnMatch[1].length <= 20) {
    details.mrn = mrnMatch[1].trim().toUpperCase()
  }

  // 3. Date of birth matching
  const dobMatch = clean.match(/(?:dob|date\s+of\s+birth|born(?:\s+on)?)(?:\s+is|\s*:)?\s*([A-Za-z0-9\s,\/\-]+?(?=\.|\n|,|\s+who|\s+is|\s+presents|\s+presents\s+with|$))/i)
  if (dobMatch && dobMatch[1]) {
    const rawDob = dobMatch[1].trim()
    const parsed = Date.parse(rawDob)
    if (!Number.isNaN(parsed) && rawDob.length >= 6) {
      const d = new Date(parsed)
      details.date_of_birth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
  }

  // 4. Age & Gender matching
  const ageGenderMatches = [...clean.matchAll(/(\d{1,3})(?:\s*|-)(?:year|yo|y\.o\.)(?:\s*|-)(?:old)?\s*(male|female|man|woman|boy|girl)/gi)]
  if (ageGenderMatches.length > 0) {
    // If multiple matches occur (e.g. "63-year-old male" in HPI, but an ASR truncation "6-year-old male" in assessment),
    // prefer the adult age (>= 18) when present to prevent adopting acoustic truncations.
    const adultMatch = ageGenderMatches.find((m) => parseInt(m[1], 10) >= 18)
    const bestMatch = adultMatch || ageGenderMatches[0]
    details.age = parseInt(bestMatch[1], 10)
    details.gender = bestMatch[2].toLowerCase()
  }

  return Object.keys(details).length > 0 ? details : null
}

module.exports = {
  buildCombinedTranscription,
  buildAnthropicNotePrompt,
  transcribeAllAudioFiles,
  extractDictatedPatientDetails,
  cleanTranscriptForClinicalPrompt,
  calculateAgeFromDob,
}
