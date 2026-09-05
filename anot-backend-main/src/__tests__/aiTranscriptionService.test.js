const {
  getMimeTypeFromPath,
  calculateTranscribeTimeout,
  resolveTranscribeTimeoutMs,
} = require('../services/aiTranscriptionService')
const { parseDeepgramOutput } = require('../services/deepgramService')

describe('calculateTranscribeTimeout', () => {
  const originalDeepgramEnv = process.env.DEEPGRAM_TIMEOUT_MS
  const originalTranscribeEnv = process.env.TRANSCRIBE_TIMEOUT_MS

  beforeEach(() => {
    delete process.env.DEEPGRAM_TIMEOUT_MS
    delete process.env.TRANSCRIBE_TIMEOUT_MS
  })

  afterAll(() => {
    if (originalDeepgramEnv === undefined) {
      delete process.env.DEEPGRAM_TIMEOUT_MS
    } else {
      process.env.DEEPGRAM_TIMEOUT_MS = originalDeepgramEnv
    }
    if (originalTranscribeEnv === undefined) {
      delete process.env.TRANSCRIBE_TIMEOUT_MS
    } else {
      process.env.TRANSCRIBE_TIMEOUT_MS = originalTranscribeEnv
    }
  })

  test('scales with file size (1 MB ≈ 173s)', () => {
    expect(calculateTranscribeTimeout(1)).toBe(169000)
  })

  test('scales with file size (5 MB ≈ 221s)', () => {
    expect(calculateTranscribeTimeout(5)).toBe(221000)
  })

  test('caps at 30 minutes for very large files', () => {
    expect(calculateTranscribeTimeout(500)).toBe(1800000)
  })

  test('respects DEEPGRAM_TIMEOUT_MS env as a floor', () => {
    process.env.DEEPGRAM_TIMEOUT_MS = '1800000'
    expect(calculateTranscribeTimeout(1)).toBe(1800000)
  })
})

describe('resolveTranscribeTimeoutMs', () => {
  beforeEach(() => {
    delete process.env.DEEPGRAM_TIMEOUT_MS
    delete process.env.TRANSCRIBE_TIMEOUT_MS
  })

  test('uses dynamic timeout for empty settings', () => {
    expect(resolveTranscribeTimeoutMs({}, 0)).toBe(156000)
    expect(resolveTranscribeTimeoutMs({}, 1024 * 1024)).toBe(169000)
  })

  test('honors settings.transcribe_timeout_ms as a floor', () => {
    const settings = { transcribe_timeout_ms: 120000 }
    expect(resolveTranscribeTimeoutMs(settings, 1024 * 1024)).toBe(169000)
    expect(resolveTranscribeTimeoutMs(settings, 0)).toBe(156000)
    const highFloor = { transcribe_timeout_ms: 300000 }
    expect(resolveTranscribeTimeoutMs(highFloor, 1024 * 1024)).toBe(300000)
  })

  test('scales up for large files', () => {
    const settings = { transcribe_timeout_ms: 30000 }
    expect(resolveTranscribeTimeoutMs(settings, 50 * 1024 * 1024)).toBe(806000)
    expect(resolveTranscribeTimeoutMs(settings, 500 * 1024 * 1024)).toBe(1800000)
  })
})

describe('getMimeTypeFromPath', () => {
  test('maps upload extensions used by the audio route', () => {
    expect(getMimeTypeFromPath('/tmp/visit_81_123.mp4')).toBe('audio/mp4')
    expect(getMimeTypeFromPath('/tmp/recording.webm')).toBe('audio/webm')
    expect(getMimeTypeFromPath('/tmp/recording.ogg')).toBe('audio/ogg')
  })

  test('returns null for unknown extensions', () => {
    expect(getMimeTypeFromPath('/tmp/file.xyz')).toBeNull()
  })
})

describe('parseDeepgramOutput', () => {
  test('extracts transcript from Deepgram JSON', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ transcript: 'Patient reports chest pain.' }] }],
      },
    }
    expect(parseDeepgramOutput(body)).toBe('Patient reports chest pain.')
  })

  test('returns null for empty payload', () => {
    expect(parseDeepgramOutput(null)).toBeNull()
    expect(parseDeepgramOutput({ results: { channels: [{ alternatives: [{ transcript: '  ' }] }] } })).toBeNull()
  })
})
