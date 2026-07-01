'use strict'

const {
  resolveFfmpegMaxUploadMb,
  getEnvFfmpegMaxUploadMb,
  getMaxUploadBytes,
  DEFAULT_FFMPEG_MAX_UPLOAD_MB,
  clampMb,
} = require('../utils/ffmpegUploadLimits')

describe('ffmpegUploadLimits', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.FFMPEG_MAX_UPLOAD_MB
  })

  afterAll(() => {
    process.env = originalEnv
  })

  test('DEFAULT_FFMPEG_MAX_UPLOAD_MB is 500', () => {
    expect(DEFAULT_FFMPEG_MAX_UPLOAD_MB).toBe(500)
  })

  test('resolveFfmpegMaxUploadMb uses env when set', () => {
    process.env.FFMPEG_MAX_UPLOAD_MB = '450'
    expect(resolveFfmpegMaxUploadMb(100)).toBe(450)
  })

  test('resolveFfmpegMaxUploadMb falls back to DB when env unset', () => {
    expect(resolveFfmpegMaxUploadMb(200)).toBe(200)
  })

  test('resolveFfmpegMaxUploadMb defaults to 500 when env and DB unset', () => {
    expect(resolveFfmpegMaxUploadMb(undefined)).toBe(500)
    expect(resolveFfmpegMaxUploadMb(null)).toBe(500)
  })

  test('getEnvFfmpegMaxUploadMb rejects invalid values', () => {
    process.env.FFMPEG_MAX_UPLOAD_MB = 'not-a-number'
    expect(getEnvFfmpegMaxUploadMb()).toBeNull()
  })

  test('clampMb enforces 1–500 range', () => {
    expect(clampMb(0)).toBe(1)
    expect(clampMb(999)).toBe(500)
  })

  test('getMaxUploadBytes reflects env override', () => {
    process.env.FFMPEG_MAX_UPLOAD_MB = '500'
    expect(getMaxUploadBytes()).toBe(500 * 1024 * 1024)
  })
})
