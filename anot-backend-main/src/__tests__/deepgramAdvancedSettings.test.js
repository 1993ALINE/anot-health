const {
  normalizeTranscribeLanguage,
  parseCustomVocabulary,
  TRANSCRIBE_LANGUAGES,
} = require('../utils/deepgramSettingsUtils')
const { buildListenOptions, buildBaselineListenOptions } = require('../services/deepgramService')

describe('deepgramSettingsUtils', () => {
  test('normalizeTranscribeLanguage accepts supported locales', () => {
    for (const lang of TRANSCRIBE_LANGUAGES) {
      expect(normalizeTranscribeLanguage(lang)).toBe(lang)
    }
  })

  test('normalizeTranscribeLanguage falls back for unknown locales', () => {
    expect(normalizeTranscribeLanguage('fr-FR')).toBe('en-US')
    expect(normalizeTranscribeLanguage('', 'en-GB')).toBe('en-GB')
  })

  test('parseCustomVocabulary splits newline and comma lists', () => {
    expect(parseCustomVocabulary('Dr. Smith\nSunrise Clinic, TAVR')).toEqual([
      'Dr. Smith',
      'Sunrise Clinic',
      'TAVR',
    ])
  })
})

describe('buildListenOptions', () => {
  const baseSettings = {
    transcribe_language: 'en-US',
    deepgram_model: 'nova-3-medical',
    transcribe_show_speaker_labels: true,
    deepgram_punctuate: true,
    deepgram_numerals: true,
    deepgram_remove_filler_words: true,
    deepgram_profanity_filter: false,
    deepgram_redact_pii: true,
    deepgram_custom_vocabulary: ['Dr. Smith', 'Sunrise Clinic'],
  }

  test('maps advanced settings to Deepgram listen options', () => {
    const opts = buildListenOptions(baseSettings, null)
    expect(opts.model).toBe('nova-3-medical')
    expect(opts.language).toBe('en-US')
    expect(opts.diarize).toBe(true)
    expect(opts.punctuate).toBe(true)
    expect(opts.numerals).toBe(true)
    expect(opts.filler_words).toBe(false)
    expect(opts.profanity_filter).toBe(false)
    expect(opts.redact).toEqual(['pii'])
    expect(opts.keyterm).toEqual(['Dr. Smith', 'Sunrise Clinic'])
  })

  test('buildBaselineListenOptions strips boosting features', () => {
    const opts = buildBaselineListenOptions(baseSettings, null)
    expect(opts.diarize).toBe(false)
    expect(opts.keyterm).toBeUndefined()
    expect(opts.redact).toBeUndefined()
    expect(opts.punctuate).toBe(false)
  })
})
