const { Readable } = require('stream')
const { verifyFileSignature, ALLOWED_AUDIO_MIMES, MAX_FILE_SIZE, audioFileFilter } = require('../middleware/fileValidation')
const { prepareValidatedStream } = require('../middleware/s3StreamUpload')

describe('fileValidation', () => {
  test('verifyFileSignature detects valid WebM header', () => {
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])
    expect(verifyFileSignature(webmHeader, 'audio/webm')).toBe(true)
  })

  test('verifyFileSignature rejects mismatched MIME', () => {
    const wavHeader = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])
    expect(verifyFileSignature(wavHeader, 'audio/webm')).toBe(false)
  })

  test('ALLOWED_AUDIO_MIMES includes common clinical formats', () => {
    expect(ALLOWED_AUDIO_MIMES).toEqual(expect.arrayContaining(['audio/webm', 'audio/wav', 'audio/mp4']))
  })

  test('MAX_FILE_SIZE matches getMaxUploadBytes()', () => {
    const { getMaxUploadBytes } = require('../utils/ffmpegUploadLimits')
    expect(MAX_FILE_SIZE).toBe(getMaxUploadBytes())
  })

  test('audioFileFilter rejects disallowed MIME types', (done) => {
    audioFileFilter({}, { mimetype: 'application/pdf' }, (err, ok) => {
      expect(ok).toBe(false)
      expect(err.status).toBe(400)
      done()
    })
  })

  test('audioFileFilter accepts allowed MIME types', (done) => {
    audioFileFilter({}, { mimetype: 'audio/webm' }, (err, ok) => {
      expect(err).toBeNull()
      expect(ok).toBe(true)
      done()
    })
  })

  test('audioFileFilter accepts MediaRecorder MIME with codec params', (done) => {
    const file = { mimetype: 'audio/webm;codecs=opus' }
    audioFileFilter({}, file, (err, ok) => {
      expect(err).toBeNull()
      expect(ok).toBe(true)
      expect(file.mimetype).toBe('audio/webm')
      done()
    })
  })

  test('verifyFileSignature accepts codec-qualified MIME', () => {
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])
    expect(verifyFileSignature(webmHeader, 'audio/webm;codecs=opus')).toBe(true)
  })
})

describe('s3StreamUpload prepareValidatedStream', () => {
  test('streams valid WebM without buffering entire payload', async () => {
    const payload = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(1024, 0xab),
    ])
    const source = Readable.from([payload])
    const { stream, sizePromise } = prepareValidatedStream(source, 'audio/webm', MAX_FILE_SIZE)

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    const total = Buffer.concat(chunks).length
    expect(total).toBe(payload.length)
    await expect(sizePromise).resolves.toBe(payload.length)
  })

  test('rejects invalid signature during streaming', async () => {
    const bad = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    const source = Readable.from([bad])
    const { stream, sizePromise } = prepareValidatedStream(source, 'audio/webm', MAX_FILE_SIZE)

    stream.on('error', () => {})
    source.on('error', () => {})

    await expect(sizePromise).rejects.toMatchObject({ status: 400 })
  })
})
