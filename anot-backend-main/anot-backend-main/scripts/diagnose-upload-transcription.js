#!/usr/bin/env node
'use strict'

/**
 * End-to-end readiness check for audio upload + transcription pipeline.
 *
 * Usage (from anot-backend-main/anot-backend-main):
 *   node scripts/diagnose-upload-transcription.js
 *
 * Optional env:
 *   API_BASE=https://app.anot.health/api
 *   SSM_PREFIX=/anot/prod
 *   SSM_REGION=ap-southeast-1
 *   S3_BUCKET=...
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const issues = []
const ok = []

function pass(label) {
  ok.push(label)
  console.log(`  ✓ ${label}`)
}

function fail(label, detail) {
  const msg = detail ? `${label}: ${detail}` : label
  issues.push(msg)
  console.error(`  ✗ ${msg}`)
}

function read(rel) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) return null
  return fs.readFileSync(full, 'utf8')
}

async function checkNginxConfig() {
  console.log('\n[1/6] nginx body size configuration')
  const eb = read('.ebextensions/01_nginx_bodysize.config')
  const platform = read('.platform/nginx/conf.d/01_client_max_body_size.conf')
  if (eb && /client_max_body_size\s+500m/i.test(eb)) {
    pass('.ebextensions/01_nginx_bodysize.config has client_max_body_size 500m')
  } else {
    fail('nginx ebextension', 'missing or incorrect client_max_body_size 500m')
  }
  if (platform && /client_max_body_size\s+500m/i.test(platform)) {
    pass('.platform/nginx/conf.d/01_client_max_body_size.conf present (AL2023)')
  } else {
    fail('nginx platform hook', 'missing .platform/nginx/conf.d/01_client_max_body_size.conf')
  }
}

async function checkUploadLimits() {
  console.log('\n[2/6] Backend upload limits')
  delete process.env.FFMPEG_MAX_UPLOAD_MB
  const { getMaxUploadBytes, DEFAULT_FFMPEG_MAX_UPLOAD_MB } = require('../src/utils/ffmpegUploadLimits')
  if (DEFAULT_FFMPEG_MAX_UPLOAD_MB === 500) {
    pass('Default FFMPEG_MAX_UPLOAD_MB = 500')
  } else {
    fail('FFMPEG default', `expected 500, got ${DEFAULT_FFMPEG_MAX_UPLOAD_MB}`)
  }
  if (getMaxUploadBytes() === 500 * 1024 * 1024) {
    pass('Multer ceiling = 500 MB')
  } else {
    fail('Multer ceiling', `${getMaxUploadBytes() / (1024 * 1024)} MB`)
  }
}

async function checkDeepgramKey() {
  console.log('\n[3/6] Deepgram API key')
  const envKey = process.env.DEEPGRAM_API_KEY?.trim()
  if (envKey) {
    pass(`DEEPGRAM_API_KEY in env (${envKey.slice(0, 4)}…${envKey.slice(-4)})`)
    return envKey
  }

  if (process.env.USE_SSM === 'true' || process.argv.includes('--ssm')) {
    try {
      const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm')
      const prefix = (process.env.SSM_PREFIX || '/anot/prod').replace(/\/+$/, '')
      const region = process.env.SSM_REGION || process.env.AWS_REGION || 'ap-southeast-1'
      const client = new SSMClient({ region })
      const name = `${prefix}/DEEPGRAM_API_KEY`
      const out = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
      const val = out.Parameter?.Value?.trim()
      if (val) {
        pass(`SSM ${name} is set`)
        return val
      }
      fail('Deepgram key', `SSM ${name} is empty`)
    } catch (err) {
      fail('Deepgram key', `SSM lookup failed: ${err.message}`)
    }
  } else {
    fail('Deepgram key', 'DEEPGRAM_API_KEY not in env (set USE_SSM=true or pass --ssm to check SSM)')
  }
  return null
}

async function checkDeepgramConnection(apiKey) {
  console.log('\n[4/6] Deepgram API connectivity')
  if (!apiKey) {
    fail('Deepgram API', 'skipped — no API key')
    return
  }

  // Minimal 0.1s silent WAV for a cheap listen probe.
  const sampleRate = 8000
  const durationSec = 0.1
  const numSamples = Math.floor(sampleRate * durationSec)
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  try {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=en-US', {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: buf,
    })
    if (res.ok) {
      pass('Deepgram /v1/listen responded OK')
    } else {
      const body = await res.text().catch(() => '')
      fail('Deepgram API', `HTTP ${res.status}: ${body.slice(0, 120)}`)
    }
  } catch (err) {
    fail('Deepgram API', err.message)
  }
}

async function checkS3() {
  console.log('\n[5/6] S3 storage')
  const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || process.env.AUDIO_S3_BUCKET
  if (!bucket) {
    fail('S3 bucket', 'S3_BUCKET / AWS_S3_BUCKET not set in env')
    return
  }
  try {
    const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3')
    const region = process.env.AWS_REGION || process.env.S3_REGION || 'ap-southeast-1'
    const client = new S3Client({ region })
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    pass(`S3 bucket accessible: ${bucket}`)
  } catch (err) {
    fail('S3 bucket', `${bucket}: ${err.message}`)
  }
}

async function checkDatabase() {
  console.log('\n[6/6] Database + AI settings')
  try {
    const loadSecrets = require('../src/config/loadSecrets')
    await loadSecrets()
    const pool = require('../src/config/db')
    await pool.query('SELECT 1')
    pass('Database connection OK')

    const { loadAiSettings, useDeepgram } = require('../src/services/aiSettings')
    const settings = await loadAiSettings()
    if (useDeepgram(settings)) {
      pass(`Deepgram enabled (model=${settings.deepgram_model})`)
    } else {
      fail(
        'Deepgram settings',
        'not configured — enable in Admin → Settings or set DEEPGRAM_API_KEY + deepgram_enabled',
      )
    }
    await pool.end()
  } catch (err) {
    fail('Database', err.message)
  }
}

async function main() {
  console.log('=== Anot upload + transcription diagnostics ===')
  await checkNginxConfig()
  await checkUploadLimits()
  const key = await checkDeepgramKey()
  await checkDeepgramConnection(key)
  await checkS3()
  await checkDatabase()

  console.log('')
  if (issues.length === 0) {
    console.log('✅ All systems ready')
    process.exit(0)
  }
  console.error(`❌ Issues found (${issues.length}):`)
  for (const item of issues) console.error(`   - ${item}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('Diagnostic script failed:', err.message)
  process.exit(1)
})
