const { getMimeTypeFromPath } = require('../services/aiTranscriptionService')

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
