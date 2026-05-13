const pool = require('../config/db')
const { encryptString } = require('../utils/settingsEncryption')
const { invalidateAiSettingsCache } = require('../services/aiSettings')
const { ensureMediaAndAiSchema } = require('../utils/ensureMediaSchema')

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

const AI_DEFAULTS = {
  deepgram_enabled: false,
  deepgram_model: 'nova-2',
  deepgram_language: 'en-US',
  deepgram_webhook_url: '',
  deepgram_auto_transcribe_on_upload: false,
  ffmpeg_enabled: false,
  ffmpeg_target_format: 'mp3',
  ffmpeg_compression: 5,
  ffmpeg_max_upload_mb: 100,
  ffmpeg_preprocess_before_transcribe: true,
}

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
  await pool.query(`ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS audit_retention_days INTEGER NOT NULL DEFAULT 365`)
  await pool.query(`UPDATE system_settings SET audit_retention_days = GREATEST(30, LEAST(COALESCE(audit_retention_days, 365), 3650)) WHERE id = 1`)

  await ensureMediaAndAiSchema()

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
    social_links: row.social_links || {},
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
  return {
    deepgram_enabled: !!row.deepgram_enabled,
    deepgram_api_key_set: !!(enc && String(enc).length > 0),
    deepgram_model: row.deepgram_model || AI_DEFAULTS.deepgram_model,
    deepgram_language: row.deepgram_language || AI_DEFAULTS.deepgram_language,
    deepgram_webhook_url: row.deepgram_webhook_url != null ? String(row.deepgram_webhook_url) : '',
    deepgram_auto_transcribe_on_upload: !!row.deepgram_auto_transcribe_on_upload,
    ffmpeg_enabled: !!row.ffmpeg_enabled,
    ffmpeg_target_format: ['wav', 'mp3'].includes(String(row.ffmpeg_target_format || '').toLowerCase())
      ? String(row.ffmpeg_target_format).toLowerCase()
      : 'mp3',
    ffmpeg_compression: row.ffmpeg_compression != null ? Number(row.ffmpeg_compression) : AI_DEFAULTS.ffmpeg_compression,
    ffmpeg_max_upload_mb: row.ffmpeg_max_upload_mb != null ? Number(row.ffmpeg_max_upload_mb) : AI_DEFAULTS.ffmpeg_max_upload_mb,
    ffmpeg_preprocess_before_transcribe: row.ffmpeg_preprocess_before_transcribe !== false,
  }
}

function mapInternalRow(row) {
  return {
    ...mapBaseSettings(row),
    audit_retention_days: row.audit_retention_days != null ? Number(row.audit_retention_days) : 365,
    ...mapAiSettings(row),
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
    res.status(200).json({ settings: mapPublicRow(row) })
  } catch (err) {
    console.error('Get settings error:', err.message)
    res.status(500).json({ error: 'Failed to load settings.' })
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
    const social_links = typeof payload.social_links === 'object' && payload.social_links ? payload.social_links : {}

    if (system_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(system_email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' })
    }

    const logo_data_url = normalizeDataUrl(payload.logo_data_url)
    const favicon_data_url = normalizeDataUrl(payload.favicon_data_url)
    const primary_color = normalizeColor(payload.primary_color, DEFAULT_SETTINGS.primary_color)
    const secondary_color = normalizeColor(payload.secondary_color, DEFAULT_SETTINGS.secondary_color)

    const currentRow = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const cur = currentRow.rows[0] || {}

    let audit_retention_days = Number(cur.audit_retention_days) || 365
    if (payload.audit_retention_days != null && payload.audit_retention_days !== '') {
      const n = parseInt(String(payload.audit_retention_days), 10)
      if (Number.isFinite(n)) audit_retention_days = Math.max(30, Math.min(n, 3650))
    }

    let deepgram_api_key_enc = cur.deepgram_api_key_enc || null
    let newDeepgramKeySaved = false
    if (payload.deepgram_clear_api_key === true) {
      deepgram_api_key_enc = null
    } else if (payload.deepgram_api_key != null && String(payload.deepgram_api_key).trim()) {
      deepgram_api_key_enc = encryptString(String(payload.deepgram_api_key).trim())
      if (!deepgram_api_key_enc) {
        return res.status(500).json({ error: 'Could not encrypt API key (check SETTINGS_ENCRYPTION_KEY / JWT_SECRET).' })
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

    const ffmpeg_enabled = payload.ffmpeg_enabled !== undefined ? !!payload.ffmpeg_enabled : !!cur.ffmpeg_enabled
    const fmtIn =
      payload.ffmpeg_target_format !== undefined ? String(payload.ffmpeg_target_format || 'mp3').toLowerCase() : String(cur.ffmpeg_target_format || 'mp3').toLowerCase()
    const ffmpeg_target_format = fmtIn === 'wav' ? 'wav' : 'mp3'
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

    const result = await pool.query(
      `UPDATE system_settings
       SET system_name = $1,
           system_email = $2,
           phone = $3,
           address = $4,
           company_info = $5,
           footer_text = $6,
           support_contact = $7,
           social_links = $8,
           logo_data_url = $9,
           favicon_data_url = $10,
           primary_color = $11,
           secondary_color = $12,
           system_description = $13,
           audit_retention_days = $14,
           deepgram_enabled = $15,
           deepgram_api_key_enc = $16,
           deepgram_model = $17,
           deepgram_language = $18,
           deepgram_webhook_url = $19,
           deepgram_auto_transcribe_on_upload = $20,
           ffmpeg_enabled = $21,
           ffmpeg_target_format = $22,
           ffmpeg_compression = $23,
           ffmpeg_max_upload_mb = $24,
           ffmpeg_preprocess_before_transcribe = $25,
           updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [
        system_name,
        system_email || null,
        phone || null,
        address || null,
        company_info || null,
        footer_text || null,
        support_contact || null,
        JSON.stringify(social_links),
        logo_data_url || null,
        favicon_data_url || null,
        primary_color,
        secondary_color,
        system_description || null,
        audit_retention_days,
        deepgram_enabled,
        deepgram_api_key_enc,
        deepgram_model,
        deepgram_language,
        deepgram_webhook_raw || '',
        deepgram_auto_transcribe_on_upload,
        ffmpeg_enabled,
        ffmpeg_target_format,
        ffmpeg_compression,
        ffmpeg_max_upload_mb,
        ffmpeg_preprocess_before_transcribe,
      ]
    )

    invalidateAiSettingsCache()
    res.status(200).json({ message: 'Settings saved successfully.', settings: mapInternalRow(result.rows[0]) })
  } catch (err) {
    console.error('Update settings error:', err.message)
    res.status(500).json({ error: 'Failed to save settings.' })
  }
}

const getInternalSettings = async (req, res) => {
  try {
    await ensureSettingsTable()
    const result = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const row = result.rows[0] || DEFAULT_SETTINGS
    res.status(200).json({ settings: mapInternalRow(row) })
  } catch (err) {
    console.error('Get internal settings error:', err.message)
    res.status(500).json({ error: 'Failed to load settings.' })
  }
}

module.exports = {
  getPublicSettings,
  getInternalSettings,
  updateSettings,
  ensureSettingsTable,
}
