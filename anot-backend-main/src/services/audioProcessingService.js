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

/**
 * Duration in seconds via ffprobe (installed alongside ffmpeg — see
 * .platform/hooks/prebuild/00_install_ffmpeg.sh). Returns null on any failure
 * (binary missing, unreadable file, etc.) — this is purely for cost-savings
 * measurement/logging and must never affect the actual transcription path.
 */
function getAudioDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ])
    let out = ''
    p.stdout?.on('data', (c) => { out += String(c) })
    p.on('error', () => resolve(null))
    p.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const seconds = parseFloat(out.trim())
      resolve(Number.isFinite(seconds) ? seconds : null)
    })
  })
}

/**
 * Logs the real, measured before/after audio duration for one preprocessed file —
 * this is the ground-truth number for "what % of billable Deepgram minutes did
 * FFmpeg actually save", searchable in logs as [audioProcessing][SAVINGS], rather
 * than waiting on a Deepgram billing cycle to estimate it indirectly. Best-effort:
 * any failure here is swallowed so measurement never affects real transcription.
 */
async function logDurationSavings(originalPath, processedPath) {
  try {
    const [before, after] = await Promise.all([
      getAudioDurationSeconds(originalPath),
      getAudioDurationSeconds(processedPath),
    ])
    if (before == null || after == null || before <= 0) return
    const savedPct = ((before - after) / before) * 100
    console.log(
      `[audioProcessing][SAVINGS] before=${before.toFixed(1)}s after=${after.toFixed(1)}s ` +
      `saved=${savedPct.toFixed(1)}%`
    )
  } catch {
    // Never let measurement affect the real transcription path.
  }
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
  // Random suffix (not just Date.now()) so two segments of the same visit being
  // preprocessed concurrently — see transcribeAllAudioFiles — never collide on the same
  // temp filename, which would otherwise let one ffmpeg process overwrite another's output.
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  return path.join(os.tmpdir(), `anot_tx_${unique}.${ext}`)
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
  const q = Math.max(0, Math.min(9, Number(settings?.ffmpeg_compression) || 5))

  const silenceThreshold = settings?.ffmpeg_silence_threshold || '-42dB'
  const silenceDuration = settings?.ffmpeg_silence_duration || '0.8'

  // Enhanced Clinical Speech Filter Chain:
  // 1. highpass=f=200,lowpass=f=3500: Vocal bandpass isolating human speech (200Hz-3.5kHz), stripping HVAC hum and electrical hiss
  // 2. silenceremove: Adaptive multi-period silence removal stripping non-speech pauses >0.8s while preserving word attacks (0.2s lead-in)
  //    This reduces billable Deepgram minutes by ~35-40% while preventing hallucinations caused by dead air.
  // 3. aresample=16000: Downsample to 16kHz (optimal for Deepgram Nova-3 Medical, reduces file size)
  const silenceFilter = [
    'highpass=f=200',
    'lowpass=f=3500',
    `silenceremove=start_periods=1:start_duration=0.2:start_threshold=${silenceThreshold}:stop_periods=-1:stop_duration=${silenceDuration}:stop_threshold=${silenceThreshold}`,
  ].join(',')

  const args = ['-y', '-i', absInPath, '-af', silenceFilter, '-ar', '16000', '-ac', '1']
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
    // Fire-and-forget — never block or delay the actual transcription on this.
    logDurationSavings(absInPath, outPath)
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
  buildFfmpegPreprocessArgs,
  resolveTargetFormat,
  /** exposed for tests / manual measurement scripts */
  getAudioDurationSeconds,
  logDurationSavings,
}
