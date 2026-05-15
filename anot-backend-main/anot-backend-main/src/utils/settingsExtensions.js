/** Stored in social_links JSON when dedicated system_settings columns are missing (local dev). */
const ADMIN_META_KEY = '__admin_meta'

const EXTENSION_FIELD_KEYS = [
  'audit_retention_days',
  'deepgram_enabled',
  'deepgram_api_key_enc',
  'deepgram_model',
  'deepgram_language',
  'deepgram_webhook_url',
  'deepgram_auto_transcribe_on_upload',
  'ffmpeg_enabled',
  'ffmpeg_target_format',
  'ffmpeg_compression',
  'ffmpeg_max_upload_mb',
  'ffmpeg_preprocess_before_transcribe',
]

function parseSocialLinks(raw) {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? { ...raw } : {}
}

/** Public/footer: strip internal meta bucket. */
function publicSocialLinks(raw) {
  const social = parseSocialLinks(raw)
  delete social[ADMIN_META_KEY]
  return social
}

function readAdminMeta(raw) {
  const social = parseSocialLinks(raw)
  const meta = social[ADMIN_META_KEY]
  return meta && typeof meta === 'object' ? { ...meta } : {}
}

/** Merge dedicated columns with JSON fallback for admin reads. */
function mergeRowWithExtensions(row, columnSet) {
  const meta = readAdminMeta(row?.social_links)
  const merged = { ...row }
  for (const key of EXTENSION_FIELD_KEYS) {
    if (columnSet && columnSet.has(key)) continue
    if (meta[key] !== undefined && meta[key] !== null) {
      merged[key] = meta[key]
    }
  }
  return merged
}

/**
 * Build social_links for UPDATE: user URLs + optional __admin_meta for fields with no DB column.
 */
function packSocialLinksForSave(userSocial, extensionValues, columnSet) {
  const social = { ...userSocial }
  delete social[ADMIN_META_KEY]

  const meta = {}
  for (const key of EXTENSION_FIELD_KEYS) {
    if (columnSet.has(key)) continue
    if (extensionValues[key] !== undefined) {
      meta[key] = extensionValues[key]
    }
  }

  if (Object.keys(meta).length > 0) {
    social[ADMIN_META_KEY] = meta
  }

  return social
}

module.exports = {
  ADMIN_META_KEY,
  EXTENSION_FIELD_KEYS,
  publicSocialLinks,
  readAdminMeta,
  mergeRowWithExtensions,
  packSocialLinksForSave,
  parseSocialLinks,
}
