const { useDeepgram, defaultRuntimeSettings, normalizeDeepgramModel, DEEPGRAM_MODELS } = require('../services/aiSettings')



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

