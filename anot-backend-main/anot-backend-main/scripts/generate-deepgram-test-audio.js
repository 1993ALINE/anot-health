#!/usr/bin/env node
/**
 * Generate silent WAV fixtures for Deepgram integration tests (no ffmpeg required).
 */
const fs = require('fs')
const path = require('path')

function createSilentWav(durationSeconds, sampleRate = 16000) {
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = sampleRate * durationSeconds * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

const dir = path.join(__dirname, '..', 'test-fixtures', 'deepgram')
fs.mkdirSync(dir, { recursive: true })

const files = [
  { name: 'test-10min.wav', seconds: 600 },
  { name: 'test-45min.wav', seconds: 2700 },
  { name: 'test-1hour.wav', seconds: 3600 },
  { name: 'test-probe.wav', seconds: 30 },
]

for (const { name, seconds } of files) {
  const out = path.join(dir, name)
  process.stdout.write(`Writing ${name} (${seconds}s)... `)
  fs.writeFileSync(out, createSilentWav(seconds))
  const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(2)
  console.log(`${mb} MB`)
}

fs.writeFileSync(path.join(dir, 'test-invalid.ogg'), 'invalid audio data')
console.log('Wrote test-invalid.ogg (18 bytes)')
console.log('Done:', dir)
