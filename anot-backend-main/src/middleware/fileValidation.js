/**
 * Audio upload validation — MIME allow-list + magic-byte verification.
 */

const multer = require('multer')
const { getMaxUploadBytes } = require('../utils/ffmpegUploadLimits')

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

const MAX_FILE_SIZE = getMaxUploadBytes()

/** Strip codec params (`audio/webm;codecs=opus` → `audio/webm`). */
function normalizeMimeType(mimetype) {
  if (!mimetype || typeof mimetype !== 'string') { return '' }
  return mimetype.split(';')[0].trim().toLowerCase()
}

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
  const base = normalizeMimeType(mimetype)
  const signatures = AUDIO_SIGNATURES[base]
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
  const base = normalizeMimeType(file.mimetype)
  if (!ALLOWED_AUDIO_MIMES.includes(base)) {
    return cb(
      Object.assign(new Error(`Invalid file type: ${file.mimetype}.`), { status: 400 }),
      false,
    )
  }
  file.mimetype = base
  cb(null, true)
}

function validateUploadedFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded.' })
    }

    const { size, s3Key } = req.file
    if (size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB.` })
    }

    if (!s3Key) {
      return res.status(500).json({ error: 'Upload did not complete.' })
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
  normalizeMimeType,
}
