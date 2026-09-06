const pool = require('../config/db')

const { auditLog } = require('./auditLogger')

const { loadAiSettings, getAnthropicKey, useDeepgram, resolveCanonicalAnthropicModel } = require('../services/aiSettings')
const { withRetry } = require('./retry')

const { setVisitTranscriptionStatus, claimVisitTranscription } = require('./visitSchemaCompat')

const {

  buildCombinedTranscription,

  buildAnthropicNotePrompt,

  transcribeAllAudioFiles,

  extractDictatedPatientDetails,

} = require('./aiPipelineHelpers')

const { resolveTemplateSections } = require('./noteTemplateSections')
const { formatClinicalDictationToSOAP } = require('./clinicalSoapSynthesizer')

const AI_DRAFT_UNAVAILABLE =
  '[AI draft unavailable — add an Anthropic API key in Admin → Settings or ANTHROPIC_API_KEY to the server .env file, then click Transcribe audio or Refresh.]'



/**

 * Load Anthropic client if configured

 */

async function loadAnthropicClient(settings) {

  const key = await getAnthropicKey()

  // If the key comes from the environment variable, the operator explicitly
  // configured it — skip the DB-level anthropic_enabled flag so a stale
  // DB toggle can never block a valid env key.
  const envKey = (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '').trim()
  const keyIsFromEnv = !!envKey && key === envKey

  if (!keyIsFromEnv && !settings.anthropic_enabled) {

    console.warn('[aiPipeline] Anthropic AI note generation disabled in settings')

    return null

  }

  if (!key) {

    console.warn('[aiPipeline] Anthropic API key not configured')

    return null

  }

  const Anthropic = require('@anthropic-ai/sdk')

  return { client: new Anthropic({ apiKey: key }), settings }

}



/**

 * Call Anthropic API to generate clinical note

 */

async function callAnthropicForNote(anthropic, settings, prompt) {
  const model = resolveCanonicalAnthropicModel(settings?.anthropic_model)
  console.log(`[aiPipeline] Calling Anthropic with model: ${model}`)
  try {
    return await withRetry(
      () => anthropic.messages.create({
        model,
        max_tokens: 3000,
        system:
          'You are an expert board-certified medical scribe and clinical documentation specialist. Generate structured, clinically precise clinical notes from visit transcriptions. Use plain text only — do NOT use markdown symbols, do NOT use bold markers or asterisks, do NOT use # headers, and do NOT use separator lines. Be thorough, professional, and clinically accurate. Distinguish clearly between patient symptoms/history (Subjective) and clinician findings/vitals/exam (Objective). Document specific medications with dosages, routes, frequencies, and durations if stated. Never fabricate or assume clinical details that were not discussed. For ICD-10 and CPT coding, assign standard codes and descriptions strictly supported by the documented diagnoses and care delivered.',
        messages: [{ role: 'user', content: prompt }],
      }),
      { maxAttempts: 2, label: 'Anthropic Claude Note Generation', baseDelayMs: 1000 }
    )
  } catch (err) {
    if (err?.status === 404 || String(err?.message || '').toLowerCase().includes('model')) {
      const fallbackModel = model.includes('haiku') ? 'claude-3-5-sonnet-20241022' : 'claude-3-5-haiku-20241022'
      console.warn(`[aiPipeline] Model ${model} failed (${err.message}). Retrying with fallback model: ${fallbackModel}`)
      return anthropic.messages.create({
        model: fallbackModel,
        max_tokens: 3000,
        system:
          'You are an expert board-certified medical scribe and clinical documentation specialist. Generate structured, clinically precise clinical notes from visit transcriptions. Use plain text only — do NOT use markdown symbols, do NOT use bold markers or asterisks, do NOT use # headers, and do NOT use separator lines. Be thorough, professional, and clinically accurate. Distinguish clearly between patient symptoms/history (Subjective) and clinician findings/vitals/exam (Objective). Document specific medications with dosages, routes, frequencies, and durations if stated. Never fabricate or assume clinical details that were not discussed. For ICD-10 and CPT coding, assign standard codes and descriptions strictly supported by the documented diagnoses and care delivered.',
        messages: [{ role: 'user', content: prompt }],
      })
    }
    throw err
  }
}



