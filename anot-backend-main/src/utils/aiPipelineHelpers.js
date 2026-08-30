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

TRANSCRIPTION(S):
${combinedTranscription}

Start directly with the first section header below — no title, no patient header, no markdown. Use EXACTLY these ${headers.length} plain-text section headers ending with a colon, in this exact order. Under each header, write the content a clinician would expect for a section with that name, based only on the transcription — write "Not mentioned" if that information isn't present.

For any section about ICD-10, CPT, or E&M/MDM codes specifically: do not just scan the transcript for literal code mentions (clinicians rarely dictate codes aloud). Instead, act as a certified medical coder — review the diagnoses, findings, and plan you just documented elsewhere in this note, and assign the ICD-10-CM diagnosis codes and CPT (including E&M) codes that those documented facts actually support. List each as "CODE — short description" on its own line, most relevant first. Base any E&M level strictly on the documented history/exam/medical decision-making complexity — do not upcode. Only write "Not mentioned" if the note truly contains no diagnosis or billable service. These are coder-assist suggestions for the clinician to verify before billing, not a final determination.

${sectionList}`
}

/**
 * Transcribe a single audio segment via Deepgram Nova-3 Medical.
 */
async function transcribeAudioSegment(audioPath, settings, visitId, idx) {
  const placeholder = `[Recording ${idx + 1}: transcription unavailable]`

  if (!/^\/uploads\/[\w.\-]+$/.test(audioPath)) {
    console.warn(`Skipping invalid audio path for visit ${visitId}: ${audioPath}`)
    return { text: placeholder, success: false }
  }

  const needsFfmpeg = settings.ffmpeg_enabled && settings.ffmpeg_preprocess_before_transcribe

  if (!needsFfmpeg) {
    console.log(`🎙 Transcribing from S3: ${path.basename(audioPath)}`)
    const text = await transcribeFile(null, settings, visitId, { fromS3: true, s3Path: audioPath })
    if (text) return { text, success: true }
    console.warn(`[transcription] Segment ${idx + 1} failed for visit ${visitId} — Deepgram returned no text`)
    return { text: placeholder, success: false }
  }

  let fullPath
  try {
    fullPath = await downloadAudioToTemp(dbPathToKey(audioPath))
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

module.exports = {
  buildCombinedTranscription,
  buildAnthropicNotePrompt,
  transcribeAllAudioFiles,
}
