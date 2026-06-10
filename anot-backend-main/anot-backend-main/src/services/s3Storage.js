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
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const AUDIO_BUCKET = process.env.S3_AUDIO_BUCKET || 'anot-audio-625242092266'
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1'
const SIGNED_URL_TTL_SECONDS = 604800 // 7 days (the SigV4 presigning maximum)

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
    Bucket: AUDIO_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
}

/** Presigned GET URL, valid 7 days. */
async function getSignedAudioUrl(key) {
  const command = new GetObjectCommand({ Bucket: AUDIO_BUCKET, Key: key })
  return getSignedUrl(s3, command, { expiresIn: SIGNED_URL_TTL_SECONDS })
}

/**
 * Download an S3 object to a temp file (used by the transcription pipeline,
 * which needs a local path for ffmpeg/Deepgram).
 * @returns {Promise<string>} absolute path of the temp file
 */
async function downloadAudioToTemp(key) {
  const ext = path.extname(key) || '.webm'
  const tmpPath = path.join(os.tmpdir(), `anot_s3_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`)
  const res = await s3.send(new GetObjectCommand({ Bucket: AUDIO_BUCKET, Key: key }))
  await pipeline(res.Body, fs.createWriteStream(tmpPath))
  return tmpPath
}

/** Best-effort delete (visit deletion cleanup). */
async function deleteAudio(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: AUDIO_BUCKET, Key: key }))
  } catch (err) {
    console.warn(`[s3Storage] Failed to delete ${key}:`, err.message)
  }
}

module.exports = {
  AUDIO_BUCKET,
  dbPathToKey,
  uploadAudio,
  getSignedAudioUrl,
  downloadAudioToTemp,
  deleteAudio,
}
