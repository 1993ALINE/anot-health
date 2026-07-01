const { getPublicErrorMessage, sendHttpError } = require('../utils/errorMessages')
const pool = require('../config/db')
const cloudWatchAudit = require('../utils/logger')
const { encryptString } = require('../utils/settingsEncryption')
const { invalidateAiSettingsCache } = require('../services/aiSettings')
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
  deepgram_enabled: false,
  deepgram_model: 'nova-2',
  deepgram_language: 'en-US',
  deepgram_webhook_url: '',
  deepgram_auto_transcribe_on_upload: false,
  anthropic_enabled: true,
  anthropic_model: 'claude-haiku-4-5',
  ffmpeg_enabled: false,
  ffmpeg_target_format: 'mp3',
  ffmpeg_compression: 5,
  ffmpeg_max_upload_mb: 500,
  ffmpeg_preprocess_before_transcribe: true,
  deepgram_timeout_ms: 30000,
}

const MIN_DEEPGRAM_TIMEOUT_SEC = 5
const MAX_DEEPGRAM_TIMEOUT_SEC = 300

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

function mapAiSettings(row) {
  const enc = row.deepgram_api_key_enc
  const anthropicEnc = row.anthropic_api_key_enc
  const model = String(row.anthropic_model || AI_DEFAULTS.anthropic_model).trim()
  return {
    deepgram_enabled: !!row.deepgram_enabled,
    deepgram_api_key_set: !!(enc && String(enc).length > 0),
    deepgram_model: row.deepgram_model || AI_DEFAULTS.deepgram_model,
    deepgram_language: row.deepgram_language || AI_DEFAULTS.deepgram_language,
    deepgram_webhook_url: row.deepgram_webhook_url != null ? String(row.deepgram_webhook_url) : '',
    deepgram_auto_transcribe_on_upload: !!row.deepgram_auto_transcribe_on_upload,
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
    deepgram_timeout_seconds: Math.round((Number(row.deepgram_timeout_ms) || AI_DEFAULTS.deepgram_timeout_ms) / 1000),
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

    // ── API keys: encrypted at rest in system_settings (NOT SSM) ─────────────
    // Admins rotate Deepgram/Anthropic keys via Settings UI without redeploy.
    // SETTINGS_ENCRYPTION_KEY (from SSM at boot) decrypts blobs at runtime.
    // See docs/ADMIN_SETTINGS_ARCHITECTURE.md.
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

    const deepgram_webhook_raw =
      payload.deepgram_webhook_url !== undefined ? cleanStr(payload.deepgram_webhook_url, 2000) : String(cur.deepgram_webhook_url || '')
    if (deepgram_webhook_raw && !/^https?:\/\/.+/i.test(deepgram_webhook_raw)) {
      return res.status(400).json({ error: 'Deepgram webhook URL must be http(s).' })
    }

    let deepgram_enabled =
      payload.deepgram_enabled !== undefined ? !!payload.deepgram_enabled : !!cur.deepgram_enabled
    if (payload.deepgram_clear_api_key === true) {
      deepgram_enabled = false
    } else if (newDeepgramKeySaved) {
      deepgram_enabled = true
    }
    const deepgram_model =
      payload.deepgram_model !== undefined
        ? cleanStr(payload.deepgram_model, 64) || AI_DEFAULTS.deepgram_model
        : cur.deepgram_model || AI_DEFAULTS.deepgram_model
    const deepgram_language =
      payload.deepgram_language !== undefined
        ? cleanStr(payload.deepgram_language, 32) || AI_DEFAULTS.deepgram_language
        : cur.deepgram_language || AI_DEFAULTS.deepgram_language
    const deepgram_auto_transcribe_on_upload =
      payload.deepgram_auto_transcribe_on_upload !== undefined
        ? !!payload.deepgram_auto_transcribe_on_upload
        : !!cur.deepgram_auto_transcribe_on_upload

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

    let deepgram_timeout_ms = Number(cur.deepgram_timeout_ms) || AI_DEFAULTS.deepgram_timeout_ms
    if (payload.deepgram_timeout_seconds != null && payload.deepgram_timeout_seconds !== '') {
      const sec = parseInt(String(payload.deepgram_timeout_seconds), 10)
      if (Number.isFinite(sec)) {
        const clamped = Math.max(MIN_DEEPGRAM_TIMEOUT_SEC, Math.min(MAX_DEEPGRAM_TIMEOUT_SEC, sec))
        deepgram_timeout_ms = clamped * 1000
      }
    }

    const columnSet = await getSystemSettingsColumns()
    const packedSocial = packSocialLinksForSave(userSocial, {
      audit_retention_days,
      deepgram_enabled,
      deepgram_api_key_enc,
      deepgram_model,
      deepgram_language,
      deepgram_webhook_url: deepgram_webhook_raw || '',
      deepgram_auto_transcribe_on_upload,
      anthropic_enabled,
      anthropic_api_key_enc,
      anthropic_model,
      ffmpeg_enabled,
      ffmpeg_target_format,
      ffmpeg_compression,
      ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe,
      deepgram_timeout_ms,
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
      deepgram_enabled,
      deepgram_api_key_enc,
      deepgram_model,
      deepgram_language,
      deepgram_webhook_url: deepgram_webhook_raw || '',
      deepgram_auto_transcribe_on_upload,
      anthropic_enabled,
      anthropic_api_key_enc,
      anthropic_model,
      ffmpeg_enabled,
      ffmpeg_target_format,
      ffmpeg_compression,
      ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe,
      deepgram_timeout_ms,
    })

    invalidateAiSettingsCache()
    invalidateSettingsColumnCache()

    // Emit a per-field audit event for every setting that actually changed.
    // Secrets (API keys) are reported as set/cleared transitions only — never
    // the value itself. Image data URLs are excluded entirely (noisy + large).
    const trackedNext = {
      system_name, system_email, phone, address, footer_text, support_contact, system_description,
      primary_color, secondary_color, audit_retention_days,
      deepgram_enabled, deepgram_model, deepgram_language,
      deepgram_webhook_url: deepgram_webhook_raw || '', deepgram_auto_transcribe_on_upload,
      anthropic_enabled, anthropic_model,
      ffmpeg_enabled, ffmpeg_target_format, ffmpeg_compression, ffmpeg_max_upload_mb,
      ffmpeg_preprocess_before_transcribe, deepgram_timeout_ms,
    }
    const norm = (v) => (v === null || v === undefined ? '' : String(v))
    for (const [name, nextVal] of Object.entries(trackedNext)) {
      const prevVal = cur[name]
      if (norm(prevVal) !== norm(nextVal)) {
        cloudWatchAudit.logSettingChange(req.user.id, req.user.role, name, norm(prevVal), norm(nextVal), req.clientIp)
      }
    }
    if (newDeepgramKeySaved || payload.deepgram_clear_api_key === true) {
      cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'deepgram_api_key',
        cur.deepgram_api_key_enc ? 'set' : 'unset', deepgram_api_key_enc ? 'set' : 'cleared', req.clientIp)
    }
    if (newAnthropicKeySaved || payload.anthropic_clear_api_key === true) {
      cloudWatchAudit.logSettingChange(req.user.id, req.user.role, 'anthropic_api_key',
        cur.anthropic_api_key_enc ? 'set' : 'unset', anthropic_api_key_enc ? 'set' : 'cleared', req.clientIp)
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
      `SELECT deepgram_timeout_ms, deepgram_enabled, deepgram_model, deepgram_language,
              deepgram_auto_transcribe_on_upload, ffmpeg_max_upload_mb
       FROM system_settings WHERE id = 1`,
    )
    const row = result.rows[0] || {}
    const timeoutMs = Number(row.deepgram_timeout_ms) || AI_DEFAULTS.deepgram_timeout_ms
    res.status(200).json({
      settings: {
        deepgram_timeout_seconds: Math.max(
          MIN_DEEPGRAM_TIMEOUT_SEC,
          Math.min(MAX_DEEPGRAM_TIMEOUT_SEC, Math.round(timeoutMs / 1000)),
        ),
        deepgram_enabled: !!row.deepgram_enabled,
        deepgram_model: row.deepgram_model || AI_DEFAULTS.deepgram_model,
        deepgram_language: row.deepgram_language || AI_DEFAULTS.deepgram_language,
        deepgram_auto_transcribe_on_upload: !!row.deepgram_auto_transcribe_on_upload,
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
    const cur = (await pool.query('SELECT deepgram_timeout_ms FROM system_settings WHERE id = 1')).rows[0] || {}

    let deepgram_timeout_ms = Number(cur.deepgram_timeout_ms) || AI_DEFAULTS.deepgram_timeout_ms
    if (payload.deepgram_timeout_seconds != null && payload.deepgram_timeout_seconds !== '') {
      const sec = parseInt(String(payload.deepgram_timeout_seconds), 10)
      if (Number.isFinite(sec)) {
        const clamped = Math.max(MIN_DEEPGRAM_TIMEOUT_SEC, Math.min(MAX_DEEPGRAM_TIMEOUT_SEC, sec))
        deepgram_timeout_ms = clamped * 1000
      }
    }

    await pool.query(
      `UPDATE system_settings SET deepgram_timeout_ms = $1, updated_at = NOW() WHERE id = 1`,
      [deepgram_timeout_ms],
    )
    invalidateAiSettingsCache()

    cloudWatchAudit.logSettingChange(
      req.user.id,
      req.user.role,
      'deepgram_timeout_ms',
      cur.deepgram_timeout_ms,
      deepgram_timeout_ms,
      req.clientIp,
    )

    res.status(200).json({
      message: 'Transcription settings updated.',
      settings: { deepgram_timeout_seconds: Math.round(deepgram_timeout_ms / 1000) },
    })
  } catch (err) {
    sendHttpError(res, 500, err, { context: 'settings.updateTranscription', req })
  }
}

module.exports = {
  getPublicSettings,
  getInternalSettings,
  getTranscriptionSettings,
  updateTranscriptionSettings,
  updateSettings,
  ensureSettingsTable,
}
