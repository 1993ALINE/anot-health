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
 * Optionally normalize/compress audio before transcription.
 * @returns {{ path: string, tempPaths: string[] }}
 */
async function processAudioForTranscription(absInPath, settings) {
  const tempPaths = []
  if (!settings?.ffmpeg_enabled || !settings?.ffmpeg_preprocess_before_transcribe) {
    return { path: absInPath, tempPaths }
  }
  const ok = await ffmpegAvailable()
  if (!ok) {
    console.warn('[audioProcessing] ffmpeg not found; using original file')
    return { path: absInPath, tempPaths }
  }
  const SUPPORTED_FORMATS = ['wav', 'mp3', 'ogg', 'webm', 'flac']
  const ext = SUPPORTED_FORMATS.includes(String(settings.ffmpeg_target_format || '').toLowerCase())
    ? String(settings.ffmpeg_target_format).toLowerCase()
    : 'mp3'
  const out = path.join(os.tmpdir(), `anot_tx_${Date.now()}.${ext}`)
  const q = Math.max(0, Math.min(9, Number(settings.ffmpeg_compression) || 5))
  const args = ['-y', '-i', absInPath, '-ar', '16000', '-ac', '1', '-af', 'highpass=f=80']
  switch (ext) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-q:a', String(q))
      break
    case 'wav':
      args.push('-c:a', 'pcm_s16le')
      break
    case 'flac':
      // FLAC compression level 0–12 (higher = smaller/slower). Map the 0–9 slider directly.
      args.push('-c:a', 'flac', '-compression_level', String(Math.min(q, 12)))
      break
    case 'ogg':
    case 'webm': {
      // Opus is ideal for voice: small files, fast uploads. Map the 0–9 compression
      // slider to a VoIP-range bitrate (q=0 → 64k best quality, q=9 → 16k smallest).
      const bitrate = Math.round(64 - (q / 9) * 48)
      args.push('-c:a', 'libopus', '-b:a', `${bitrate}k`, '-application', 'voip')
      break
    }
    default:
      args.push('-c:a', 'libmp3lame', '-q:a', String(q))
  }
  args.push(out)
  try {
    await runFfmpeg(args)
    tempPaths.push(out)
    return { path: out, tempPaths }
  } catch (e) {
    console.warn('[audioProcessing] ffmpeg failed, falling back to source:', e.message)
    try { await fs.promises.unlink(out).catch(() => {}) } catch { /* */ }
    return { path: absInPath, tempPaths }
  }
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
