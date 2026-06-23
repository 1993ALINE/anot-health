const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr?.on('data', (c) => { err += String(c) })
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-800)}`))
    })
  })
}

async function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('close', (c) => resolve(c === 0))
  })
}

const SUPPORTED_FORMATS = ['wav', 'mp3', 'ogg', 'webm', 'flac']

/**
 * Check if ffmpeg preprocessing should be skipped
 */
function shouldSkipPreprocessing(settings) {
  return !settings?.ffmpeg_enabled || !settings?.ffmpeg_preprocess_before_transcribe
}

/**
 * Resolve target output format from settings
 */
function resolveTargetFormat(settings) {
  const fmt = String(settings.ffmpeg_target_format || '').toLowerCase()
  return SUPPORTED_FORMATS.includes(fmt) ? fmt : 'mp3'
}

/**
 * Build output path for preprocessed audio
 */
function buildPreprocessOutputPath(ext) {
  return path.join(os.tmpdir(), `anot_tx_${Date.now()}.${ext}`)
}

/**
 * Append codec-specific ffmpeg arguments
 */
function appendCodecArgs(args, ext, compressionLevel) {
  const q = Math.max(0, Math.min(9, compressionLevel))
  switch (ext) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-q:a', String(q))
      break
    case 'wav':
      args.push('-c:a', 'pcm_s16le')
      break
    case 'flac':
      args.push('-c:a', 'flac', '-compression_level', String(Math.min(q, 12)))
      break
    case 'ogg':
    case 'webm': {
      const bitrate = Math.round(64 - (q / 9) * 48)
      args.push('-c:a', 'libopus', '-b:a', `${bitrate}k`, '-application', 'voip')
      break
    }
    default:
      args.push('-c:a', 'libmp3lame', '-q:a', String(q))
  }
}

/**
 * Build full ffmpeg argument list for transcription preprocessing
 */
function buildFfmpegPreprocessArgs(absInPath, outPath, settings) {
  const ext = resolveTargetFormat(settings)
  const q = Math.max(0, Math.min(9, Number(settings.ffmpeg_compression) || 5))
  const args = ['-y', '-i', absInPath, '-ar', '16000', '-ac', '1', '-af', 'highpass=f=80']
  appendCodecArgs(args, ext, q)
  args.push(outPath)
  return { args, ext }
}

/**
 * Run ffmpeg preprocess or fall back to source file on failure
 */
async function runPreprocessOrFallback(absInPath, outPath, args) {
  const tempPaths = []
  try {
    await runFfmpeg(args)
    tempPaths.push(outPath)
    return { path: outPath, tempPaths }
  } catch (e) {
    console.warn('[audioProcessing] ffmpeg failed, falling back to source:', e.message)
    try { await fs.promises.unlink(outPath).catch(() => {}) } catch { /* */ }
    return { path: absInPath, tempPaths }
  }
}

/**
 * Optionally normalize/compress audio before transcription.
 * @returns {{ path: string, tempPaths: string[] }}
 */
async function processAudioForTranscription(absInPath, settings) {
  if (shouldSkipPreprocessing(settings)) {
    return { path: absInPath, tempPaths: [] }
  }
  const ok = await ffmpegAvailable()
  if (!ok) {
    console.warn('[audioProcessing] ffmpeg not found; using original file')
    return { path: absInPath, tempPaths: [] }
  }

  const ext = resolveTargetFormat(settings)
  const out = buildPreprocessOutputPath(ext)
  const { args } = buildFfmpegPreprocessArgs(absInPath, out, settings)
  return runPreprocessOrFallback(absInPath, out, args)
}

async function unlinkTempPaths(tempPaths) {
  for (const pth of tempPaths || []) {
    if (pth && pth !== '') await fs.promises.unlink(pth).catch(() => {})
  }
}

module.exports = {
  processAudioForTranscription,
  unlinkTempPaths,
  ffmpegAvailable,
}
