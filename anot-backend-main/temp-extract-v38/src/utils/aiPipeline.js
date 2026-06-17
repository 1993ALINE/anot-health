const fs = require('fs')
const path = require('path')
const pool = require('../config/db')
const { auditLog } = require('./auditLogger')
const { loadAiSettings, getAnthropicKey } = require('../services/aiSettings')
const { processAudioForTranscription, unlinkTempPaths } = require('../services/audioProcessingService')
const { transcribeFile } = require('../services/aiTranscriptionService')
const { downloadAudioToTemp, dbPathToKey } = require('../services/s3Storage')
const { setVisitTranscriptionStatus, claimVisitTranscription } = require('./visitSchemaCompat')
const { isReachableWebhookUrl } = require('./webhookReachability')

const AI_DRAFT_UNAVAILABLE =
  '[AI draft unavailable — add an Anthropic API key in Admin → Settings or ANTHROPIC_API_KEY to the server .env file, then click Transcribe audio or Refresh.]'

async function generateAINote(transcriptions, patientInfo) {
  try {
    const settings = await loadAiSettings()
    if (!settings.anthropic_enabled) {
      console.warn('[aiPipeline] Anthropic AI note generation disabled in settings')
      return null
    }

    const key = await getAnthropicKey()
    if (!key) {
      console.warn('[aiPipeline] Anthropic API key not configured')
      return null
    }

    const Anthropic = require('@anthropic-ai/sdk')
    const anthropic = new Anthropic({ apiKey: key })

    const combinedTranscription = transcriptions
      .map((t, i) => `[Recording ${i + 1}]\n${t}`)
      .join('\n\n')

    console.log('🤖 Generating AI note...')

    const response = await anthropic.messages.create({
      model: settings.anthropic_model || 'claude-haiku-4-5',
      max_tokens: 1500,
      system:
        'You are a medical scribe assistant. Generate structured clinical notes from visit transcriptions. Use plain text only — no markdown, no bold markers, no # headers, no separator lines. Be professional, concise and clinically accurate. Only include information present in the transcription. Never invent or assume clinical details.',
      messages: [
        {
          role: 'user',
          content: `Generate a structured clinical note from the visit transcription below.

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
[Diagnosis and treatment plan including medications, referrals, follow-up]`,
        },
      ],
    })

    const noteText = response.content?.[0]?.text
    if (!noteText) {
      console.error('AI note generation error: empty response')
      return null
    }
    console.log(`✅ AI note generated (${noteText.length} chars)`)
    return noteText
  } catch (err) {
    console.error('AI note generation error:', err.message)
    return null
  }
}

function auditUserFromOptions(options) {
  if (options?.user && options.user.id) return options.user
  return { name: 'AI Pipeline', role: 'system' }
}

/**
 * Persist transcript segments + AI draft (used by sync pipeline and Deepgram webhook).
 * @param {number} id visit id
 * @param {string[]} transcriptions non-empty strings
 * @param {object} visit row with patient_name, mrn, visit_type, visit_date
 * @param {{ user?: object, req?: object, source?: string, completionMessage?: string }} [options]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function persistTranscriptionAndDraft(id, transcriptions, visit, options = {}) {
  if (!transcriptions?.length) return { ok: false, error: 'empty' }
  const ctxUser = auditUserFromOptions(options)
  const auditOpts = { req: options.req || null, module_key: 'clinical', action_category: 'update' }
  const transcriptionData = JSON.stringify(transcriptions)

  let aiNote = await generateAINote(transcriptions, {
    patient_name: visit.patient_name,
    mrn: visit.mrn,
    visit_type: visit.visit_type,
    visit_date: visit.visit_date,
  })
  if (!aiNote && transcriptions.length > 0) {
    aiNote = AI_DRAFT_UNAVAILABLE
  }

  const existingNote = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])

  if (existingNote.rows.length > 0) {
    const status = existingNote.rows[0].status
    if (!['pending', 'draft'].includes(status)) {
      await setVisitTranscriptionStatus(id, 'idle')
      return { ok: false, error: 'note_locked' }
    }

    await pool.query(
      `
        UPDATE notes
        SET transcription = $1, ai_draft = $2, updated_at = NOW()
        WHERE visit_id = $3
      `,
      [transcriptionData, aiNote, id]
    )
  } else {
    await pool.query(
      `
        INSERT INTO notes (visit_id, transcription, ai_draft, status)
        VALUES ($1, $2, $3, 'pending')
      `,
      [id, transcriptionData, aiNote]
    )
  }

  await setVisitTranscriptionStatus(id, 'completed')
  await auditLog(ctxUser, 'TRANSCRIPTION_COMPLETED', 'visit', String(id), options.completionMessage || 'Transcription and AI draft stored', {
    ...auditOpts,
    status: 'success',
    metadata: {
      visit_id: id,
      segments: transcriptions.length,
      source: options.source || 'pipeline',
    },
  })
  return { ok: true }
}

/**
 * Full transcription + structured note pipeline.
 * @param {number|string} visitId
 * @param {{ user?: object, req?: object }} [options]
 */
