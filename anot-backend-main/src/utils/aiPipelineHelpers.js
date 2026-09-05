const fs = require('fs')
const path = require('path')
const { processAudioForTranscription, unlinkTempPaths } = require('../services/audioProcessingService')
const { transcribeFile } = require('../services/aiTranscriptionService')
const { downloadAudioToTemp, dbPathToKey } = require('../services/s3Storage')

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
  'PHYSICAL EXAMINATION (PE)',
  'IMAGING',
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

  return `Generate a structured clinical note from the visit transcription below.

Context (do NOT repeat in the note — patient details are shown elsewhere in the UI):
Patient: ${patientInfo.patient_name}
MRN: ${patientInfo.mrn}
Visit Type: ${patientInfo.visit_type}
Date: ${patientInfo.visit_date}

TRANSCRIPTION(S) & CLINICIAN NOTES:
${combinedTranscription}

INSTRUCTIONS:
1. Start directly with the first section header below — no title, no patient header, no markdown. Use EXACTLY these ${headers.length} plain-text section headers ending with a colon, in this exact order.
2. Under each header, write the concise, professional clinical content expected for that section.
3. The transcript may include speaker-labeled dialogue (e.g. Speaker 0, Speaker 1). Determine who is the clinician and who is the patient based on context.
4. Distinguish carefully between what the patient reports (Subjective / HPI) and what the clinician finds, measures, or observes (Objective / Exam).
5. Document all medications with dosages, frequencies, and durations if stated.
6. CRITICAL FACTUALITY RULE: Do NOT invent, assume, or hallucinate physical exams, vitals, normal organ systems, imaging results, or medications that were not explicitly stated in the transcription. If an exam, system, or plan element was not dictated or discussed, write "Not dictated."
7. For ICD-10 and CPT/E&M coding: act as a certified medical coder — review the documented clinical diagnoses, findings, and care plan, and assign standard, accurate ICD-10-CM and CPT codes (e.g., "M54.5 — Low back pain"). Base any E&M level strictly on documented complexity — do not upcode.

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
  // Matches: "Patient is [Name]", "Patient name is [Name]", "Patient name [Name]", "Patient: [Name]", "Dictation for [Name]"
  const nameMatch = clean.match(/(?:patient(?:'s)?(?:\s+name)?\s+(?:is|:)?\s*|dictation\s+(?:for|on)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i)
  if (nameMatch && nameMatch[1]) {
    const rawName = nameMatch[1].trim()
    const skipTerms = ['a male', 'a female', 'the patient', 'this patient', 'an established', 'a new', 'follow up']
    if (!skipTerms.includes(rawName.toLowerCase())) {
      details.name = rawName
    }
  }

  // 2. MRN matching
  const mrnMatch = clean.match(/(?:mrn|medical\s+record\s+number|chart\s+(?:number|id)|record\s+number)(?:\s+is|\s*:)?\s*([A-Za-z0-9\-]+)/i)
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
  const ageGenderMatch = clean.match(/(\d{1,3})(?:\s*|-)(?:year|yo|y\.o\.)(?:\s*|-)(?:old)?\s*(male|female|man|woman|boy|girl)/i)
  if (ageGenderMatch) {
    details.age = parseInt(ageGenderMatch[1], 10)
    details.gender = ageGenderMatch[2].toLowerCase()
  }

  return Object.keys(details).length > 0 ? details : null
}

module.exports = {
  buildCombinedTranscription,
  buildAnthropicNotePrompt,
  transcribeAllAudioFiles,
  extractDictatedPatientDetails,
}
