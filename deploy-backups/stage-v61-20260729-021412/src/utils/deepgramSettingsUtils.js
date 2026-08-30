const TRANSCRIBE_LANGUAGES = new Set(['en-US', 'en-GB', 'en-AU'])
const MAX_CUSTOM_VOCABULARY_TERMS = 100

function normalizeTranscribeLanguage(value, fallback = 'en-US') {
  const lang = String(value || '').trim()
  return TRANSCRIBE_LANGUAGES.has(lang) ? lang : fallback
}

function parseCustomVocabulary(raw) {
  if (Array.isArray(raw)) {
    return raw.map((term) => String(term || '').trim()).filter(Boolean).slice(0, MAX_CUSTOM_VOCABULARY_TERMS)
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parseCustomVocabulary(parsed)
    } catch {
      return raw.split(/[\n,]+/).map((term) => term.trim()).filter(Boolean).slice(0, MAX_CUSTOM_VOCABULARY_TERMS)
    }
  }
  if (raw && typeof raw === 'object') {
    return parseCustomVocabulary(Object.values(raw))
  }
  return []
}

module.exports = {
  TRANSCRIBE_LANGUAGES,
  MAX_CUSTOM_VOCABULARY_TERMS,
  normalizeTranscribeLanguage,
  parseCustomVocabulary,
}
