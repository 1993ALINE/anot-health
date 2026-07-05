#!/usr/bin/env node
'use strict'

/**
 * Loop a speech WAV to target duration (default 10 min) for load-test fixtures.
 * Usage: node scripts/generate-load-test-audio.js [--duration=600] [--out=dir] [--count=80]
 */
const fs = require('fs')
const path = require('path')

function parseArgs(argv) {
  const opts = { duration: 600, count: 80, out: path.join(__dirname, '..', 'test-fixtures', 'load-test', 'day1') }
  for (const arg of argv) {
    if (arg.startsWith('--duration=')) opts.duration = Math.max(60, parseInt(arg.slice(11), 10) || 600)
    else if (arg.startsWith('--count=')) opts.count = Math.max(1, parseInt(arg.slice(8), 10) || 80)
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6)
  }
  return opts
}

function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a WAV file: ${filePath}`)
  }
  let offset = 12
  let fmt = null
  let dataOffset = null
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    if (id === 'fmt ') fmt = buf.subarray(chunkStart, chunkStart + size)
    if (id === 'data') {
      dataOffset = chunkStart
      dataSize = size
      break
    }
    offset = chunkStart + size + (size % 2)
  }
  if (!fmt || dataOffset == null) throw new Error('Invalid WAV structure')
  const audioFormat = fmt.readUInt16LE(0)
  const numChannels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bitsPerSample = fmt.readUInt16LE(14)
  const pcm = buf.subarray(dataOffset, dataOffset + dataSize)
  return { fmt, pcm, sampleRate, numChannels, bitsPerSample, audioFormat }
}

function writeWav(outPath, fmt, pcm) {
  const dataSize = pcm.length
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  fmt.copy(buffer, 20)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  pcm.copy(buffer, 44)
  fs.writeFileSync(outPath, buffer)
}

function loopToDuration(sourcePath, targetSeconds) {
  const { fmt, pcm, sampleRate, numChannels, bitsPerSample } = readWavPcm(sourcePath)
  const bytesPerSecond = sampleRate * numChannels * (bitsPerSample / 8)
  const targetBytes = Math.ceil(targetSeconds * bytesPerSecond)
  const loops = Math.ceil(targetBytes / pcm.length)
  const parts = []
  for (let i = 0; i < loops; i++) parts.push(pcm)
  let combined = Buffer.concat(parts)
  if (combined.length > targetBytes) combined = combined.subarray(0, targetBytes)
  return { fmt, pcm: combined, actualSeconds: combined.length / bytesPerSecond }
}

const COMPLAINTS = [
  'hypertension follow-up',
  'type 2 diabetes management',
  'chronic lower back pain',
  'persistent cough and wheezing',
  'migraine headaches',
  'anxiety and insomnia',
  'osteoarthritis knee pain',
  'GERD and heartburn',
  'hypothyroidism review',
  'seasonal allergies',
]

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const source = path.join(__dirname, '..', 'test-fixtures', 'deepgram', 'test-e2e-speech.wav')
  if (!fs.existsSync(source)) {
    console.error('Missing source speech file:', source)
    process.exit(1)
  }
  fs.mkdirSync(opts.out, { recursive: true })

  console.log(`Generating ${opts.count} × ${opts.duration}s WAV files in ${opts.out}`)
  const manifest = []
  for (let i = 0; i < opts.count; i++) {
    const complaint = COMPLAINTS[i % COMPLAINTS.length]
    const outName = `visit-audio-${String(i + 1).padStart(3, '0')}.wav`
    const outPath = path.join(opts.out, outName)
    const { fmt, pcm, actualSeconds } = loopToDuration(source, opts.duration + (i % 3) * 20)
    writeWav(outPath, fmt, pcm)
    const mb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2)
    manifest.push({ index: i + 1, file: outName, complaint, durationSec: Math.round(actualSeconds), mb })
    process.stdout.write(`\r  ${i + 1}/${opts.count} ${outName} (${mb} MB, ~${Math.round(actualSeconds)}s)`)
  }
  console.log('\nDone.')
  fs.writeFileSync(path.join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

main()
