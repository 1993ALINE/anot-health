/**
 * Multer storage engine — streams audio uploads directly to S3 (no RAM buffer).
 * Validates magic bytes on the first chunk and enforces a byte limit during streaming.
 */

const { PassThrough, Transform } = require('stream')
const { verifyFileSignature, MAX_FILE_SIZE } = require('./fileValidation')
const { uploadAudioStream, deleteAudio } = require('../services/s3Storage')

const SIGNATURE_PEEK_BYTES = 12

function createByteLimitedStream(maxBytes) {
  let total = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length
      if (total > maxBytes) {
        cb(Object.assign(
          new Error(`File too large. Maximum size: ${Math.round(maxBytes / (1024 * 1024))}MB.`),
          { status: 413 },
        ))
        return
      }
      cb(null, chunk)
    },
    flush(cb) {
      this.bytesWritten = total
      cb()
    },
  })
}

/**
 * Peek the first bytes of a stream, validate signature, then pipe the remainder.
 * @returns {{ stream: import('stream').Transform, sizePromise: Promise<number> }}
 */
function prepareValidatedStream(source, mimetype, maxBytes) {
  const limiter = createByteLimitedStream(maxBytes)
  const pass = new PassThrough()
  let header = Buffer.alloc(0)
  let validated = false
  let totalSize = 0

  const sizePromise = new Promise((resolve, reject) => {
    source.on('data', (chunk) => {
      if (validated) {
        totalSize += chunk.length
        pass.write(chunk)
        return
      }

      header = Buffer.concat([header, chunk])
      if (header.length < SIGNATURE_PEEK_BYTES) {
        return
      }

      if (!verifyFileSignature(header.slice(0, SIGNATURE_PEEK_BYTES), mimetype)) {
        const err = Object.assign(
          new Error('File signature does not match MIME type. Possible corruption or spoofing.'),
          { status: 400 },
        )
        source.destroy()
        reject(err)
        return
      }

      validated = true
      totalSize += header.length
      pass.write(header)
      header = null
    })

    source.on('end', () => {
      if (!validated) {
        reject(Object.assign(new Error('Upload incomplete or file too small.'), { status: 400 }))
        return
      }
      pass.end()
    })

    source.on('error', (err) => {
      reject(err)
    })

    pass.pipe(limiter)

    limiter.on('finish', () => resolve(totalSize))
    limiter.on('error', reject)
  })

  return { stream: limiter, sizePromise }
}

/**
 * @param {(req: import('express').Request, file: object) => Promise<{ key: string, maxBytes?: number }>} resolveTarget
 */
function createS3StreamStorage(resolveTarget) {
  return {
    _handleFile(req, file, cb) {
      ;(async () => {
        let s3Key = null
        try {
          const { key, maxBytes = MAX_FILE_SIZE } = await resolveTarget(req, file)
          s3Key = key
          const { stream, sizePromise } = prepareValidatedStream(file.stream, file.mimetype, maxBytes)

          const uploadPromise = uploadAudioStream(s3Key, stream, file.mimetype)
          const [, size] = await Promise.all([uploadPromise, sizePromise])

          cb(null, {
            fieldname: file.fieldname,
            originalname: file.originalname,
            encoding: file.encoding,
            mimetype: file.mimetype,
            size,
            s3Key,
          })
        } catch (err) {
          if (s3Key) {
            await deleteAudio(s3Key).catch(() => {})
          }
          cb(err)
        }
      })()
    },

    _removeFile(_req, file, cb) {
      if (file?.s3Key) {
        deleteAudio(file.s3Key).finally(() => cb(null))
        return
      }
      cb(null)
    },
  }
}

module.exports = { createS3StreamStorage, prepareValidatedStream, createByteLimitedStream }
