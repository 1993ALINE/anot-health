/**
 * Audio upload validation — MIME allow-list + magic-byte verification.
 */

const multer = require('multer')

const ALLOWED_AUDIO_MIMES = [
  'audio/webm',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/x-m4a',
  'audio/flac',
  'audio/opus',
]

const MAX_FILE_SIZE = 500 * 1024 * 1024

const AUDIO_SIGNATURES = {
  'audio/webm': [[0x1a, 0x45, 0xdf, 0xa3]],
  'audio/wav': [[0x52, 0x49, 0x46, 0x46]],
  'audio/wave': [[0x52, 0x49, 0x46, 0x46]],
  'audio/x-wav': [[0x52, 0x49, 0x46, 0x46]],
  'audio/mp4': [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70]],
  'audio/x-m4a': [[0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70]],
  'audio/mpeg': [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x49, 0x44, 0x33]],
  'audio/mp3': [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x49, 0x44, 0x33]],
  'audio/ogg': [[0x4f, 0x67, 0x67, 0x53]],
  'audio/flac': [[0x66, 0x4c, 0x61, 0x43]],
  'audio/opus': [[0x4f, 0x67, 0x67, 0x53]],
}

function verifyFileSignature(buffer, mimetype) {
  const signatures = AUDIO_SIGNATURES[mimetype]
  if (!signatures || !buffer || buffer.length < 4) {
    return false
  }
  return signatures.some((signature) =>
    signature.every((byte, index) => {
      if (byte === null) { return true }
      return buffer[index] === byte
    }),
  )
}

function audioFileFilter(req, file, cb) {
  if (!ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
    return cb(
      Object.assign(new Error(`Invalid file type: ${file.mimetype}.`), { status: 400 }),
      false,
    )
  }
  cb(null, true)
}

function validateUploadedFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' })
    }

    const { buffer, mimetype, size } = req.file
    if (size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB.` })
    }

    if (!verifyFileSignature(buffer, mimetype)) {
      return res.status(400).json({
        error: 'File signature does not match MIME type. Possible corruption or spoofing.',
      })
    }

    req.fileValidated = true
    next()
  } catch (err) {
    console.error('[fileValidation]', err.message)
    res.status(500).json({ error: 'File validation failed.' })
  }
}

function createSecureUpload(storage) {
  return multer({
    storage,
    fileFilter: audioFileFilter,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  })
}

module.exports = {
  audioFileFilter,
  validateUploadedFile,
  createSecureUpload,
  ALLOWED_AUDIO_MIMES,
  MAX_FILE_SIZE,
  verifyFileSignature,
}
