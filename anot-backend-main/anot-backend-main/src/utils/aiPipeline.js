const fs = require('fs')
const path = require('path')
const pool = require('../config/db')
const { auditLog } = require('./auditLogger')
const { loadAiSettings } = require('../services/aiSettings')
const { processAudioForTranscription, unlinkTempPaths } = require('../services/audioProcessingService')
const { transcribeFileWithRetries } = require('../services/aiTranscriptionService')

function getGroq() {
  const Groq = require('groq-sdk')
  return new Groq({ apiKey: process.env.GROQ_API_KEY })
}

/** @deprecated prefer transcribeFileWithRetries via pipeline */
async function transcribeAudio(filePath) {
  const settings = await loadAiSettings()
  return transcribeFileWithRetries(filePath, settings, 3)
}

async function generateAINote(transcriptions, patientInfo) {
  try {
    const combinedTranscription = transcriptions
      .map((t, i) => `[Recording ${i + 1}]\n${t}`)
      .join('\n\n')

    console.log(`🤖 Generating AI note for ${patientInfo.patient_name}...`)

    const groq = getGroq()
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            'You are a medical scribe AI. Generate structured clinical notes from visit transcriptions. Be professional, concise and clinically accurate. Only include information present in the transcription.',
        },
        {
          role: 'user',
          content: `Generate a structured clinical note for the following patient visit.

Patient: ${patientInfo.patient_name}
MRN: ${patientInfo.mrn}
Visit Type: ${patientInfo.visit_type}
Date: ${patientInfo.visit_date}

TRANSCRIPTION(S):
${combinedTranscription}

Generate the note with EXACTLY these 5 sections. Write "Not mentioned" if information is not available in the transcription.

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

    const choice = completion.choices?.[0]?.message?.content
    if (!choice) {
      console.error('AI note generation error: empty completion')
      return null
    }
    console.log(`✅ AI note generated (${choice.length} chars)`)
    return choice
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

  const aiNote = await generateAINote(transcriptions, {
    patient_name: visit.patient_name,
    mrn: visit.mrn,
    visit_type: visit.visit_type,
    visit_date: visit.visit_date,
  })

  const existingNote = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])

  if (existingNote.rows.length > 0) {
    const status = existingNote.rows[0].status
    if (!['pending', 'draft'].includes(status)) {
      await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['idle', id])
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

  await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['completed', id])
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
      await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['idle', id])
      return
    }

    const existingNotePre = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])
    if (existingNotePre.rows.length > 0) {
      const st = existingNotePre.rows[0].status
      if (!['pending', 'draft'].includes(st)) {
        console.log(`⏭  Skipping AI pipeline for visit ${id} (note status=${st})`)
        await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['idle', id])
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

    await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['processing', id])
    await auditLog(ctxUser, 'TRANSCRIPTION_STARTED', 'visit', String(id), 'AI transcription pipeline started', {
      ...auditOpts,
      status: 'success',
      metadata: { visit_id: id },
    })

    const audioFiles = visit.audio_file.split(',').map((f) => f.trim()).filter(Boolean)
    console.log(`📁 Found ${audioFiles.length} audio file(s)`)

    const useAsyncDeepgram =
      String(settings.deepgram_webhook_url || '').trim().length > 0 && audioFiles.length === 1

    const transcriptions = []
    let anyDeferred = false
    for (const audioPath of audioFiles) {
      if (!/^\/uploads\/[\w.\-]+$/.test(audioPath)) {
        console.warn(`Skipping invalid audio path for visit ${id}: ${audioPath}`)
        continue
      }
      const fullPath = path.join(__dirname, '..', audioPath)
      if (!fs.existsSync(fullPath)) {
        console.warn(`Audio file not found: ${fullPath}`)
        continue
      }
      const fileSize = fs.statSync(fullPath).size
      if (fileSize === 0) {
        console.warn(`Audio file is empty: ${fullPath}`)
        continue
      }
      const maxBytes = (settings.ffmpeg_max_upload_mb || 100) * 1024 * 1024
      if (fileSize > maxBytes) {
        console.warn(`Audio over limit (${settings.ffmpeg_max_upload_mb}MB): ${fullPath}`)
        continue
      }

      let tempPaths = []
      let transcribePath = fullPath
      try {
        const proc = await processAudioForTranscription(fullPath, settings)
        transcribePath = proc.path
        tempPaths = proc.tempPaths || []
        console.log(`🎙 Transcribing: ${path.basename(transcribePath)} (${Math.round(fileSize / 1024)}KB source)`)
        const text = await transcribeFileWithRetries(transcribePath, settings, 3, useAsyncDeepgram ? id : undefined)
        if (text === '__DEFERRED__') {
          anyDeferred = true
          continue
        }
        if (text) transcriptions.push(text)
      } catch (e) {
        console.error(`Transcription segment error for visit ${id}:`, e.message)
      } finally {
        await unlinkTempPaths(tempPaths)
      }
    }

    if (transcriptions.length === 0 && anyDeferred) {
      console.log(`⏳ Visit ${id}: Deepgram async callback pending (webhook)`)
      return
    }

    if (transcriptions.length === 0) {
      console.warn(`No transcriptions generated for visit ${id}`)
      await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['failed', id])
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
      await pool.query(`UPDATE visits SET transcription_status = $1 WHERE id = $2`, ['failed', id])
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
  transcribeAudio,
  generateAINote,
  persistTranscriptionAndDraft,
}
