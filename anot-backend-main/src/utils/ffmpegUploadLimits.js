'use strict'

/** Default when FFMPEG_MAX_UPLOAD_MB is unset and DB has no value (supports ~1-hour recordings). */
const DEFAULT_FFMPEG_MAX_UPLOAD_MB = 500

/** Hard ceiling for env, DB, and admin UI. */
const MAX_ALLOWED_MB = 500

function parsePositiveInt(val) {
  if (val == null || String(val).trim() === '') return null
  const n = parseInt(String(val), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function clampMb(mb) {
  return Math.max(1, Math.min(MAX_ALLOWED_MB, Math.round(mb)))
}

function getEnvFfmpegMaxUploadMb() {
  return parsePositiveInt(process.env.FFMPEG_MAX_UPLOAD_MB)
}

/**
 * Effective upload limit in MB.
 * Priority: FFMPEG_MAX_UPLOAD_MB env → DB value → default 500.
 */
function resolveFfmpegMaxUploadMb(dbValue) {
  const fromEnv = getEnvFfmpegMaxUploadMb()
  if (fromEnv != null) return clampMb(fromEnv)
  const fromDb = parsePositiveInt(dbValue)
  if (fromDb != null) return clampMb(fromDb)
  return DEFAULT_FFMPEG_MAX_UPLOAD_MB
}

function ffmpegMaxUploadBytes(dbValue) {
  return resolveFfmpegMaxUploadMb(dbValue) * 1024 * 1024
}

/** Multer / static ceiling at module load (env or default; no DB yet). */
function getMaxUploadBytes() {
  return ffmpegMaxUploadBytes()
}

function describeUploadLimitSource() {
  const fromEnv = getEnvFfmpegMaxUploadMb()
  if (fromEnv != null) {
    return { mb: clampMb(fromEnv), source: 'environment' }
  }
  return { mb: DEFAULT_FFMPEG_MAX_UPLOAD_MB, source: 'default' }
}

module.exports = {
  DEFAULT_FFMPEG_MAX_UPLOAD_MB,
  MAX_ALLOWED_MB,
  resolveFfmpegMaxUploadMb,
  ffmpegMaxUploadBytes,
  getMaxUploadBytes,
  getEnvFfmpegMaxUploadMb,
  describeUploadLimitSource,
  clampMb,
}
