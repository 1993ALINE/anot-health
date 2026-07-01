const {
  getMimeTypeFromPath,
  calculateDeepgramTimeout,
  resolveDeepgramTimeoutMs,
} = require('../services/aiTranscriptionService')

describe('calculateDeepgramTimeout', () => {
  const originalEnv = process.env.DEEPGRAM_TIMEOUT_MS

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEEPGRAM_TIMEOUT_MS
    } else {
      process.env.DEEPGRAM_TIMEOUT_MS = originalEnv
    }
  })

  test('scales with file size (1 MB ≈ 166s)', () => {
    expect(calculateDeepgramTimeout(1)).toBe(166400)
  })

  test('scales with file size (5 MB ≈ 208s)', () => {
    expect(calculateDeepgramTimeout(5)).toBe(208000)
  })

  test('caps at 15 minutes for very large files', () => {
    expect(calculateDeepgramTimeout(500)).toBe(900000)
  })

  test('respects DEEPGRAM_TIMEOUT_MS env as a floor', () => {
    process.env.DEEPGRAM_TIMEOUT_MS = '900000'
    expect(calculateDeepgramTimeout(1)).toBe(900000)
  })
})

describe('resolveDeepgramTimeoutMs', () => {
  test('uses dynamic timeout for empty settings', () => {
    expect(resolveDeepgramTimeoutMs({}, 0)).toBe(156000)
    expect(resolveDeepgramTimeoutMs({}, 1024 * 1024)).toBe(166400)
  })

  test('honors settings.deepgram_timeout_ms as a floor', () => {
    const settings = { deepgram_timeout_ms: 120000 }
    expect(resolveDeepgramTimeoutMs(settings, 1024 * 1024)).toBe(166400)
    expect(resolveDeepgramTimeoutMs(settings, 0)).toBe(156000)
    const highFloor = { deepgram_timeout_ms: 300000 }
    expect(resolveDeepgramTimeoutMs(highFloor, 1024 * 1024)).toBe(300000)
  })

  test('scales up for large files', () => {
    const settings = { deepgram_timeout_ms: 30000 }
    expect(resolveDeepgramTimeoutMs(settings, 50 * 1024 * 1024)).toBe(676000)
    expect(resolveDeepgramTimeoutMs(settings, 500 * 1024 * 1024)).toBe(900000)
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
