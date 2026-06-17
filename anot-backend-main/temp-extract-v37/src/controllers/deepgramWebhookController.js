const pool = require('../config/db')
const { setVisitTranscriptionStatus } = require('../utils/visitSchemaCompat')
const { auditLog } = require('../utils/auditLogger')
const { verifyDeepgramVisitToken } = require('../utils/webhookSignature')
const { extractTranscriptsFromDeepgramBody } = require('../utils/deepgramPayload')
const { persistTranscriptionAndDraft } = require('../utils/aiPipeline')

const WEBHOOK_USER = { name: 'Deepgram Webhook', role: 'system' }

/**
 * POST /api/webhooks/deepgram?visit_id=&ts=&sig=
 * Deepgram async callback. Signature is an HMAC over visit_id + timestamp using
 * DEEPGRAM_WEBHOOK_SECRET and is rejected if older than the replay window.
 */
const postDeepgramWebhook = async (req, res) => {
  try {
    const visitIdRaw = req.query.visit_id ?? req.body?.metadata?.visit_id
    const visitId = parseInt(String(visitIdRaw), 10)
    const sig = req.query.sig ?? req.body?.sig
    const ts = req.query.ts ?? req.body?.ts

    if (!Number.isInteger(visitId)) {
      return res.status(400).json({ error: 'visit_id required.' })
    }
    // Verify HMAC signature AND timestamp (rejects replays older than 5 min).
    if (!verifyDeepgramVisitToken(visitId, sig, ts)) {
      return res.status(401).json({ error: 'Invalid or expired webhook signature.' })
    }

    const texts = extractTranscriptsFromDeepgramBody(req.body)
    if (!texts.length) {
      await setVisitTranscriptionStatus(visitId, 'failed')
      await auditLog(
        WEBHOOK_USER,
        'TRANSCRIPTION_FAILED',
        'visit',
        String(visitId),
        'Deepgram webhook: no transcript in payload',
        { req, module_key: 'clinical', action_category: 'update', status: 'failure' }
      )
      return res.status(400).json({ error: 'No transcript in payload.' })
    }

    const visitResult = await pool.query(
      `
      SELECT v.*, p.name AS patient_name, p.mrn
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1
    `,
      [visitId]
    )
    const visit = visitResult.rows[0]
    if (!visit) {
      return res.status(404).json({ error: 'Visit not found.' })
    }

    const out = await persistTranscriptionAndDraft(visitId, texts, visit, {
      user: WEBHOOK_USER,
      req,
      source: 'deepgram_webhook',
      completionMessage: 'Transcription completed via Deepgram callback',
    })

    if (!out.ok && out.error === 'note_locked') {
      return res.status(409).json({ error: 'Note is locked; cannot apply webhook transcript.' })
    }

    res.status(200).json({ ok: true, segments: texts.length })
  } catch (err) {
    console.error('Deepgram webhook error:', err.message)
    res.status(500).json({ error: 'Webhook handler failed.' })
  }
}

module.exports = { postDeepgramWebhook }
