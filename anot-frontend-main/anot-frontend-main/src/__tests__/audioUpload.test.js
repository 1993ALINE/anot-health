import { describe, it, expect, vi } from 'vitest'
import {
  normalizeAudioMime,
  normalizeAudioBlob,
  extensionForMime,
  validateAudioBlobSize,
  formatUploadError,
  uploadWithRetry,
  UPLOAD_MAX_RETRIES,
} from '../utils/audioUpload'

describe('audioUpload helpers', () => {
  it('strips codec parameters from MIME types', () => {
    expect(normalizeAudioMime('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(normalizeAudioMime('audio/ogg;codecs=opus')).toBe('audio/ogg')
  })

  it('maps extensions from normalized MIME', () => {
    expect(extensionForMime('audio/webm')).toBe('webm')
    expect(extensionForMime('audio/ogg')).toBe('ogg')
  })

  it('re-wraps blobs with base MIME type', () => {
    const raw = new Blob(['x'], { type: 'audio/webm;codecs=opus' })
    const normalized = normalizeAudioBlob(raw)
    expect(normalized.type).toBe('audio/webm')
  })

  it('rejects empty blobs', () => {
    const result = validateAudioBlobSize(new Blob([]))
    expect(result.ok).toBe(false)
  })

  it('formats 413 upload errors', () => {
    const msg = formatUploadError({ status: 413, payload: { error: 'File too large' } })
    expect(msg).toContain('File too large')
  })

  it('retries transient failures up to UPLOAD_MAX_RETRIES', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('server'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('server'), { status: 503 }))
      .mockResolvedValueOnce({ ok: true })

    const result = await uploadWithRetry(fn, { delayMs: 1 })
    expect(result).toEqual({ ok: true })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry 400 client errors', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }))
    await expect(uploadWithRetry(fn, { delayMs: 1 })).rejects.toMatchObject({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('exports UPLOAD_MAX_RETRIES = 3', () => {
    expect(UPLOAD_MAX_RETRIES).toBe(3)
  })
})
