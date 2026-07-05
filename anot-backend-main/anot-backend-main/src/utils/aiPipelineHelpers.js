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

/**
 * Build Anthropic user prompt for clinical note generation
 */
function buildAnthropicNotePrompt(patientInfo, combinedTranscription) {
  return `Generate a structured clinical note from the visit transcription below.

Context (do NOT repeat in the note — patient details are shown elsewhere in the UI):
Patient: ${patientInfo.patient_name}
MRN: ${patientInfo.mrn}
Visit Type: ${patientInfo.visit_type}
Date: ${patientInfo.visit_date}

TRANSCRIPTION(S):
${combinedTranscription}

Start directly with CHIEF COMPLAINT — no title, no patient header, no markdown. Use EXACTLY these 5 plain-text section headers ending with a colon. Write "Not mentioned" if information is not available in the transcription.

CHIEF COMPLAINT:
[1-2 sentences describing the main reason for the visit]

HISTORY OF PRESENT ILLNESS (HPI):
[Detailed narrative including onset, duration, severity, associated symptoms]

PHYSICAL EXAMINATION (PE):
[Physical exam findings, or "Not performed/mentioned"]

IMAGING:
[Any imaging results or orders, or "Not mentioned"]

ASSESSMENT & PLAN (A&P):
[Diagnosis and treatment plan including medications, referrals, follow-up]`
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
