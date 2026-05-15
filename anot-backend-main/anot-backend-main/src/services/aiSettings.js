const pool = require('../config/db')
const { decryptString } = require('../utils/settingsEncryption')
const { ensureMediaAndAiSchema } = require('../utils/ensureMediaSchema')
const { mergeRowWithExtensions } = require('../utils/settingsExtensions')
const { getSystemSettingsColumns } = require('../utils/settingsSchemaCompat')

const DEFAULTS = {
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

let cache = { at: 0, value: null }
const TTL_MS = 4000

function rowToRuntime(row) {
  if (!row) return { ...DEFAULTS, deepgram_api_key: null }
  const key = row.deepgram_api_key_enc ? decryptString(row.deepgram_api_key_enc) : null
  return {
    deepgram_enabled: !!row.deepgram_enabled,
    deepgram_api_key: key,
    deepgram_model: String(row.deepgram_model || DEFAULTS.deepgram_model).slice(0, 64),
    deepgram_language: String(row.deepgram_language || DEFAULTS.deepgram_language).slice(0, 32),
    deepgram_webhook_url: String(row.deepgram_webhook_url || '').trim().slice(0, 2000),
    deepgram_auto_transcribe_on_upload: !!row.deepgram_auto_transcribe_on_upload,
    ffmpeg_enabled: !!row.ffmpeg_enabled,
    ffmpeg_target_format: ['wav', 'mp3'].includes(String(row.ffmpeg_target_format || '').toLowerCase())
      ? String(row.ffmpeg_target_format).toLowerCase()
      : 'mp3',
    ffmpeg_compression: Math.max(0, Math.min(9, Number(row.ffmpeg_compression) || DEFAULTS.ffmpeg_compression)),
    ffmpeg_max_upload_mb: Math.max(1, Math.min(500, Number(row.ffmpeg_max_upload_mb) || DEFAULTS.ffmpeg_max_upload_mb)),
    ffmpeg_preprocess_before_transcribe: row.ffmpeg_preprocess_before_transcribe !== false,
  }
}

async function loadAiSettings() {
  const now = Date.now()
  if (cache.value && now - cache.at < TTL_MS) return cache.value
  await ensureMediaAndAiSchema()
  const cols = await getSystemSettingsColumns()
  const r = await pool.query('SELECT * FROM system_settings WHERE id = 1')
  const merged = mergeRowWithExtensions(r.rows[0] || {}, cols)
  const value = rowToRuntime(merged)
  cache = { at: now, value }
  return value
}

function invalidateAiSettingsCache() {
  cache.value = null
}

function useDeepgram(settings) {
  return !!(settings?.deepgram_enabled && settings?.deepgram_api_key && String(settings.deepgram_api_key).trim())
}

module.exports = {
  loadAiSettings,
  invalidateAiSettingsCache,
  useDeepgram,
  DEFAULTS,
}
