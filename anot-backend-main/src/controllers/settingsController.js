const fs = require('fs')
const path = require('path')
const { getPublicErrorMessage, sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const cloudWatchAudit = require('../utils/logger')
const { encryptString } = require('../utils/settingsEncryption')
const { invalidateAiSettingsCache, normalizeDeepgramModel, loadAiSettings } = require('../services/aiSettings')
const {
  normalizeTranscribeLanguage,
  parseCustomVocabulary,
} = require('../utils/deepgramSettingsUtils')
const {
  buildBaselineListenOptions,
  buildListenOptions,
  transcribeLocalFileDetailed,
  resolveDeepgramApiKey,
} = require('../services/deepgramService')
const { ensureMediaAndAiSchema } = require('../utils/ensureMediaSchema')
const { addColumnIfMissing, columnExists } = require('../utils/schemaDdl')
const { getSystemSettingsColumns, updateSystemSettingsRow, invalidateSettingsColumnCache } = require('../utils/settingsSchemaCompat')
const { publicSocialLinks, mergeRowWithExtensions, packSocialLinksForSave } = require('../utils/settingsExtensions')
const {
  MIN_AUDIT_RETENTION_DAYS,
  MAX_AUDIT_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_DAYS,
  clampAuditRetentionDays,
} = require('../utils/auditRetentionPolicy')

const DEFAULT_SETTINGS = {
  system_name: 'Anot',
  system_email: '',
  phone: '',
  address: '',
  company_info: '',
  footer_text: '',
  support_contact: '',
  social_links: {},
  logo_data_url: '',
  favicon_data_url: '',
  primary_color: '#2563eb',
  secondary_color: '#0d9488',
  system_description: 'Clinical documentation platform',
}

const ANTHROPIC_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'])

const AI_DEFAULTS = {
  transcribe_enabled: false,
  transcribe_language: 'en-US',
  transcribe_medical_specialty: 'PRIMARYCARE',
  transcribe_show_speaker_labels: true,
  transcribe_auto_transcribe_on_upload: true,
  deepgram_model: 'nova-3-medical',
  anthropic_enabled: true,
  anthropic_model: 'claude-haiku-4-5',
  ffmpeg_enabled: false,
  ffmpeg_target_format: 'mp3',
  ffmpeg_compression: 5,
  ffmpeg_max_upload_mb: 500,
  ffmpeg_preprocess_before_transcribe: true,
  transcribe_timeout_ms: 300000,
  deepgram_profanity_filter: false,
  deepgram_punctuate: true,
  deepgram_numerals: true,
  deepgram_redact_pii: false,
  deepgram_remove_filler_words: true,
  deepgram_custom_vocabulary: [],
}

const MIN_TRANSCRIBE_TIMEOUT_SEC = 60
const MAX_TRANSCRIBE_TIMEOUT_SEC = 1800

let initialized = false

async function ensureSettingsTable() {
  if (initialized) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id                INTEGER PRIMARY KEY DEFAULT 1,
      system_name       TEXT NOT NULL DEFAULT 'Anot',
      system_email      TEXT,
      phone             TEXT,
      address           TEXT,
      company_info      TEXT,
      footer_text       TEXT,
      support_contact   TEXT,
      social_links      JSONB NOT NULL DEFAULT '{}'::jsonb,
      logo_data_url     TEXT,
      favicon_data_url  TEXT,
      primary_color     VARCHAR(16) NOT NULL DEFAULT '#2563eb',
      secondary_color   VARCHAR(16) NOT NULL DEFAULT '#0d9488',
      system_description TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT system_settings_singleton CHECK (id = 1)
    )
  `)
  await pool.query(`
    INSERT INTO system_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `)
  await addColumnIfMissing(
    'system_settings',
    'audit_retention_days',
    `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER NOT NULL DEFAULT ${DEFAULT_AUDIT_RETENTION_DAYS}`,
  )
  if (await columnExists('system_settings', 'audit_retention_days')) {
    await pool.query(
      `UPDATE system_settings SET audit_retention_days = GREATEST(${MIN_AUDIT_RETENTION_DAYS}, LEAST(COALESCE(audit_retention_days, ${DEFAULT_AUDIT_RETENTION_DAYS}), ${MAX_AUDIT_RETENTION_DAYS})) WHERE id = 1`,
    )
  }

  await ensureMediaAndAiSchema()
  invalidateSettingsColumnCache()

  initialized = true
}

function normalizeColor(v, fallback) {
  const value = String(v || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(value) || /^#[0-9a-fA-F]{3}$/.test(value)) return value
  return fallback
}

function normalizeDataUrl(v) {
  const value = String(v || '').trim()
  if (!value) return ''
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif);base64,/i.test(value)) return ''
  if (value.length > 1_700_000) return ''
  return value
}

function cleanStr(v, max = 1000) {
  return String(v || '').trim().slice(0, max)
}

function mapBaseSettings(row) {
  return {
    system_name: row.system_name || DEFAULT_SETTINGS.system_name,
    system_email: row.system_email || '',
    phone: row.phone || '',
    address: row.address || '',
    company_info: row.company_info || '',
    footer_text: row.footer_text || '',
    support_contact: row.support_contact || '',
    social_links: publicSocialLinks(row.social_links),
    logo_data_url: row.logo_data_url || '',
    favicon_data_url: row.favicon_data_url || '',
    primary_color: row.primary_color || DEFAULT_SETTINGS.primary_color,
    secondary_color: row.secondary_color || DEFAULT_SETTINGS.secondary_color,
    system_description: row.system_description || '',
    updated_at: row.updated_at,
  }
}

const TRANSCRIBE_SPECIALTIES = new Set(['PRIMARYCARE', 'CARDIOLOGY', 'NEUROLOGY', 'ONCOLOGY', 'RADIOLOGY', 'UROLOGY'])

function mapAiSettings(row) {
  const anthropicEnc = row.anthropic_api_key_enc
  const deepgramEnc = row.deepgram_api_key_enc
  const model = String(row.anthropic_model || AI_DEFAULTS.anthropic_model).trim()
  const specialty = String(row.transcribe_medical_specialty || AI_DEFAULTS.transcribe_medical_specialty).trim().toUpperCase()
  const deepgramModelIn = String(row.deepgram_model || AI_DEFAULTS.deepgram_model).trim()
  const timeoutMs = Number(row.transcribe_timeout_ms ?? row.deepgram_timeout_ms) || AI_DEFAULTS.transcribe_timeout_ms
  return {
    transcribe_enabled: row.transcribe_enabled != null ? !!row.transcribe_enabled : !!row.deepgram_enabled,
    transcribe_language: normalizeTranscribeLanguage(
      row.transcribe_language || row.deepgram_language,
      AI_DEFAULTS.transcribe_language,
    ),
    transcribe_medical_specialty: TRANSCRIBE_SPECIALTIES.has(specialty) ? specialty : AI_DEFAULTS.transcribe_medical_specialty,
    deepgram_model: normalizeDeepgramModel(deepgramModelIn),
    transcribe_show_speaker_labels: row.transcribe_show_speaker_labels !== false,
    transcribe_auto_transcribe_on_upload: row.transcribe_auto_transcribe_on_upload != null
      ? !!row.transcribe_auto_transcribe_on_upload
      : !!row.deepgram_auto_transcribe_on_upload,
    deepgram_api_key_set: !!(deepgramEnc && String(deepgramEnc).length > 0),
    anthropic_api_key_set: !!(anthropicEnc && String(anthropicEnc).length > 0),
    anthropic_enabled: row.anthropic_enabled !== false,
    anthropic_model: ANTHROPIC_MODELS.has(model) ? model : AI_DEFAULTS.anthropic_model,
    ffmpeg_enabled: !!row.ffmpeg_enabled,
    ffmpeg_target_format: ['wav', 'mp3', 'ogg', 'webm', 'flac'].includes(String(row.ffmpeg_target_format || '').toLowerCase())
      ? String(row.ffmpeg_target_format).toLowerCase()
      : 'mp3',
    ffmpeg_compression: row.ffmpeg_compression != null ? Number(row.ffmpeg_compression) : AI_DEFAULTS.ffmpeg_compression,
    ffmpeg_max_upload_mb: row.ffmpeg_max_upload_mb != null ? Number(row.ffmpeg_max_upload_mb) : AI_DEFAULTS.ffmpeg_max_upload_mb,
    ffmpeg_preprocess_before_transcribe: row.ffmpeg_preprocess_before_transcribe !== false,
    transcribe_timeout_seconds: Math.round(timeoutMs / 1000),
    deepgram_profanity_filter: !!row.deepgram_profanity_filter,
    deepgram_punctuate: row.deepgram_punctuate !== false,
    deepgram_numerals: row.deepgram_numerals !== false,
    deepgram_redact_pii: !!row.deepgram_redact_pii,
    deepgram_remove_filler_words: row.deepgram_remove_filler_words !== false,
    deepgram_custom_vocabulary: parseCustomVocabulary(row.deepgram_custom_vocabulary),
  }
}

function mapInternalRow(row, columnSet) {
  const merged = mergeRowWithExtensions(row, columnSet)
  return {
    ...mapBaseSettings(merged),
    audit_retention_days: clampAuditRetentionDays(merged.audit_retention_days),
    ...mapAiSettings(merged),
  }
}

function mapPublicRow(row) {
  return { ...mapBaseSettings(row) }
}

const getPublicSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    const result = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const row = result.rows[0] || DEFAULT_SETTINGS
    const cols = await getSystemSettingsColumns()
    res.status(200).json({ settings: mapPublicRow(mergeRowWithExtensions(row, cols)) })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.getPublic', req })
  }
}

const updateSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    const payload = req.body || {}

    const system_name = cleanStr(payload.system_name, 120) || DEFAULT_SETTINGS.system_name
    const system_email = cleanStr(payload.system_email, 160)
    const phone = cleanStr(payload.phone, 80)
    const address = cleanStr(payload.address, 240)
    const company_info = cleanStr(payload.company_info, 4000)
    const footer_text = cleanStr(payload.footer_text, 240)
    const support_contact = cleanStr(payload.support_contact, 240)
    const system_description = cleanStr(payload.system_description, 400)
    const socialPayload = typeof payload.social_links === 'object' && payload.social_links ? payload.social_links : {}
    const userSocial = { ...socialPayload }
    delete userSocial.__admin_meta

    if (system_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(system_email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' })
    }

    const logo_data_url = normalizeDataUrl(payload.logo_data_url)
    const favicon_data_url = normalizeDataUrl(payload.favicon_data_url)
    const primary_color = normalizeColor(payload.primary_color, DEFAULT_SETTINGS.primary_color)
    const secondary_color = normalizeColor(payload.secondary_color, DEFAULT_SETTINGS.secondary_color)

    const currentRow = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const cur = currentRow.rows[0] || {}

    let audit_retention_days = clampAuditRetentionDays(cur.audit_retention_days)
    if (payload.audit_retention_days != null && payload.audit_retention_days !== '') {
      const n = parseInt(String(payload.audit_retention_days), 10)
      if (Number.isFinite(n)) { audit_retention_days = clampAuditRetentionDays(n) }
    }

    // ── Transcribe + Anthropic settings ─────────────────────────────────────
    const transcribe_enabled =
      payload.transcribe_enabled !== undefined ? !!payload.transcribe_enabled : (cur.transcribe_enabled != null ? !!cur.transcribe_enabled : !!cur.deepgram_enabled)
    const transcribe_language =
      payload.transcribe_language !== undefined
        ? normalizeTranscribeLanguage(cleanStr(payload.transcribe_language, 32), AI_DEFAULTS.transcribe_language)
        : normalizeTranscribeLanguage(cur.transcribe_language || cur.deepgram_language, AI_DEFAULTS.transcribe_language)
    const specialtyIn =
      payload.transcribe_medical_specialty !== undefined
        ? cleanStr(payload.transcribe_medical_specialty, 32).toUpperCase()
        : String(cur.transcribe_medical_specialty || AI_DEFAULTS.transcribe_medical_specialty).toUpperCase()
    const transcribe_medical_specialty = TRANSCRIBE_SPECIALTIES.has(specialtyIn) ? specialtyIn : AI_DEFAULTS.transcribe_medical_specialty
    const deepgramModelIn =
      payload.deepgram_model !== undefined
        ? cleanStr(payload.deepgram_model, 64)
        : String(cur.deepgram_model || AI_DEFAULTS.deepgram_model)
    const deepgram_model = normalizeDeepgramModel(deepgramModelIn)
    const transcribe_show_speaker_labels =
      payload.transcribe_show_speaker_labels !== undefined
        ? !!payload.transcribe_show_speaker_labels
        : cur.transcribe_show_speaker_labels !== false
    const transcribe_auto_transcribe_on_upload =
      payload.transcribe_auto_transcribe_on_upload !== undefined
        ? !!payload.transcribe_auto_transcribe_on_upload
        : (cur.transcribe_auto_transcribe_on_upload != null ? !!cur.transcribe_auto_transcribe_on_upload : !!cur.deepgram_auto_transcribe_on_upload)

    let anthropic_api_key_enc = cur.anthropic_api_key_enc || null
    let newAnthropicKeySaved = false
    if (payload.anthropic_clear_api_key === true) {
      anthropic_api_key_enc = null
    } else if (payload.anthropic_api_key != null && String(payload.anthropic_api_key).trim()) {
      anthropic_api_key_enc = encryptString(String(payload.anthropic_api_key).trim())
      if (!anthropic_api_key_enc) {
        return res.status(500).json({ error: getPublicErrorMessage(500, new Error('encryption failed')) })
      }
      newAnthropicKeySaved = true
    }

    let anthropic_enabled =
      payload.anthropic_enabled !== undefined ? !!payload.anthropic_enabled : cur.anthropic_enabled !== false
    if (payload.anthropic_clear_api_key === true) {
      anthropic_enabled = false
    } else if (newAnthropicKeySaved) {
      anthropic_enabled = true
    }
    const anthropicModelIn =
      payload.anthropic_model !== undefined
        ? cleanStr(payload.anthropic_model, 100) || AI_DEFAULTS.anthropic_model
        : String(cur.anthropic_model || AI_DEFAULTS.anthropic_model)
    const anthropic_model = ANTHROPIC_MODELS.has(anthropicModelIn) ? anthropicModelIn : AI_DEFAULTS.anthropic_model

    let deepgram_api_key_enc = cur.deepgram_api_key_enc || null
    let newDeepgramKeySaved = false
    if (payload.deepgram_clear_api_key === true) {
      deepgram_api_key_enc = null
    } else if (payload.deepgram_api_key != null && String(payload.deepgram_api_key).trim()) {
      deepgram_api_key_enc = encryptString(String(payload.deepgram_api_key).trim())
      if (!deepgram_api_key_enc) {
        return res.status(500).json({ error: getPublicErrorMessage(500, new Error('encryption failed')) })
      }
      newDeepgramKeySaved = true
    }

    const ffmpeg_enabled = payload.ffmpeg_enabled !== undefined ? !!payload.ffmpeg_enabled : !!cur.ffmpeg_enabled
    const fmtIn =
      payload.ffmpeg_target_format !== undefined ? String(payload.ffmpeg_target_format || 'mp3').toLowerCase() : String(cur.ffmpeg_target_format || 'mp3').toLowerCase()
    const ffmpeg_target_format = ['wav', 'mp3', 'ogg', 'webm', 'flac'].includes(fmtIn) ? fmtIn : 'mp3'
    let ffmpeg_compression =
      payload.ffmpeg_compression !== undefined ? parseInt(String(payload.ffmpeg_compression), 10) : Number(cur.ffmpeg_compression)
    if (!Number.isFinite(ffmpeg_compression)) ffmpeg_compression = AI_DEFAULTS.ffmpeg_compression
    ffmpeg_compression = Math.max(0, Math.min(9, ffmpeg_compression))
    let ffmpeg_max_upload_mb =
      payload.ffmpeg_max_upload_mb !== undefined ? parseInt(String(payload.ffmpeg_max_upload_mb), 10) : Number(cur.ffmpeg_max_upload_mb)
    if (!Number.isFinite(ffmpeg_max_upload_mb)) ffmpeg_max_upload_mb = AI_DEFAULTS.ffmpeg_max_upload_mb
    ffmpeg_max_upload_mb = Math.max(1, Math.min(500, ffmpeg_max_upload_mb))
    const ffmpeg_preprocess_before_transcribe =
      payload.ffmpeg_preprocess_before_transcribe !== undefined
        ? !!payload.ffmpeg_preprocess_before_transcribe
        : cur.ffmpeg_preprocess_before_transcribe !== false

    const deepgram_profanity_filter =
      payload.deepgram_profanity_filter !== undefined
        ? !!payload.deepgram_profanity_filter
        : !!cur.deepgram_profanity_filter
    const deepgram_punctuate =
      payload.deepgram_punctuate !== undefined
        ? !!payload.deepgram_punctuate
        : cur.deepgram_punctuate !== false
    const deepgram_numerals =
      payload.deepgram_numerals !== undefined
        ? !!payload.deepgram_numerals
        : cur.deepgram_numerals !== false
    const deepgram_redact_pii =
      payload.deepgram_redact_pii !== undefined
        ? !!payload.deepgram_redact_pii
        : !!cur.deepgram_redact_pii
    const deepgram_remove_filler_words =
      payload.deepgram_remove_filler_words !== undefined
        ? !!payload.deepgram_remove_filler_words
        : cur.deepgram_remove_filler_words !== false
    const deepgram_custom_vocabulary = parseCustomVocabulary(
      payload.deepgram_custom_vocabulary !== undefined
        ? payload.deepgram_custom_vocabulary
        : cur.deepgram_custom_vocabulary,
    )

    let transcribe_timeout_ms = Number(cur.transcribe_timeout_ms ?? cur.deepgram_timeout_ms) || AI_DEFAULTS.transcribe_timeout_ms
    if (payload.transcribe_timeout_seconds != null && payload.transcribe_timeout_seconds !== '') {
      const sec = parseInt(String(payload.transcribe_timeout_seconds), 10)
      if (Number.isFinite(sec)) {
        const clamped = Math.max(MIN_TRANSCRIBE_TIMEOUT_SEC, Math.min(MAX_TRANSCRIBE_TIMEOUT_SEC, sec))
        transcribe_timeout_ms = clamped * 1000
      }
    }

    const columnSet = await getSystemSettingsColumns()
    const packedSocial = packSocialLinksForSave(userSocial, {
      audit_retention_days,
      transcribe_enabled,
      transcribe_language,
      transcribe_medical_specialty,
      transcribe_show_speaker_labels,
      transcribe_auto_transcribe_on_upload,
      deepgram_model,
      deepgram_api_key_enc,
      anthropic_enabled,
      anthropic_api_key_enc,
      anthropic_model,
      ffmpeg_enabled,
      ffmpeg_target_format,
      ffmpeg_compression,
      ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe,
      transcribe_timeout_ms,
      deepgram_profanity_filter,
      deepgram_punctuate,
      deepgram_numerals,
      deepgram_redact_pii,
      deepgram_remove_filler_words,
      deepgram_custom_vocabulary,
    }, columnSet)

    const result = await updateSystemSettingsRow({
      system_name,
      system_email: system_email || null,
      phone: phone || null,
      address: address || null,
      company_info: company_info || null,
      footer_text: footer_text || null,
      support_contact: support_contact || null,
      social_links: packedSocial,
      logo_data_url: logo_data_url || null,
      favicon_data_url: favicon_data_url || null,
      primary_color,
      secondary_color,
      system_description: system_description || null,
      audit_retention_days,
      transcribe_enabled,
      transcribe_language,
      transcribe_medical_specialty,
      transcribe_show_speaker_labels,
      transcribe_auto_transcribe_on_upload,
      deepgram_model,
      deepgram_api_key_enc,
      anthropic_enabled,
      anthropic_api_key_enc,
      anthropic_model,
      ffmpeg_enabled,
      ffmpeg_target_format,
      ffmpeg_compression,
      ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe,
      transcribe_timeout_ms,
      deepgram_profanity_filter,
      deepgram_punctuate,
      deepgram_numerals,
      deepgram_redact_pii,
      deepgram_remove_filler_words,
      deepgram_custom_vocabulary,
    })

    invalidateAiSettingsCache()
    invalidateSettingsColumnCache()

    // Emit a per-field audit event for every setting that actually changed.
    // Secrets (API keys) are reported as set/cleared transitions only — never
    // the value itself. Image data URLs are excluded entirely (noisy + large).
    const trackedNext = {
      system_name, system_email, phone, address, footer_text, support_contact, system_description,
      primary_color, secondary_color, audit_retention_days,
      transcribe_enabled, transcribe_language, transcribe_medical_specialty, deepgram_model,
      transcribe_show_speaker_labels, transcribe_auto_transcribe_on_upload,
      deepgram_profanity_filter, deepgram_punctuate, deepgram_numerals,
      deepgram_redact_pii, deepgram_remove_filler_words, deepgram_custom_vocabulary,
      anthropic_enabled, anthropic_model,
      ffmpeg_enabled, ffmpeg_target_format, ffmpeg_compression, ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe, transcribe_timeout_ms,
    }
    const norm = (v) => (v === null || v === undefined ? '' : String(v))
    for (const [name, nextVal] of Object.entries(trackedNext)) {
      const prevVal = cur[name]
      if (norm(prevVal) !== norm(nextVal)) {
        cloudWatchAudit.logSettingChange(req.user.id, req.user.role, name, norm(prevVal), norm(nextVal), req.clientIp)
      }
    }
    if (newAnthropicKeySaved || payload.anthropic_clear_api_key === true) {
      cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'anthropic_api_key',
        cur.anthropic_api_key_enc ? 'set' : 'unset', anthropic_api_key_enc ? 'set' : 'cleared', req.clientIp)
    }
    if (newDeepgramKeySaved || payload.deepgram_clear_api_key === true) {
      cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'deepgram_api_key',
        cur.deepgram_api_key_enc ? 'set' : 'unset', deepgram_api_key_enc ? 'set' : 'cleared', req.clientIp)
    }

    res.status(200).json({ message: 'Settings saved successfully.', settings: mapInternalRow(result.rows[0], columnSet) })
  } catch (err) {
    if (/does not exist/i.test(String(err.message))) {
      console.error('[settings.update] Schema gap:', err.message)
    }
    sendHttpError(res, 500, err, { context: 'settings.update', req })
  }
}

const getInternalSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    const result = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const row = result.rows[0] || DEFAULT_SETTINGS
    const cols = await getSystemSettingsColumns()
    res.status(200).json({ settings: mapInternalRow(row, cols) })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.getInternal', req })
  }
}

const getTranscriptionSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    await ensureMediaAndAiSchema()
    const result = await pool.query(
      `SELECT transcribe_timeout_ms, transcribe_enabled, transcribe_language,
              transcribe_medical_specialty, transcribe_auto_transcribe_on_upload,
              deepgram_timeout_ms, deepgram_enabled, deepgram_language, deepgram_auto_transcribe_on_upload,
              ffmpeg_max_upload_mb
       FROM system_settings WHERE id = 1`,
    )
    const row = result.rows[0] || {}
    const timeoutMs = Number(row.transcribe_timeout_ms ?? row.deepgram_timeout_ms) || AI_DEFAULTS.transcribe_timeout_ms
    res.status(200).json({
      settings: {
        transcribe_timeout_seconds: Math.max(
          MIN_TRANSCRIBE_TIMEOUT_SEC,
          Math.min(MAX_TRANSCRIBE_TIMEOUT_SEC, Math.round(timeoutMs / 1000)),
        ),
        transcribe_enabled: row.transcribe_enabled != null ? !!row.transcribe_enabled : !!row.deepgram_enabled,
        transcribe_language: row.transcribe_language || row.deepgram_language || AI_DEFAULTS.transcribe_language,
        transcribe_medical_specialty: row.transcribe_medical_specialty || AI_DEFAULTS.transcribe_medical_specialty,
        transcribe_auto_transcribe_on_upload: row.transcribe_auto_transcribe_on_upload != null
          ? !!row.transcribe_auto_transcribe_on_upload
          : !!row.deepgram_auto_transcribe_on_upload,
        ffmpeg_max_upload_mb: row.ffmpeg_max_upload_mb != null ? Number(row.ffmpeg_max_upload_mb) : AI_DEFAULTS.ffmpeg_max_upload_mb,
      },
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.getTranscription', req })
  }
}

const updateTranscriptionSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    await ensureMediaAndAiSchema()
    const payload = req.body?.settings != null ? req.body.settings : req.body
    const cur = (await pool.query('SELECT transcribe_timeout_ms, deepgram_timeout_ms FROM system_settings WHERE id = 1')).rows[0] || {}

    let transcribe_timeout_ms = Number(cur.transcribe_timeout_ms ?? cur.deepgram_timeout_ms) || AI_DEFAULTS.transcribe_timeout_ms
    if (payload.transcribe_timeout_seconds != null && payload.transcribe_timeout_seconds !== '') {
      const sec = parseInt(String(payload.transcribe_timeout_seconds), 10)
      if (Number.isFinite(sec)) {
        const clamped = Math.max(MIN_TRANSCRIBE_TIMEOUT_SEC, Math.min(MAX_TRANSCRIBE_TIMEOUT_SEC, sec))
        transcribe_timeout_ms = clamped * 1000
      }
    }

    await pool.query(
      `UPDATE system_settings SET transcribe_timeout_ms = $1, updated_at = NOW() WHERE id = 1`,
      [transcribe_timeout_ms],
    )
    invalidateAiSettingsCache()

    cloudWatchAudit.logSettingChange(
      req.user.id,
      req.user.role,
      'transcribe_timeout_ms',
      cur.transcribe_timeout_ms ?? cur.deepgram_timeout_ms,
      transcribe_timeout_ms,
      req.clientIp,
    )

    res.status(200).json({
      message: 'Transcription settings updated.',
      settings: { transcribe_timeout_seconds: Math.round(transcribe_timeout_ms / 1000) },
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.updateTranscription', req })
  }
}

function resolveDeepgramSampleAudioPath() {
  const fixturesDir = path.join(__dirname, '..', '..', 'test-fixtures', 'deepgram')
  const candidates = ['test-e2e-speech.wav', 'test-probe.wav']
  for (const name of candidates) {
    const abs = path.join(fixturesDir, name)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

function mergeDeepgramTestSettings(base, overrides = {}) {
  return {
    ...base,
    transcribe_language: overrides.transcribe_language != null
      ? normalizeTranscribeLanguage(overrides.transcribe_language, base.transcribe_language)
      : base.transcribe_language,
    deepgram_model: overrides.deepgram_model != null
      ? normalizeDeepgramModel(String(overrides.deepgram_model))
      : base.deepgram_model,
    transcribe_show_speaker_labels: overrides.transcribe_show_speaker_labels != null
      ? !!overrides.transcribe_show_speaker_labels
      : base.transcribe_show_speaker_labels,
    deepgram_profanity_filter: overrides.deepgram_profanity_filter != null
      ? !!overrides.deepgram_profanity_filter
      : base.deepgram_profanity_filter,
    deepgram_punctuate: overrides.deepgram_punctuate != null
      ? !!overrides.deepgram_punctuate
      : base.deepgram_punctuate,
    deepgram_numerals: overrides.deepgram_numerals != null
      ? !!overrides.deepgram_numerals
      : base.deepgram_numerals,
    deepgram_redact_pii: overrides.deepgram_redact_pii != null
      ? !!overrides.deepgram_redact_pii
      : base.deepgram_redact_pii,
    deepgram_remove_filler_words: overrides.deepgram_remove_filler_words != null
      ? !!overrides.deepgram_remove_filler_words
      : base.deepgram_remove_filler_words,
    deepgram_custom_vocabulary: overrides.deepgram_custom_vocabulary != null
      ? parseCustomVocabulary(overrides.deepgram_custom_vocabulary)
      : base.deepgram_custom_vocabulary,
  }
}

function computeConfidenceImprovement(baseline, advanced) {
  if (baseline == null || advanced == null) return null
  if (baseline <= 0) return null
  return Math.round(((advanced - baseline) / baseline) * 1000) / 10
}

const testDeepgramAdvancedSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    const saved = await loadAiSettings()
    const apiKey = resolveDeepgramApiKey(saved)
    if (!apiKey) {
      return res.status(400).json({ error: 'Deepgram API key is not configured.' })
    }

    const samplePath = resolveDeepgramSampleAudioPath()
    if (!samplePath) {
      return res.status(500).json({ error: 'Sample audio fixture is not available on the server.' })
    }

    const overrides = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : req.body || {}
    const advancedSettings = mergeDeepgramTestSettings(saved, overrides)
    advancedSettings.deepgram_api_key = apiKey
    advancedSettings.transcribe_enabled = true

    const baselineOptions = buildBaselineListenOptions(advancedSettings, null)
    const advancedOptions = buildListenOptions(advancedSettings, null)

    const [baselineResult, advancedResult] = await Promise.all([
      transcribeLocalFileDetailed(samplePath, advancedSettings, 0, 0, baselineOptions),
      transcribeLocalFileDetailed(samplePath, advancedSettings, 0, 0, advancedOptions),
    ])

    if (!baselineResult && !advancedResult) {
      return res.status(502).json({ error: 'Deepgram test transcription failed. Check API key and network connectivity.' })
    }

    const baselineConfidence = baselineResult?.confidence ?? null
    const advancedConfidence = advancedResult?.confidence ?? null
    const improvementPercent = computeConfidenceImprovement(baselineConfidence, advancedConfidence)

    res.status(200).json({
      message: 'Deepgram advanced settings test completed.',
      sampleAudio: path.basename(samplePath),
      currentSettings: {
        transcribe_language: advancedSettings.transcribe_language,
        deepgram_model: advancedSettings.deepgram_model,
        transcribe_show_speaker_labels: advancedSettings.transcribe_show_speaker_labels,
        deepgram_profanity_filter: advancedSettings.deepgram_profanity_filter,
        deepgram_punctuate: advancedSettings.deepgram_punctuate,
        deepgram_numerals: advancedSettings.deepgram_numerals,
        deepgram_redact_pii: advancedSettings.deepgram_redact_pii,
        deepgram_remove_filler_words: advancedSettings.deepgram_remove_filler_words,
        deepgram_custom_vocabulary: advancedSettings.deepgram_custom_vocabulary,
      },
      baseline: {
        transcript: baselineResult?.transcript || '',
        confidence: baselineConfidence,
        options: baselineOptions,
      },
      advanced: {
        transcript: advancedResult?.transcript || '',
        confidence: advancedConfidence,
        options: advancedOptions,
      },
      accuracy: {
        baselineConfidence,
        advancedConfidence,
        improvementPercent,
        summary: improvementPercent == null
          ? 'Confidence comparison unavailable for this sample (silent or empty audio).'
          : improvementPercent >= 0
            ? `Advanced settings improved confidence by ${improvementPercent}%.`
            : `Advanced settings changed confidence by ${improvementPercent}%.`,
      },
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.testDeepgramAdvanced', req })
  }
}

module.exports = {
  getPublicSettings,
  getInternalSettings,
  getTranscriptionSettings,
  updateTranscriptionSettings,
  updateSettings,
  testDeepgramAdvancedSettings,
  ensureSettingsTable,
}
