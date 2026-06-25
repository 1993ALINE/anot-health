const pool = require('../config/db')
const { decryptString } = require('../utils/settingsEncryption')
const { ensureMediaAndAiSchema } = require('../utils/ensureMediaSchema')
const { mergeRowWithExtensions } = require('../utils/settingsExtensions')
const { getSystemSettingsColumns } = require('../utils/settingsSchemaCompat')

const ANTHROPIC_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'])

const DEFAULTS = {
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
  ffmpeg_max_upload_mb: 100,
  ffmpeg_preprocess_before_transcribe: true,
  deepgram_timeout_ms: 30000,
}

let cache = { at: 0, value: null, degraded: false }
const TTL_MS = 4000

function defaultRuntimeSettings() {
  return { ...DEFAULTS, deepgram_api_key: null, anthropic_api_key: null }
}

function safeDecrypt(encrypted, fieldName) {
  if (!encrypted) return null
  try {
    return decryptString(encrypted, fieldName)
  } catch (err) {
    console.warn(`[aiSettings] Skipping ${fieldName}: ${err.message}`)
    return null
  }
}

function rowToRuntime(row) {
  if (!row) return defaultRuntimeSettings()

  const encryptedKey = row.deepgram_api_key_enc
  const key = safeDecrypt(encryptedKey, 'deepgram_api_key_enc')
  const anthropicKey = safeDecrypt(row.anthropic_api_key_enc, 'anthropic_api_key_enc')
  const model = String(row.anthropic_model || DEFAULTS.anthropic_model).trim()

  if (encryptedKey && !key) {
    console.warn('[aiSettings] Deepgram API key could not be decrypted — transcription will be unavailable until the key is re-entered in Settings')
  }
  if (row.anthropic_api_key_enc && !anthropicKey) {
    console.warn('[aiSettings] Anthropic API key could not be decrypted — AI note generation will use ANTHROPIC_API_KEY env var if set')
  }

  return {
    deepgram_enabled: !!row.deepgram_enabled,
    deepgram_api_key: key,
    deepgram_model: String(row.deepgram_model || DEFAULTS.deepgram_model).slice(0, 64),
    deepgram_language: String(row.deepgram_language || DEFAULTS.deepgram_language).slice(0, 32),
    deepgram_webhook_url: String(row.deepgram_webhook_url || '').trim().slice(0, 2000),
    deepgram_auto_transcribe_on_upload: !!row.deepgram_auto_transcribe_on_upload,
    anthropic_enabled: row.anthropic_enabled !== false,
    anthropic_api_key: anthropicKey,
    anthropic_model: ANTHROPIC_MODELS.has(model) ? model : DEFAULTS.anthropic_model,
    ffmpeg_enabled: !!row.ffmpeg_enabled,
    ffmpeg_target_format: ['wav', 'mp3', 'ogg', 'webm', 'flac'].includes(String(row.ffmpeg_target_format || '').toLowerCase())
      ? String(row.ffmpeg_target_format).toLowerCase()
      : 'mp3',
    ffmpeg_compression: Math.max(0, Math.min(9, Number(row.ffmpeg_compression) || DEFAULTS.ffmpeg_compression)),
    ffmpeg_max_upload_mb: Math.max(1, Math.min(500, Number(row.ffmpeg_max_upload_mb) || DEFAULTS.ffmpeg_max_upload_mb)),
    ffmpeg_preprocess_before_transcribe: row.ffmpeg_preprocess_before_transcribe !== false,
    deepgram_timeout_ms: Math.max(5000, Math.min(300000, Number(row.deepgram_timeout_ms) || DEFAULTS.deepgram_timeout_ms)),
  }
}

async function loadAiSettings() {
  const now = Date.now()
  if (cache.value && now - cache.at < TTL_MS) {
    return cache.value
  }

  try {
    await ensureMediaAndAiSchema()
    const cols = await getSystemSettingsColumns()
    const r = await pool.query('SELECT * FROM system_settings WHERE id = 1')
    const merged = mergeRowWithExtensions(r.rows[0] || {}, cols)
    const value = rowToRuntime(merged)
    cache = { at: now, value, degraded: false }
    return value
  } catch (err) {
    console.error('[aiSettings] Failed to load settings from database:', err.message)
    console.warn('[aiSettings] Continuing with default AI settings — API will remain available')
    const fallback = defaultRuntimeSettings()
    cache = { at: now, value: fallback, degraded: true }
    return fallback
  }
}

function invalidateAiSettingsCache() {
  cache.value = null
  cache.degraded = false
}

function useDeepgram(settings) {
  const enabled = settings?.deepgram_enabled
  const hasKey = settings?.deepgram_api_key
  const keyValid = hasKey && String(settings.deepgram_api_key).trim()
  return !!(enabled && hasKey && keyValid)
}

async function getAnthropicKey() {
  try {
    const settings = await loadAiSettings()
    return settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null
  } catch (err) {
    console.warn('[aiSettings] getAnthropicKey fallback:', err.message)
    return process.env.ANTHROPIC_API_KEY || null
  }
}

module.exports = {
  loadAiSettings,
  invalidateAiSettingsCache,
  useDeepgram,
  getAnthropicKey,
  defaultRuntimeSettings,
  DEFAULTS,
}
