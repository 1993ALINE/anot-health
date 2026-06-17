#!/usr/bin/env node

/**
 * Test script to verify mimetype detection for audio files
 * Run: node scripts/test-mimetype-detection.js
 */

const path = require('path')

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',
  }
  return mimeTypes[ext] || null
}

console.log('=== Mimetype Detection Test ===\n')

const testFiles = [
  'src/uploads/visit_25_1780788835866.webm',
  'src/uploads/visit_25_1780788861437.webm',
  'test.wav',
  'audio.mp3',
  'recording.m4a',
  'file.ogg',
  'audio.flac',
  'voice.opus',
  'unknown.xyz',
]

testFiles.forEach(file => {
  const mimetype = getMimeTypeFromPath(file)
  const ext = path.extname(file).toLowerCase()
  const basename = path.basename(file)
  
  console.log(`File: ${basename}`)
  console.log(`  Extension: ${ext}`)
  console.log(`  Mimetype: ${mimetype || 'auto-detect (not in map)'}`)
  console.log()
})

console.log('✓ Test complete')
console.log('\nWebM files will be sent to Deepgram with mimetype "audio/webm"')
