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
  const ext = settings.ffmpeg_target_format === 'wav' ? 'wav' : 'mp3'
  const out = path.join(os.tmpdir(), `anot_tx_${Date.now()}.${ext}`)
  const q = Math.max(0, Math.min(9, Number(settings.ffmpeg_compression) || 5))
  const args = ['-y', '-i', absInPath, '-ar', '16000', '-ac', '1', '-af', 'highpass=f=80']
  if (ext === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-q:a', String(q))
  } else {
    args.push('-c:a', 'pcm_s16le')
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