async function generateAINote(transcriptions, patientInfo, templateSections) {

  try {

    const settings = await loadAiSettings()

    const loaded = await loadAnthropicClient(settings)

    if (!loaded) return null



    const combinedTranscription = buildCombinedTranscription(transcriptions)

    const prompt = buildAnthropicNotePrompt(patientInfo, combinedTranscription, templateSections)



    console.log('🤖 Generating AI note...')

    const response = await callAnthropicForNote(loaded.client, loaded.settings, prompt)



    const noteText = response.content?.[0]?.text

    if (!noteText) {

      console.error('AI note generation error: empty response')

      return null

    }

    console.log(`✅ AI note generated (${noteText.length} chars)`)

    return noteText

  } catch (err) {

    const status = err?.status || err?.statusCode || '?'
    const errType = err?.error?.type || err?.type || ''
    const errMsg = err?.error?.message || err?.message || String(err)
    console.error(`[aiPipeline] AI note generation failed — HTTP ${status}${errType ? ' (' + errType + ')' : ''}: ${errMsg}`)
    if (status === 401 || errType === 'authentication_error') {
      console.error('[aiPipeline] ⚠ ANTHROPIC API KEY IS INVALID. Go to Admin → Settings and update the Anthropic API key.')
    } else if (status === 429 || errType === 'rate_limit_error') {
      console.error('[aiPipeline] ⚠ ANTHROPIC RATE LIMIT hit. Wait a moment or upgrade your plan.')
    } else if (status === 529 || errType === 'overloaded_error') {
      console.error('[aiPipeline] ⚠ ANTHROPIC API is overloaded. Will retry automatically next time.')
    }

    return null

  }

}



function auditUserFromOptions(options) {

  if (options?.user && options.user.id) return options.user

  return { name: 'AI Pipeline', role: 'system' }

}



/**

 * Persist transcript segments + AI draft (used by sync pipeline).

 * @param {number} id visit id

 * @param {string[]} transcriptions non-empty strings

 * @param {object} visit row with patient_name, mrn, visit_type, visit_date

 * @param {{ user?: object, req?: object, source?: string, completionMessage?: string }} [options]

 * @returns {Promise<{ ok: boolean, error?: string }>}

 */

/**

 * Generate AI draft from transcriptions

 */

async function resolveAiDraft(transcriptions, visit) {

  const templateSections = await resolveTemplateSections(visit.clinician_id, visit.visit_type, 'aiPipeline')

  let aiNote = await generateAINote(transcriptions, {

    patient_name: visit.patient_name,

    mrn: visit.mrn,

    visit_type: visit.visit_type,

    visit_date: visit.visit_date,

  }, templateSections)

  if (!aiNote && transcriptions.length > 0) {
    const combinedTx = Array.isArray(transcriptions) ? transcriptions.join('\n\n') : String(transcriptions || '')
    aiNote = formatClinicalDictationToSOAP(combinedTx, '', visit.visit_type, {
      patientName: visit.patient_name,
      mrn: visit.mrn,
    })
  }

  return aiNote

}



/**

 * Upsert note with transcription and AI draft

 */

async function upsertNoteWithDraft(id, transcriptionData, aiNote) {

  const existingNote = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])



  if (existingNote.rows.length > 0) {

    const status = existingNote.rows[0].status

    if (!['pending', 'draft'].includes(status)) {

      await setVisitTranscriptionStatus(id, 'idle')

      return { ok: false, error: 'note_locked' }

    }

    await pool.query(

      `UPDATE notes SET transcription = $1, ai_draft = $2, updated_at = NOW() WHERE visit_id = $3`,

      [transcriptionData, aiNote, id]

    )

  } else {

    await pool.query(

      `INSERT INTO notes (visit_id, transcription, ai_draft, status) VALUES ($1, $2, $3, 'pending')`,

      [id, transcriptionData, aiNote]

    )

  }

  return { ok: true }

}



