// System Health dashboard endpoint (Super Admin only).
//
// GET /api/admin/health probes the core dependencies — Postgres, Deepgram,
// Anthropic, and the S3 audio bucket — measures each one's latency, and rolls
// the results up into a single status (healthy / degraded / critical). The
// probe results are cached for 5 minutes so a chatty dashboard (or several
// admins) can't hammer the upstream APIs, while the lightweight DB-backed
// metrics are computed fresh on every request.

const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { loadAiSettings } = require('../services/aiSettings')
const { HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3')
const { AUDIO_BUCKET } = require('../services/s3Storage')

const PROBE_TIMEOUT_MS = 4000
const CACHE_TTL_MS = 5 * 60 * 1000

// Component-probe cache. Shared across requests/admins so we don't re-test the
// upstream APIs more than once per CACHE_TTL_MS window.
let probeCache = { at: 0, value: null }

const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-1'
const s3 = new S3Client({ region: AWS_REGION })

/** Human-friendly "Xs ago" / "Xm ago" for a past timestamp (ms epoch). */
function relativeTime(tsMs) {
  const diffSec = Math.max(0, Math.round((Date.now() - tsMs) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return `${hours}h ago`
}

/** Wrap a promise with a timeout so a hung upstream can't stall the dashboard. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ─── COMPONENT PROBES ──────────────────────────────────────────────────────

async function probeDatabase() {
  const start = Date.now()
  try {
    await withTimeout(pool.query('SELECT 1'), PROBE_TIMEOUT_MS, 'Database')
    return { status: 'ok', latency_ms: Date.now() - start, message: 'Connected' }
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, message: err.message || 'Connection failed' }
  }
}

async function probeDeepgram(settings) {
  const start = Date.now()
  const key = settings?.deepgram_api_key
  if (!key) {
    return { status: 'error', latency_ms: 0, message: 'No API key configured' }
  }
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    // /v1/projects is a lightweight authenticated GET that validates the key
    // without consuming any transcription credits.
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      method: 'GET',
      headers: { Authorization: `Token ${key}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(t))
    const latency = Date.now() - start
    if (res.ok) return { status: 'ok', latency_ms: latency, message: 'API responding' }
    if (res.status === 401 || res.status === 403) {
      return { status: 'error', latency_ms: latency, message: 'Invalid API key' }
    }
    return { status: 'error', latency_ms: latency, message: `API returned ${res.status}` }
  } catch (err) {
    const latency = Date.now() - start
    const msg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Request failed')
    return { status: 'error', latency_ms: latency, message: msg }
  }
}

async function probeAnthropic(settings) {
  const start = Date.now()
  const key = settings?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null
  if (!key) {
    return { status: 'error', latency_ms: 0, message: 'No API key configured' }
  }
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    // GET /v1/models is the lightest authenticated call — it validates the key
    // without spending tokens on a completion.
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(t))
    const latency = Date.now() - start
    if (res.ok) return { status: 'ok', latency_ms: latency, message: 'API responding' }
    if (res.status === 401 || res.status === 403) {
      return { status: 'error', latency_ms: latency, message: 'Invalid API key' }
    }
    return { status: 'error', latency_ms: latency, message: `API returned ${res.status}` }
  } catch (err) {
    const latency = Date.now() - start
    const msg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Request failed')
    return { status: 'error', latency_ms: latency, message: msg }
  }
}

async function probeS3() {
  const start = Date.now()
  try {
    await withTimeout(
      s3.send(new HeadBucketCommand({ Bucket: AUDIO_BUCKET })),
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

/** Run every component probe, attach a relative "lastTest", and cache the set. */
async function runProbes() {
  let settings = {}
  try {
    settings = await loadAiSettings()
  } catch (err) {
    console.error('[health] loadAiSettings failed:', err.message)
  }

  const [database, deepgram, anthropic, s3res] = await Promise.all([
    probeDatabase(),
    probeDeepgram(settings),
    probeAnthropic(settings),
    probeS3(),
  ])

  const testedAt = Date.now()
  const components = {
    database: { ...database, lastTest: relativeTime(testedAt) },
    deepgram: { ...deepgram, lastTest: relativeTime(testedAt) },
    anthropic: { ...anthropic, lastTest: relativeTime(testedAt) },
    s3: { ...s3res, lastTest: relativeTime(testedAt) },
  }
  // database is the one probe with a "Connected" message rather than lastTest in
  // the spec, but exposing lastTest for every component keeps the UI uniform.
  return { components, testedAt }
}

// ─── METRICS ───────────────────────────────────────────────────────────────

async function singleCount(sql, params = []) {
  try {
    const { rows } = await withTimeout(pool.query(sql, params), PROBE_TIMEOUT_MS, 'Metric')
    return Number(rows[0]?.c || 0)
  } catch (err) {
    console.error('[health] metric query failed:', err.message)
    return null
  }
}

async function collectMetrics() {
  const [totalUsers, activeSessions, errorsLast24h, apiCallsLast24h] = await Promise.all([
    singleCount('SELECT COUNT(*)::bigint AS c FROM users'),
    // Approximate "active sessions" as distinct users with audited activity in
    // the last 15 minutes (we don't keep a server-side session table).
    singleCount(
      `SELECT COUNT(DISTINCT user_id)::bigint AS c FROM audit_logs
       WHERE user_id IS NOT NULL AND created_at >= NOW() - INTERVAL '15 minutes'`,
    ),
    singleCount(
      `SELECT COUNT(*)::bigint AS c FROM audit_logs
       WHERE status IN ('error', 'failure', 'critical') AND created_at >= NOW() - INTERVAL '24 hours'`,
    ),
    singleCount(
      `SELECT COUNT(*)::bigint AS c FROM audit_logs
       WHERE created_at >= NOW() - INTERVAL '24 hours'`,
    ),
  ])
  return { totalUsers, activeSessions, errorsLast24h, apiCallsLast24h }
}

// ─── ROUTE ─────────────────────────────────────────────────────────────────

router.use(protect)
router.use(restrict('super_admin'))

router.get('/health', async (req, res) => {
  try {
    const now = Date.now()
    let cached = probeCache.value && now - probeCache.at < CACHE_TTL_MS ? probeCache.value : null

    if (!cached) {
      cached = await runProbes()
      probeCache = { at: now, value: cached }
    }

    // Recompute the relative "lastTest" each request off the cached test time so
    // it ages correctly even while the underlying probe result is reused.
    const components = {}
    for (const [name, comp] of Object.entries(cached.components)) {
      components[name] = { ...comp, lastTest: relativeTime(cached.testedAt) }
    }

    const failed = Object.values(components).filter((c) => c.status !== 'ok').length
    const status = failed === 0 ? 'healthy' : failed === 1 ? 'degraded' : 'critical'

    const metrics = await collectMetrics()

    res.json({
      status,
      timestamp: new Date().toISOString(),
      lastUpdated: new Date(cached.testedAt).toISOString(),
      components,
      metrics,
    })
  } catch (err) {
    console.error('[health] endpoint error:', err.message)
    res.status(500).json({ error: 'Failed to compute system health.' })
  }
})

module.exports = router
