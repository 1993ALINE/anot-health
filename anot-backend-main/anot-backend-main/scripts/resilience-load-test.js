#!/usr/bin/env node
'use strict'

/**
 * Resilience load test — hammers /api/health with concurrent requests.
 * Usage: node scripts/resilience-load-test.js [baseUrl] [concurrency]
 */

const baseUrl = (process.argv[2] || 'http://anot-backend-prod.eba-m2bjp2gp.ap-southeast-1.elasticbeanstalk.com').replace(/\/$/, '')
const concurrency = parseInt(process.argv[3] || '50', 10)
const totalRequests = concurrency * 2

async function fetchHealth(id) {
  const start = Date.now()
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15000) })
    const body = await res.json()
    return { id, ok: res.ok, status: res.status, ms: Date.now() - start, body }
  } catch (err) {
    return { id, ok: false, status: 0, ms: Date.now() - start, error: err.message }
  }
}

async function runBatch(batch) {
  return Promise.all(batch.map((id) => fetchHealth(id)))
}

async function main() {
  console.log(`Load test: ${totalRequests} requests, concurrency ${concurrency}`)
  console.log(`Target: ${baseUrl}/api/health`)

  const ids = Array.from({ length: totalRequests }, (_, i) => i + 1)
  const results = []
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency)
    results.push(...await runBatch(batch))
  }

  const failed = results.filter((r) => !r.ok)
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b)
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0
  const errorRate = ((failed.length / results.length) * 100).toFixed(2)

  console.log('')
  console.log('Results:')
  console.log(`  Total:    ${results.length}`)
  console.log(`  Failed:   ${failed.length}`)
  console.log(`  Error %:  ${errorRate}%`)
  console.log(`  P95 ms:   ${p95}`)
  console.log(`  Max ms:   ${latencies[latencies.length - 1] || 0}`)

  if (failed.length > 0) {
    console.log('  Sample failures:', failed.slice(0, 3))
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