async function persistTranscriptionAndDraft(id, transcriptions, visit, options = {}) {

  if (!transcriptions?.length) return { ok: false, error: 'empty' }

  const ctxUser = auditUserFromOptions(options)

  const auditOpts = { req: options.req || null, module_key: 'clinical', action_category: 'update' }

  const transcriptionData = JSON.stringify(transcriptions)

  // Auto-extract dictated patient demographics from audio transcripts
  try {
    const combinedTranscript = transcriptions.join(' ')
    const dictated = extractDictatedPatientDetails(combinedTranscript)
    if (dictated && visit?.patient_id) {
      const currentName = String(visit.patient_name || '').toLowerCase()
      const isPlaceholder = !currentName ||
        currentName.startsWith('dictated') ||
        currentName.startsWith('walk-in') ||
        currentName.startsWith('provisional') ||
        currentName.startsWith('pending') ||
        currentName.includes('unnamed')

      if (dictated.name && (isPlaceholder || dictated.name.length > 3)) {
        await pool.query(
          `UPDATE patients SET 
             name = COALESCE($1, name), 
             mrn = COALESCE($2, mrn), 
             date_of_birth = COALESCE($3, date_of_birth),
             updated_at = NOW() 
           WHERE id = $4`,
          [dictated.name, dictated.mrn || null, dictated.date_of_birth || null, visit.patient_id]
        )
        // Also update local visit object for note generation context
        visit.patient_name = dictated.name
        if (dictated.mrn) visit.mrn = dictated.mrn
        console.log(`[aiPipeline] Automatically updated patient #${visit.patient_id} from dictation:`, dictated)
      }
    }
  } catch (dictErr) {
    console.warn('[aiPipeline] Dictated patient detail update skipped:', dictErr?.message)
  }

  const aiNote = await resolveAiDraft(transcriptions, visit)

  const saved = await upsertNoteWithDraft(id, transcriptionData, aiNote)

  if (!saved.ok) return saved



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

/**

 * Load visit with patient and clinician for pipeline

 */

async function loadVisitForPipeline(id) {

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

  return visitResult.rows[0] || null

}



/**

 * Check if pipeline should skip due to locked note

 */

async function shouldSkipLockedNote(id, ctxUser, auditOpts) {

  const existingNotePre = await pool.query('SELECT id, status FROM notes WHERE visit_id = $1', [id])

  if (existingNotePre.rows.length === 0) return false



  const st = existingNotePre.rows[0].status

  if (['pending', 'draft'].includes(st)) return false



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

  return true

}



/**

 * Handle pipeline transcription failure

 */

async function handlePipelineTranscriptionFailure(id, ctxUser, auditOpts) {

  console.warn(`No transcriptions generated for visit ${id}`)

  await setVisitTranscriptionStatus(id, 'failed')

  await auditLog(ctxUser, 'TRANSCRIPTION_FAILED', 'visit', String(id), 'No transcript produced from audio', {

    ...auditOpts,

    status: 'failure',

    metadata: { visit_id: id },

  })

}



/**

 * Handle pipeline unexpected error

 */

async function handlePipelineError(id, err, options) {

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



async function runAIPipeline(visitId, options = {}) {

  const id = parseInt(visitId, 10)

  if (!Number.isInteger(id)) return

  const ctxUser = auditUserFromOptions(options)

  const auditOpts = { req: options.req || null, module_key: 'clinical', action_category: 'update' }



  try {

    console.log(`\n🚀 Starting AI pipeline for visit ${id}`)

    const settings = await loadAiSettings()



    if (!useDeepgram(settings)) {
      console.error(`[aiPipeline] Visit ${id}: transcription disabled`, {
        DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY ? 'set' : '(unset)',
        USE_DEEPGRAM: process.env.USE_DEEPGRAM || '(unset)',
        transcribe_enabled: !!settings?.transcribe_enabled,
      })

      await setVisitTranscriptionStatus(id, 'failed')

      await auditLog(ctxUser, 'TRANSCRIPTION_FAILED', 'visit', String(id), 'Deepgram not configured', {

        ...auditOpts,

        status: 'failure',

        metadata: { visit_id: id, reason: 'transcribe_not_configured' },

      })

      return

    }



    const visit = await loadVisitForPipeline(id)

    if (!visit) {

      console.error(`Visit ${id} not found`)

      return

    }



    if (!visit.audio_file) {

      console.warn(`No audio file for visit ${id}`)

      await setVisitTranscriptionStatus(id, 'idle')

      return

    }



    if (await shouldSkipLockedNote(id, ctxUser, auditOpts)) return



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

    console.log(`[aiPipeline] Visit ${id}: using Deepgram Nova-3 Medical (${audioFiles.length} file(s))`)



    const { transcriptions, successCount } = await transcribeAllAudioFiles(audioFiles, settings, id)



    if (successCount === 0) {

      await handlePipelineTranscriptionFailure(id, ctxUser, auditOpts)

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

    await handlePipelineError(id, err, options)

  }

}



module.exports = {

  runAIPipeline,

  generateAINote,

  persistTranscriptionAndDraft,

}

