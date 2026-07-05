#!/usr/bin/env node
'use strict'
/** Reset idle + re-run AI pipeline for visits stuck in processing. Run on EB with USE_SSM=true. */
const STUCK_IDS = [189,190,191,193,363,365,366,368,373,374,376,378,379,383,384,385,386,387,388,389,390,391,392,393,394,395]
const DELAY_MS = 12000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  process.chdir('/var/app/current')
  require('./src/config/loadSecrets')?.loadSecrets?.()
  const { setVisitTranscriptionStatus } = require('./src/utils/visitSchemaCompat')
  const { runAIPipeline } = require('./src/utils/aiPipeline')
  const pool = require('./src/config/db')

  for (let i = 0; i < STUCK_IDS.length; i++) {
    const id = STUCK_IDS[i]
    console.log(`[${i + 1}/${STUCK_IDS.length}] visit ${id} — reset + pipeline`)
    await setVisitTranscriptionStatus(id, 'idle')
    try {
      await runAIPipeline(id, {
        user: { id: 0, name: 'retry-stuck-day1', role: 'admin' },
        completionMessage: 'Day 1 load test retry',
      })
      const { rows } = await pool.query(
        'SELECT transcription_status FROM visits WHERE id = $1',
        [id],
      )
      console.log(`  → status=${rows[0]?.transcription_status}`)
    } catch (err) {
      console.error(`  → ERROR: ${err.message}`)
    }
    if (i < STUCK_IDS.length - 1) await sleep(DELAY_MS)
  }
  await pool.end()
  console.log('DONE')
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
