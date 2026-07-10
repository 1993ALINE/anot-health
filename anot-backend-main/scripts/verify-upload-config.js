#!/usr/bin/env node
'use strict'

/**
 * Pre-deploy check: audio upload limits, MIME normalization, and retry logic.
 *
 * Usage (from anot-backend-main/anot-backend-main):
 *   node scripts/verify-upload-config.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FRONTEND_ROOT = path.resolve(ROOT, '..', '..', 'anot-frontend-main', 'anot-frontend-main')

const EXPECTED_NGINX_MB = 500
const EXPECTED_UPLOAD_MB = 500

const checks = []

function pass(label) {
  checks.push({ ok: true, label })
  console.log(`  ✓ ${label}`)
}

function fail(label, detail) {
  checks.push({ ok: false, label, detail })
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`)
}

function read(relPath) {
  const full = path.join(ROOT, relPath)
  if (!fs.existsSync(full)) {
    fail(`Missing file ${relPath}`)
    return null
  }
  return fs.readFileSync(full, 'utf8')
}

function readFrontend(relPath) {
  const full = path.join(FRONTEND_ROOT, relPath)
  if (!fs.existsSync(full)) {
    fail(`Missing frontend file ${relPath}`)
    return null
  }
  return fs.readFileSync(full, 'utf8')
}

console.log('[verify-upload-config] Checking backend upload limits…')

const nginxConfig = read('.ebextensions/01_nginx_bodysize.config')
if (nginxConfig) {
  if (/client_max_body_size\s+500m\s*;/i.test(nginxConfig)) {
    pass(`nginx client_max_body_size = ${EXPECTED_NGINX_MB}m`)
  } else {
    fail('nginx client_max_body_size', 'expected "client_max_body_size 500m;"')
  }
}

const platformNginx = read('.platform/nginx/conf.d/01_client_max_body_size.conf')
if (platformNginx && /client_max_body_size\s+500m/i.test(platformNginx)) {
  pass('.platform/nginx AL2023 client_max_body_size = 500m')
} else {
  fail('.platform/nginx config', 'missing .platform/nginx/conf.d/01_client_max_body_size.conf')
}

const fileValidation = read('src/middleware/fileValidation.js')
if (fileValidation) {
  if (/getMaxUploadBytes\s*\(\s*\)/.test(fileValidation)) {
    pass('Multer MAX_FILE_SIZE uses getMaxUploadBytes()')
  } else {
    fail('Multer MAX_FILE_SIZE', 'expected getMaxUploadBytes() from ffmpegUploadLimits')
  }
  if (/normalizeMimeType/.test(fileValidation)) {
    pass('Backend MIME normalization (normalizeMimeType)')
  } else {
    fail('Backend MIME normalization missing')
  }
}

delete process.env.FFMPEG_MAX_UPLOAD_MB
const { DEFAULT_FFMPEG_MAX_UPLOAD_MB, getMaxUploadBytes } = require('../src/utils/ffmpegUploadLimits')
if (DEFAULT_FFMPEG_MAX_UPLOAD_MB === EXPECTED_UPLOAD_MB) {
  pass(`FFMPEG default = ${EXPECTED_UPLOAD_MB} MB`)
} else {
  fail('FFMPEG default', `got ${DEFAULT_FFMPEG_MAX_UPLOAD_MB}, expected ${EXPECTED_UPLOAD_MB}`)
}
if (getMaxUploadBytes() === EXPECTED_UPLOAD_MB * 1024 * 1024) {
  pass(`getMaxUploadBytes() = ${EXPECTED_UPLOAD_MB} MB`)
} else {
  fail('getMaxUploadBytes()', `got ${getMaxUploadBytes() / (1024 * 1024)} MB`)
}

const startupDiag = read('src/startup/startupDiagnostics.js')
if (startupDiag) {
  if (/FFMPEG_MAX_UPLOAD_MB=\$\{uploadLimit\.mb\}/.test(startupDiag)) {
    pass('Startup diagnostics logs FFMPEG_MAX_UPLOAD_MB')
  } else {
    fail('Startup diagnostics', 'expected FFMPEG_MAX_UPLOAD_MB log line')
  }
}

const ebEnv = read('.ebextensions/00_env_vars.config')
if (ebEnv) {
  if (/FFMPEG_MAX_UPLOAD_MB:\s*['"]500['"]/.test(ebEnv)) {
    pass('EB env FFMPEG_MAX_UPLOAD_MB = 500')
  } else {
    fail('EB env FFMPEG_MAX_UPLOAD_MB', 'add FFMPEG_MAX_UPLOAD_MB: \'500\' to .ebextensions/00_env_vars.config')
  }
}

console.log('[verify-upload-config] Checking frontend upload helpers…')

const audioUpload = readFrontend('src/utils/audioUpload.js')
if (audioUpload) {
  if (/500\s*\*\s*1024\s*\*\s*1024/.test(audioUpload)) {
    pass('Frontend MAX_AUDIO_UPLOAD_BYTES = 500 MB')
  } else {
    fail('Frontend max upload size', 'expected 500 * 1024 * 1024')
  }
  if (/export function normalizeAudioBlob/.test(audioUpload) && /split\s*\(\s*['"];['"]\s*\)/.test(audioUpload)) {
    pass('Frontend normalizeAudioBlob() strips codec MIME params')
  } else {
    fail('Frontend normalizeAudioBlob()', 'missing or incomplete')
  }
  if (/UPLOAD_MAX_RETRIES\s*=\s*3/.test(audioUpload) && /uploadWithRetry/.test(audioUpload)) {
    pass('Frontend uploadWithRetry (3 attempts, exponential backoff)')
  } else {
    fail('Frontend retry logic', 'expected UPLOAD_MAX_RETRIES = 3 and uploadWithRetry')
  }
  if (/status === 413/.test(audioUpload)) {
    pass('Frontend formatUploadError handles 413')
  } else {
    fail('Frontend 413 error handling in formatUploadError')
  }
}

const failed = checks.filter((c) => !c.ok)
console.log('')
if (failed.length === 0) {
  console.log('✅ All upload configs verified')
  process.exit(0)
}

console.error(`❌ Config mismatch found (${failed.length} issue(s))`)
failed.forEach((c) => console.error(`   - ${c.label}${c.detail ? `: ${c.detail}` : ''}`))
process.exit(1)
