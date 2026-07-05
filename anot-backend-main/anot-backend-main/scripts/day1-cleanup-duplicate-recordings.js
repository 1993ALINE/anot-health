#!/usr/bin/env node
'use strict'
/** Remove duplicate Day 1 recordings — run on EB: USE_SSM=true node day1-cleanup-duplicate-recordings.js --confirm */
const UPDATES = [
  {
    visitId: 124,
    patient: 'Saka',
    keep: '/uploads/visit_124_1783078487689.mp4',
    remove: '/uploads/visit_124_1783082191607.webm',
  },
  {
    visitId: 380,
    patient: 'Kamal Jones',
    keep: '/uploads/visit_380_1783082724128.webm',
    remove: '/uploads/visit_380_1783083082406.webm',
  },
]

async function main() {
  const confirm = process.argv.includes('--confirm')
  if (!confirm) {
    console.error('Pass --confirm to delete duplicate recordings and update DB.')
    process.exit(1)
  }

  await require('./src/config/loadSecrets').loadSecrets()
  delete require.cache[require.resolve('./src/config/db')]
  const pool = require('./src/config/db')
  const { deleteAudio, dbPathToKey } = require('./src/services/s3Storage')

  let dbUpdated = 0
  let s3Deleted = 0

  for (const u of UPDATES) {
    const before = await pool.query('SELECT id, audio_file FROM visits WHERE id = $1', [u.visitId])
    const row = before.rows[0]
    if (!row) {
      console.error(`Visit ${u.visitId} (${u.patient}) not found`)
      process.exit(1)
    }
    console.log(`Before visit ${u.visitId} (${u.patient}): ${row.audio_file}`)

    if (row.audio_file === u.keep) {
      console.log(`Visit ${u.visitId} already has correct audio_file — skipping DB update`)
    } else {
      const r = await pool.query(
        'UPDATE visits SET audio_file = $1 WHERE id = $2 RETURNING id, audio_file',
        [u.keep, u.visitId],
      )
      console.log(`Updated visit ${u.visitId}: ${r.rows[0].audio_file}`)
      dbUpdated++
    }

    await deleteAudio(dbPathToKey(u.remove))
    console.log(`Deleted S3: ${u.remove}`)
    s3Deleted++
  }

  console.log(JSON.stringify({ dbUpdated, s3Deleted, ok: true }))
  await pool.end()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
