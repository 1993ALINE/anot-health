jest.mock('../services/aiTranscriptionService', () => ({
  transcribeFile: jest.fn(),
}))
jest.mock('../services/audioProcessingService', () => ({
  processAudioForTranscription: jest.fn(),
  unlinkTempPaths: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../services/s3Storage', () => ({
  downloadAudioToTemp: jest.fn(),
  dbPathToKey: jest.fn((p) => p),
}))

const { transcribeFile } = require('../services/aiTranscriptionService')
const { transcribeAllAudioFiles } = require('../utils/aiPipelineHelpers')

describe('transcribeAllAudioFiles concurrency', () => {
  test('transcribes multiple segments in parallel, not one at a time', async () => {
    const DELAY_MS = 150

    transcribeFile.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('some transcript text'), DELAY_MS))
    )

    const audioFiles = ['a.wav', 'b.wav', 'c.wav']
    const settings = { ffmpeg_enabled: false, ffmpeg_preprocess_before_transcribe: false }

    const start = Date.now()
    const { transcriptions, successCount } = await transcribeAllAudioFiles(audioFiles, settings, 1)
    const elapsed = Date.now() - start

    expect(successCount).toBe(3)
    expect(transcriptions).toHaveLength(3)
    // If these ran sequentially, elapsed would be ~3 * DELAY_MS (450ms+). Running
    // concurrently, it should stay close to a single DELAY_MS regardless of segment count.
    expect(elapsed).toBeLessThan(DELAY_MS * 2)
  })

  test('preserves per-segment order even when they resolve out of order', async () => {
    const order = ['first.wav', 'second.wav', 'third.wav']
    const delays = { 'first.wav': 60, 'second.wav': 10, 'third.wav': 30 }

    transcribeFile.mockImplementation((_path, _settings, _visitId, opts) => {
      const key = opts?.s3Path?.replace('/uploads/', '') || _path
      return new Promise((resolve) => setTimeout(() => resolve(`text for ${key}`), delays[key] || 0))
    })

    const settings = { ffmpeg_enabled: false, ffmpeg_preprocess_before_transcribe: false }
    const { transcriptions } = await transcribeAllAudioFiles(order, settings, 1)

    expect(transcriptions).toEqual([
      'text for first.wav',
      'text for second.wav',
      'text for third.wav',
    ])
  })
})
