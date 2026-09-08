const {
  useDeepgram,
  defaultRuntimeSettings,
  normalizeDeepgramModel,
  DEEPGRAM_MODELS,
  resolveCanonicalAnthropicModel,
  ANTHROPIC_MODELS,
} = require('../services/aiSettings')

describe('useDeepgram', () => {
  const savedApiKey = process.env.DEEPGRAM_API_KEY
  const savedUseDeepgram = process.env.USE_DEEPGRAM

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.DEEPGRAM_API_KEY
    else process.env.DEEPGRAM_API_KEY = savedApiKey
    if (savedUseDeepgram === undefined) delete process.env.USE_DEEPGRAM
    else process.env.USE_DEEPGRAM = savedUseDeepgram
  })

  test('returns true when transcribe_enabled in settings and API key set', () => {
    process.env.DEEPGRAM_API_KEY = 'test-key'
    expect(useDeepgram({ transcribe_enabled: true })).toBe(true)
  })

  test('returns true when USE_DEEPGRAM=true even if DB setting off', () => {
    process.env.DEEPGRAM_API_KEY = 'test-key'
    process.env.USE_DEEPGRAM = 'true'
    expect(useDeepgram(defaultRuntimeSettings())).toBe(true)
  })

  test('returns false when API key missing', () => {
    delete process.env.DEEPGRAM_API_KEY
    process.env.USE_DEEPGRAM = 'true'
    expect(useDeepgram(defaultRuntimeSettings())).toBe(false)
  })

  test('returns false when transcribe disabled and no env override', () => {
    process.env.DEEPGRAM_API_KEY = 'test-key'
    delete process.env.USE_DEEPGRAM
    expect(useDeepgram(defaultRuntimeSettings())).toBe(false)
  })
})

describe('normalizeDeepgramModel', () => {
  test('accepts allowed models', () => {
    for (const model of DEEPGRAM_MODELS) {
      expect(normalizeDeepgramModel(model)).toBe(model)
    }
  })

  test('falls back to nova-3-medical for unknown models', () => {
    expect(normalizeDeepgramModel('invalid-model')).toBe('nova-3-medical')
    expect(normalizeDeepgramModel('')).toBe('nova-3-medical')
  })
})

describe('resolveCanonicalAnthropicModel', () => {
  test('maps retired Claude 3.5 Haiku to Claude Haiku 4.5', () => {
    expect(resolveCanonicalAnthropicModel('claude-3-5-haiku-20241022')).toBe('claude-haiku-4-5-20251001')
    expect(resolveCanonicalAnthropicModel('claude-3-5-haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveCanonicalAnthropicModel('claude-3-haiku-20240307')).toBe('claude-haiku-4-5-20251001')
  })

  test('resolves claude-haiku-4-5 alias to canonical claude-haiku-4-5-20251001', () => {
    expect(resolveCanonicalAnthropicModel('claude-haiku-4-5')).toBe('claude-haiku-4-5-20251001')
    expect(resolveCanonicalAnthropicModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })

  test('resolves legacy Sonnet models to claude-sonnet-4-6', () => {
    expect(resolveCanonicalAnthropicModel('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6')
    expect(resolveCanonicalAnthropicModel('claude-3-7-sonnet-20250219')).toBe('claude-sonnet-4-6')
  })

  test('falls back to claude-sonnet-4-6 for empty or missing model', () => {
    expect(resolveCanonicalAnthropicModel('')).toBe('claude-sonnet-4-6')
    expect(resolveCanonicalAnthropicModel(null)).toBe('claude-sonnet-4-6')
    expect(resolveCanonicalAnthropicModel(undefined)).toBe('claude-sonnet-4-6')
  })
})

describe('ANTHROPIC_MODELS set', () => {
  test('contains modern Claude models and valid aliases', () => {
    expect(ANTHROPIC_MODELS.has('claude-haiku-4-5-20251001')).toBe(true)
    expect(ANTHROPIC_MODELS.has('claude-haiku-4-5')).toBe(true)
    expect(ANTHROPIC_MODELS.has('claude-sonnet-4-6')).toBe(true)
    expect(ANTHROPIC_MODELS.has('claude-opus-4-6')).toBe(true)
  })

  test('retains legacy keys so existing database records can be resolved', () => {
    expect(ANTHROPIC_MODELS.has('claude-3-5-haiku-20241022')).toBe(true)
    expect(ANTHROPIC_MODELS.has('claude-3-5-sonnet-20241022')).toBe(true)
  })
})

