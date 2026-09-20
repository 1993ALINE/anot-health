const { EventEmitter } = require('events')

// Mock child_process.spawn so this runs without a real ffprobe binary on the
// test machine — we control exactly what "ffprobe" reports for before/after
// duration and assert the computed savings percentage.
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

const { spawn } = require('child_process')
const { getAudioDurationSeconds, logDurationSavings } = require('../services/audioProcessingService')

function makeFakeProcess({ stdout = '', exitCode = 0, errorOnSpawn = null }) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  process.nextTick(() => {
    if (errorOnSpawn) {
      proc.emit('error', errorOnSpawn)
      return
    }
    if (stdout) proc.stdout.emit('data', stdout)
    proc.emit('close', exitCode)
  })
  return proc
}

describe('getAudioDurationSeconds', () => {
  beforeEach(() => {
    spawn.mockReset()
  })

  test('parses a valid ffprobe duration output', async () => {
    spawn.mockReturnValue(makeFakeProcess({ stdout: '125.430000\n', exitCode: 0 }))
    const seconds = await getAudioDurationSeconds('/tmp/audio.wav')
    expect(seconds).toBeCloseTo(125.43, 2)
  })

  test('returns null when ffprobe exits non-zero', async () => {
    spawn.mockReturnValue(makeFakeProcess({ stdout: '', exitCode: 1 }))
    const seconds = await getAudioDurationSeconds('/tmp/bad.wav')
    expect(seconds).toBeNull()
  })

  test('returns null when ffprobe is not installed', async () => {
    spawn.mockReturnValue(makeFakeProcess({ errorOnSpawn: new Error('ENOENT') }))
    const seconds = await getAudioDurationSeconds('/tmp/audio.wav')
    expect(seconds).toBeNull()
  })

  test('returns null on unparseable output', async () => {
    spawn.mockReturnValue(makeFakeProcess({ stdout: 'N/A\n', exitCode: 0 }))
    const seconds = await getAudioDurationSeconds('/tmp/audio.wav')
    expect(seconds).toBeNull()
  })
})

describe('logDurationSavings', () => {
  let consoleLogSpy

  beforeEach(() => {
    spawn.mockReset()
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  test('logs the real measured savings percentage — this is the ground-truth number to confirm FFmpeg is actually helping', async () => {
    // Simulate a 20-minute (1200s) original recording reduced to 14 minutes (840s)
    // after silence-stripping — a real 30% reduction.
    spawn
      .mockReturnValueOnce(makeFakeProcess({ stdout: '1200.0\n', exitCode: 0 })) // original
      .mockReturnValueOnce(makeFakeProcess({ stdout: '840.0\n', exitCode: 0 }))  // processed

    await logDurationSavings('/tmp/original.wav', '/tmp/processed.mp3')

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[audioProcessing\]\[SAVINGS\].*before=1200\.0s.*after=840\.0s.*saved=30\.0%/)
    )
  })

  test('logs nothing (never throws) when duration cannot be measured on either side', async () => {
    spawn.mockReturnValue(makeFakeProcess({ errorOnSpawn: new Error('ENOENT') }))

    await expect(logDurationSavings('/tmp/original.wav', '/tmp/processed.mp3')).resolves.toBeUndefined()
    expect(consoleLogSpy).not.toHaveBeenCalled()
  })
})
