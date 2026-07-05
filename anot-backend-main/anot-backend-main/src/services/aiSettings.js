const pool = require('../config/db')

const { decryptString } = require('../utils/settingsEncryption')

const { ensureMediaAndAiSchema } = require('../utils/ensureMediaSchema')

const { mergeRowWithExtensions } = require('../utils/settingsExtensions')

const { getSystemSettingsColumns } = require('../utils/settingsSchemaCompat')

const { resolveFfmpegMaxUploadMb } = require('../utils/ffmpegUploadLimits')

const { resolveDeepgramApiKey } = require('./deepgramService')
const {
  TRANSCRIBE_LANGUAGES,
  MAX_CUSTOM_VOCABULARY_TERMS,
  normalizeTranscribeLanguage,
  parseCustomVocabulary,
} = require('../utils/deepgramSettingsUtils')



const ANTHROPIC_MODELS = new Set(['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5'])
const DEEPGRAM_MODELS = new Set(['nova-3-medical', 'nova-3', 'nova-2'])

function normalizeDeepgramModel(value) {
  const model = String(value || '').trim()
  return DEEPGRAM_MODELS.has(model) ? model : DEFAULTS.deepgram_model
}



const DEFAULTS = {

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



let cache = { at: 0, value: null, degraded: false }

const TTL_MS = 4000



function defaultRuntimeSettings() {

  return { ...DEFAULTS, anthropic_api_key: null, deepgram_api_key: null }

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



/** Read transcription settings, falling back to legacy deepgram_* columns during migration. */

function readTranscribeSettings(row) {

  const hasTranscribeCol = row.transcribe_enabled != null || row.transcribe_language != null

  if (hasTranscribeCol) {

    return {

      transcribe_enabled: !!row.transcribe_enabled,

      transcribe_language: normalizeTranscribeLanguage(row.transcribe_language, DEFAULTS.transcribe_language),

      transcribe_medical_specialty: String(row.transcribe_medical_specialty || DEFAULTS.transcribe_medical_specialty).slice(0, 32),

      transcribe_show_speaker_labels: row.transcribe_show_speaker_labels !== false,

      transcribe_auto_transcribe_on_upload: row.transcribe_auto_transcribe_on_upload !== false,

      transcribe_timeout_ms: Math.max(

        5000,

        Math.min(1800000, Number(row.transcribe_timeout_ms) || DEFAULTS.transcribe_timeout_ms),

      ),

      deepgram_model: normalizeDeepgramModel(row.deepgram_model || process.env.DEEPGRAM_MODEL),

      deepgram_webhook_url: String(row.deepgram_webhook_url || process.env.DEEPGRAM_WEBHOOK_URL || '').slice(0, 2000),

      deepgram_profanity_filter: !!row.deepgram_profanity_filter,
      deepgram_punctuate: row.deepgram_punctuate !== false,
      deepgram_numerals: row.deepgram_numerals !== false,
      deepgram_redact_pii: !!row.deepgram_redact_pii,
      deepgram_remove_filler_words: row.deepgram_remove_filler_words !== false,
      deepgram_custom_vocabulary: parseCustomVocabulary(row.deepgram_custom_vocabulary),

    }

  }

  return {

    transcribe_enabled: !!row.deepgram_enabled,

    transcribe_language: normalizeTranscribeLanguage(row.deepgram_language, DEFAULTS.transcribe_language),

    transcribe_medical_specialty: DEFAULTS.transcribe_medical_specialty,

    transcribe_show_speaker_labels: true,

    transcribe_auto_transcribe_on_upload: row.deepgram_auto_transcribe_on_upload !== false,

    transcribe_timeout_ms: Math.max(

      5000,

        Math.min(1800000, Number(row.deepgram_timeout_ms) || DEFAULTS.transcribe_timeout_ms),

    ),

    deepgram_model: normalizeDeepgramModel(row.deepgram_model || process.env.DEEPGRAM_MODEL),

    deepgram_webhook_url: String(row.deepgram_webhook_url || process.env.DEEPGRAM_WEBHOOK_URL || '').slice(0, 2000),

    deepgram_profanity_filter: false,
    deepgram_punctuate: true,
    deepgram_numerals: true,
    deepgram_redact_pii: false,
    deepgram_remove_filler_words: true,
    deepgram_custom_vocabulary: [],

  }

}



function rowToRuntime(row) {

  if (!row) return defaultRuntimeSettings()



  const anthropicKey = safeDecrypt(row.anthropic_api_key_enc, 'anthropic_api_key_enc')

  const deepgramKey = safeDecrypt(row.deepgram_api_key_enc, 'deepgram_api_key_enc')

  const model = String(row.anthropic_model || DEFAULTS.anthropic_model).trim()



  if (row.anthropic_api_key_enc && !anthropicKey) {

    console.warn('[aiSettings] Anthropic API key could not be decrypted — AI note generation will use ANTHROPIC_API_KEY env var if set')

  }



  const transcribe = readTranscribeSettings(row)



  return {

    ...transcribe,

    deepgram_api_key: deepgramKey,

    anthropic_enabled: row.anthropic_enabled !== false,

    anthropic_api_key: anthropicKey,

    anthropic_model: ANTHROPIC_MODELS.has(model) ? model : DEFAULTS.anthropic_model,

    ffmpeg_enabled: !!row.ffmpeg_enabled,

    ffmpeg_target_format: ['wav', 'mp3', 'ogg', 'webm', 'flac'].includes(String(row.ffmpeg_target_format || '').toLowerCase())

      ? String(row.ffmpeg_target_format).toLowerCase()

      : 'mp3',

    ffmpeg_compression: Math.max(0, Math.min(9, Number(row.ffmpeg_compression) || DEFAULTS.ffmpeg_compression)),

    ffmpeg_max_upload_mb: resolveFfmpegMaxUploadMb(row.ffmpeg_max_upload_mb ?? DEFAULTS.ffmpeg_max_upload_mb),

    ffmpeg_preprocess_before_transcribe: row.ffmpeg_preprocess_before_transcribe !== false,

    deepgram_profanity_filter: transcribe.deepgram_profanity_filter,
    deepgram_punctuate: transcribe.deepgram_punctuate,
    deepgram_numerals: transcribe.deepgram_numerals,
    deepgram_redact_pii: transcribe.deepgram_redact_pii,
    deepgram_remove_filler_words: transcribe.deepgram_remove_filler_words,
    deepgram_custom_vocabulary: transcribe.deepgram_custom_vocabulary,

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

  const apiKey = resolveDeepgramApiKey(settings)

  if (!apiKey) {

    console.warn('[aiSettings] useDeepgram=false — DEEPGRAM_API_KEY not configured')

    return false

  }

  if (settings?.transcribe_enabled) return true

  if (String(process.env.USE_DEEPGRAM || '').toLowerCase() === 'true') return true

  console.warn('[aiSettings] useDeepgram=false — transcribe_enabled is off in Admin Settings (set USE_DEEPGRAM=true or enable in Admin → Settings)')

  return false

}



/** @deprecated Use useDeepgram */

const useTranscribe = useDeepgram



async function getAnthropicKey() {

  try {

    const settings = await loadAiSettings()

    return settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null

  } catch (err) {

    console.warn('[aiSettings] getAnthropicKey fallback:', err.message)

    return process.env.ANTHROPIC_API_KEY || null

  }

}



async function getDeepgramKey() {

  try {

    const settings = await loadAiSettings()

    return resolveDeepgramApiKey(settings)

  } catch (err) {

    console.warn('[aiSettings] getDeepgramKey fallback:', err.message)

    return process.env.DEEPGRAM_API_KEY || null

  }

}



module.exports = {

  loadAiSettings,

  invalidateAiSettingsCache,

  useDeepgram,

  useTranscribe,

  getAnthropicKey,

  getDeepgramKey,

  defaultRuntimeSettings,

  DEFAULTS,
  DEEPGRAM_MODELS,
  TRANSCRIBE_LANGUAGES,
  MAX_CUSTOM_VOCABULARY_TERMS,
  normalizeDeepgramModel,
  normalizeTranscribeLanguage,
  parseCustomVocabulary,

}

