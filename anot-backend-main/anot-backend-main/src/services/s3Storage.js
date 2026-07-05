// S3-backed audio storage. Files used to live on local disk (src/uploads/),
// which Elastic Beanstalk wipes on every redeploy — S3 makes them persistent.
//
// Credentials come from the standard AWS provider chain (EB instance profile,
// or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars locally).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pipeline } = require('stream/promises')
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

/** Default prod bucket — override with S3_AUDIO_BUCKET (EB env or SSM). */
const DEFAULT_AUDIO_BUCKET = 'anot-audio-625242092266'

/**
 * Resolve the audio bucket at call time (after loadSecrets / SSM hydration).
 * Do not cache at module load — process.env.S3_AUDIO_BUCKET may arrive from SSM after require().
 */
function getAudioBucket() {
  const fromEnv = String(process.env.S3_AUDIO_BUCKET || '').trim()
  return fromEnv || DEFAULT_AUDIO_BUCKET
}

/** For startup diagnostics: bucket value + whether it came from env or default. */
function resolveAudioBucketConfig() {
  const fromEnv = String(process.env.S3_AUDIO_BUCKET || '').trim()
  if (fromEnv) {
    return { bucket: fromEnv, source: 'env' }
  }
  return { bucket: DEFAULT_AUDIO_BUCKET, source: 'default' }
}

const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1'
const SIGNED_URL_TTL_SECONDS = 900 // 15 minutes — PHI-safe presign window

const s3 = new S3Client({ region: AWS_REGION })

/**
 * DB stores audio paths as "/uploads/visit_<id>_<ts>.<ext>" (legacy local-disk
 * format). The S3 object key is the same path without the leading slash:
 * "uploads/visit_<id>_<ts>.<ext>".
 */
function dbPathToKey(dbPath) {
  return String(dbPath).replace(/^\//, '')
}

async function uploadAudio(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: getAudioBucket(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  }))
}

/** Stream upload via S3 multipart — no in-memory buffering of the full file. */
async function uploadAudioStream(key, stream, contentType) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: getAudioBucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false,
  })
  await upload.done()
}

/** Presigned GET URL, valid 15 minutes. */
async function getSignedAudioUrl(key) {
  const command = new GetObjectCommand({ Bucket: getAudioBucket(), Key: key })
  return getSignedUrl(s3, command, { expiresIn: SIGNED_URL_TTL_SECONDS })
}

/**
 * Stream an S3 audio object with optional HTTP Range support.
 * @returns {Promise<{ body: import('stream').Readable, contentType?: string, contentLength?: number, contentRange?: string, acceptRanges?: string, statusCode: number }>}
 */
async function getAudioStream(key, rangeHeader) {
  const params = { Bucket: getAudioBucket(), Key: key }
  if (rangeHeader) {
    params.Range = rangeHeader
  }
  const res = await s3.send(new GetObjectCommand(params))
  const statusCode = rangeHeader && res.ContentRange ? 206 : 200
  return {
    body: res.Body,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
    acceptRanges: res.AcceptRanges || 'bytes',
    statusCode,
  }
}

/**
 * Download an S3 object to a temp file (used by the transcription pipeline,
 * which needs a local path for ffmpeg/Deepgram).
 * @returns {Promise<string>} absolute path of the temp file
 */
async function downloadAudioToTemp(key) {
  const ext = path.extname(key) || '.webm'
  const tmpPath = path.join(os.tmpdir(), `anot_s3_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`)
  const res = await s3.send(new GetObjectCommand({ Bucket: getAudioBucket(), Key: key }))
  await pipeline(res.Body, fs.createWriteStream(tmpPath))
  return tmpPath
}

/** Best-effort delete (visit deletion cleanup). */
async function deleteAudio(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: getAudioBucket(), Key: key }))
  } catch (err) {
    console.warn(`[s3Storage] Failed to delete ${key}:`, err.message)
  }
}

module.exports = {
  getAudioBucket,
  resolveAudioBucketConfig,
  /** @deprecated Use getAudioBucket() — reads process.env at call time. */
  get AUDIO_BUCKET() {
    return getAudioBucket()
  },
  dbPathToKey,
  uploadAudio,
  uploadAudioStream,
  getSignedAudioUrl,
  getAudioStream,
  downloadAudioToTemp,
  deleteAudio,
}
