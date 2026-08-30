'use strict'

const { HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3')
const { getAudioBucket } = require('../services/s3Storage')
const { loadAiSettings, getDeepgramKey } = require('../services/aiSettings')
const { getDeepgramCircuitStatus } = require('../services/deepgramService')

const PROBE_TIMEOUT_MS = parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || '4000', 10)
const CACHE_TTL_MS = parseInt(process.env.HEALTH_PROBE_CACHE_MS || '60000', 10)

const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1'
const s3 = new S3Client({ region: AWS_REGION })

let cache = { at: 0, components: null }

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function probeDatabase(pool) {
  const start = Date.now()
  try {
    await withTimeout(pool.query('SELECT 1'), PROBE_TIMEOUT_MS, 'Database')
    const { rows } = await pool.query('SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database()')
    const connections = rows[0]?.c ?? null
    return { status: 'ok', latency_ms: Date.now() - start, message: 'Connected', connections }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, message: err.message || 'Connection failed' }
  }
}

async function probeDeepgram(settings) {
  const start = Date.now()
  const circuit = getDeepgramCircuitStatus()
  if (circuit.state === 'open') {
    return { status: 'error', latency_ms: 0, message: 'Circuit breaker open — Deepgram temporarily unavailable', circuit }
  }
  if (!settings?.transcribe_enabled && String(process.env.USE_DEEPGRAM || '').toLowerCase() !== 'true') {
    return { status: 'error', latency_ms: 0, message: 'Transcription disabled in settings' }
  }
  const key = await getDeepgramKey()
  if (!key) {
    return { status: 'error', latency_ms: 0, message: 'No Deepgram API key configured' }
  }
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    const res = await fetch('https://api.deepgram.com/v1/projects?limit=1', {
      method: 'GET',
      headers: { Authorization: `Token ${key}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(t))
    const latency = Date.now() - start
    if (res.ok) return { status: 'ok', latency_ms: latency, message: 'API responding', circuit }
    if (res.status === 401 || res.status === 403) {
      return { status: 'error', latency_ms: latency, message: 'Invalid API key', circuit }
    }
    return { status: 'error', latency_ms: latency, message: `API returned ${res.status}`, circuit }
  } catch (err) {
    const latency = Date.now() - start
    const msg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Request failed')
    return { status: 'error', latency_ms: latency, message: msg, circuit }
  }
}

async function probeS3() {
  const start = Date.now()
  try {
    await withTimeout(
      s3.send(new HeadBucketCommand({ Bucket: getAudioBucket() })),
      PROBE_TIMEOUT_MS,
      'S3',
    )
    return { status: 'ok', latency_ms: Date.now() - start, message: 'Bucket accessible' }
  } catch (err) {
    const latency = Date.now() - start
    const code = err.name || err.Code || ''
    let message = err.message || 'Bucket unreachable'
    if (code === 'NotFound' || err.$metadata?.httpStatusCode === 404) message = 'Bucket not found'
    else if (code === 'Forbidden' || err.$metadata?.httpStatusCode === 403) message = 'Access denied'
    return { status: 'error', latency_ms: latency, message }
  }
}

async function runDependencyProbes(pool) {
  let settings = {}
  try {
    settings = await loadAiSettings()
  } catch (err) {
    console.error('[dependencyHealth] loadAiSettings failed:', err.message)
  }

  const [database, deepgram, s3res] = await Promise.all([
    probeDatabase(pool),
    probeDeepgram(settings),
    probeS3(),
  ])

  return {
    database,
    deepgram,
    s3: s3res,
  }
}

function rollupStatus(components) {
  const failed = Object.values(components).filter((c) => c.status !== 'ok').length
  if (failed === 0) return 'healthy'
  if (failed === 1) return 'degraded'
  return 'critical'
}

async function getDependencyHealth(pool, { force = false } = {}) {
  const now = Date.now()
  if (!force && cache.components && now - cache.at < CACHE_TTL_MS) {
    return { components: cache.components, status: rollupStatus(cache.components), cached: true }
  }
  const components = await runDependencyProbes(pool)
  cache = { at: now, components }
  return { components, status: rollupStatus(components), cached: false }
}

function clearDependencyHealthCache() {
  cache = { at: 0, components: null }
}

module.exports = {
  getDependencyHealth,
  runDependencyProbes,
  rollupStatus,
  clearDependencyHealthCache,
  probeDatabase,
  probeDeepgram,
  probeS3,
}
