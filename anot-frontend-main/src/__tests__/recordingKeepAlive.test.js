import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  acquireWakeLock,
  releaseWakeLock,
  startAudioKeepAlive,
  stopAudioKeepAlive,
  startRecordingKeepAlive,
  stopRecordingKeepAlive,
} from '../utils/recordingKeepAlive'

describe('recordingKeepAlive', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('safely handles missing wakeLock in older browsers without throwing', async () => {
    await expect(acquireWakeLock()).resolves.toBeUndefined()
    await expect(releaseWakeLock()).resolves.toBeUndefined()
  })

  it('requests wakeLock when supported by navigator', async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined)
    const mockRequest = vi.fn().mockResolvedValue({
      released: false,
      release: mockRelease,
      addEventListener: vi.fn(),
    })

    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: mockRequest },
      configurable: true,
      writable: true,
    })

    await acquireWakeLock()
    expect(mockRequest).toHaveBeenCalledWith('screen')

    await releaseWakeLock()
    expect(mockRelease).toHaveBeenCalled()
  })

  it('starts and stops recording keep-alive bundle cleanly', async () => {
    await expect(startRecordingKeepAlive(null)).resolves.toBeUndefined()
    await expect(stopRecordingKeepAlive()).resolves.toBeUndefined()
  })
})