async function runAIPipeline(visitId, options = {}) {
  const id = parseInt(visitId, 10)
  if (!Number.isInteger(id)) return
  const ctxUser = auditUserFromOptions(options)
  const auditOpts = { req: options.req || null, module_key: 'clinical', action_category: 'update' }

  try {
    console.log(`\n🚀 Starting AI pipeline for visit ${id}`)
    const settings = await loadAiSettings()

    const visitResult = await pool.query(
      `
      SELECT v.*, p.name AS patient_name, p.mrn, c.name AS clinician_name
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
      JOIN users c ON c.id = v.clinician_id
      WHERE v.id = $1
    `,
      [id]
    )

    if (!visitResult.rows[0]) {
      console.error(`Visit ${id} not found`)
      return
    }

    const visit = visitResult.rows[0]

    if (!visit.audio_file) {
      console.warn(`No audio file for visit ${id}`)
      await setVisitTranscriptionStatus(id, 'idle')
      return
    }

    const existingNotePre = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])
    if (existingNotePre.rows.length > 0) {
      const st = existingNotePre.rows[0].status
      if (!['pending', 'draft'].includes(st)) {
        console.log(`⏭  Skipping AI pipeline for visit ${id} (note status=${st})`)
        await setVisitTranscriptionStatus(id, 'idle')
        await auditLog(
          ctxUser,
          'TRANSCRIPTION_SKIPPED',
          'visit',
          String(id),
          `Pipeline skipped — note locked (status=${st})`,
          { ...auditOpts, status: 'success', metadata: { reason: 'note_locked' } }
        )
        return
      }
    }

    // Atomic claim: only one pipeline may process a visit at a time. Without
    // this, near-simultaneous triggers (upload auto-transcribe + manual button)
    // would both pass the status read above and double-run Deepgram/Anthropic.
    if (!(await claimVisitTranscription(id))) {
      console.log(`⏭  Skipping AI pipeline for visit ${id} (already processing)`)
      return
    }
    await auditLog(ctxUser, 'TRANSCRIPTION_STARTED', 'visit', String(id), 'AI transcription pipeline started', {
      ...auditOpts,
      status: 'success',
      metadata: { visit_id: id },
    })

    const audioFiles = visit.audio_file.split(',').map((f) => f.trim()).filter(Boolean)
    console.log(`📁 Found ${audioFiles.length} audio file(s)`)

    const useAsyncDeepgram =
      isReachableWebhookUrl(settings.deepgram_webhook_url) && audioFiles.length === 1

    // Keep transcript order aligned with recording numbers: failed segments get
    // a placeholder instead of being dropped, so "Recording 3" stays recording 3.
    const transcriptions = []
    let successCount = 0
    let anyDeferred = false
    for (let idx = 0; idx < audioFiles.length; idx++) {
      const audioPath = audioFiles[idx]
      const placeholder = `[Recording ${idx + 1}: transcription unavailable]`

      if (!/^\/uploads\/[\w.\-]+$/.test(audioPath)) {
        console.warn(`Skipping invalid audio path for visit ${id}: ${audioPath}`)
        transcriptions.push(placeholder)
        continue
      }

      // Audio lives in S3 (local disk is wiped on EB redeploys); download to a
      // temp file so ffmpeg/Deepgram can work with a local path.
      let fullPath
      try {
        fullPath = await downloadAudioToTemp(dbPathToKey(audioPath))
      } catch (e) {
        console.warn(`Audio not found in S3 for visit ${id} (${audioPath}):`, e.message)
        transcriptions.push(placeholder)
        continue
      }

      let tempPaths = [fullPath]
      try {
        const fileSize = fs.statSync(fullPath).size
        if (fileSize === 0) {
          console.warn(`Audio file is empty: ${audioPath}`)
          transcriptions.push(placeholder)
          continue
        }
        const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
        if (fileSize > maxBytes) {
          console.warn(`Audio over limit (${settings.ffmpeg_max_upload_mb}MB): ${audioPath}`)
          transcriptions.push(placeholder)
          continue
        }

        const proc = await processAudioForTranscription(fullPath, settings)
        const transcribePath = proc.path
        tempPaths = tempPaths.concat(proc.tempPaths || [])
        console.log(`🎙 Transcribing: ${path.basename(transcribePath)} (${Math.round(fileSize / 1024)}KB source)`)
        const text = await transcribeFile(transcribePath, settings, useAsyncDeepgram ? id : undefined)
        if (text === '__DEFERRED__') {
          anyDeferred = true
          continue
        }
        if (text) {
          transcriptions.push(text)
          successCount++
        } else {
          transcriptions.push(placeholder)
        }
      } catch (e) {
        console.error(`Transcription segment error for visit ${id}:`, e.message)
        transcriptions.push(placeholder)
      } finally {
        await unlinkTempPaths(tempPaths)
      }
    }

    if (successCount === 0 && anyDeferred) {
      console.log(`⏳ Visit ${id}: Deepgram async callback pending (public webhook)`)
      return
    }

    if (successCount === 0) {
      console.warn(`No transcriptions generated for visit ${id}`)
      await setVisitTranscriptionStatus(id, 'failed')
      await auditLog(ctxUser, 'TRANSCRIPTION_FAILED', 'visit', String(id), 'No transcript produced from audio', {
        ...auditOpts,
        status: 'failure',
        metadata: { visit_id: id },
      })
      return
    }

    const saved = await persistTranscriptionAndDraft(id, transcriptions, visit, {
      ...options,
      source: 'pipeline',
      completionMessage: 'Transcription and AI draft stored',
    })
    if (!saved.ok) {
      console.log(`⏭  Persist skipped for visit ${id} (${saved.error})`)
      return
    }
    console.log(`✅ AI pipeline complete for visit ${id}`)
  } catch (err) {
    console.error(`AI pipeline error for visit ${id}:`, err.message)
    try {
      await setVisitTranscriptionStatus(id, 'failed')
    } catch { /* */ }
    await auditLog(
      auditUserFromOptions(options),
      'TRANSCRIPTION_FAILED',
      'visit',
      String(id),
      String(err.message || 'pipeline error').slice(0, 2000),
      { req: options.req || null, module_key: 'clinical', action_category: 'update', status: 'failure' }
    )
  }
}

module.exports = {
  runAIPipeline,
  generateAINote,
  persistTranscriptionAndDraft,
}
