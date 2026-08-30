/**
 * Generate 20-minute test audio file for load testing
 * Creates a WAV file with sine wave tone
 */

const fs = require('fs');
const path = require('path');

function generateTestAudio(durationMinutes = 20, outputPath = null) {
  console.log(`Generating ${durationMinutes}-minute test audio file...`);
  
  const filename = outputPath || path.join(__dirname, `test-audio-${durationMinutes}min.wav`);
  
  // Audio parameters
  const sampleRate = 16000; // 16kHz (standard for speech)
  const channels = 1; // Mono
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  
  // Calculate sizes
  const durationSeconds = durationMinutes * 60;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * bytesPerSample * channels;
  const fileSize = 44 + dataSize; // 44 bytes for WAV header
  
  console.log(`Configuration:`);
  console.log(`  - Sample rate: ${sampleRate} Hz`);
  console.log(`  - Channels: ${channels} (mono)`);
  console.log(`  - Bits per sample: ${bitsPerSample}`);
  console.log(`  - Duration: ${durationSeconds} seconds`);
  console.log(`  - Total samples: ${numSamples.toLocaleString()}`);
  console.log(`  - File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
  
  // Create buffer
  const buffer = Buffer.alloc(fileSize);
  let offset = 0;
  
  // Write WAV header
  // RIFF chunk descriptor
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(fileSize - 8, offset); offset += 4; // File size - 8
  buffer.write('WAVE', offset); offset += 4;
  
  // fmt sub-chunk
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4; // Sub-chunk size
  buffer.writeUInt16LE(1, offset); offset += 2; // Audio format (1 = PCM)
  buffer.writeUInt16LE(channels, offset); offset += 2; // Number of channels
  buffer.writeUInt32LE(sampleRate, offset); offset += 4; // Sample rate
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, offset); offset += 4; // Byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, offset); offset += 2; // Block align
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2; // Bits per sample
  
  // data sub-chunk
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;
  
  console.log(`\nGenerating audio samples (this may take a moment)...`);
  
  // Generate audio data (1000 Hz sine wave)
  const frequency = 1000; // 1kHz tone
  const amplitude = 0.5; // 50% amplitude to avoid clipping
  
  for (let i = 0; i < numSamples; i++) {
    // Calculate sine wave value
    const t = i / sampleRate;
    const value = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    
    // Convert to 16-bit integer (-32768 to 32767)
    const sample = Math.floor(value * 32767);
    
    // Write sample
    buffer.writeInt16LE(sample, offset);
    offset += bytesPerSample;
    
    // Progress indicator
    if (i % (numSamples / 10) === 0) {
      const progress = Math.round((i / numSamples) * 100);
      process.stdout.write(`\rProgress: ${progress}%`);
    }
  }
  
  console.log(`\rProgress: 100%`);
  
  // Write to file
  console.log(`\nWriting to file: ${filename}`);
  fs.writeFileSync(filename, buffer);
  
  // Verify file
  const stats = fs.statSync(filename);
  const fileSizeMB = stats.size / (1024 * 1024);
  
  console.log(`\n✅ Audio file generated successfully!`);
  console.log(`   Path: ${filename}`);
  console.log(`   Size: ${fileSizeMB.toFixed(2)} MB`);
  console.log(`   Duration: ${durationMinutes} minutes`);
  console.log(`\nYou can now use this file for load testing.`);
  
  return filename;
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const duration = args[0] ? parseInt(args[0]) : 20;
  const outputPath = args[1] || null;
  
  if (isNaN(duration) || duration < 1) {
    console.error('Error: Invalid duration. Usage: node generate-test-audio.js [duration_in_minutes] [output_path]');
    process.exit(1);
  }
  
  try {
    generateTestAudio(duration, outputPath);
  } catch (error) {
    console.error('Error generating audio:', error.message);
    process.exit(1);
  }
}

module.exports = { generateTestAudio };
