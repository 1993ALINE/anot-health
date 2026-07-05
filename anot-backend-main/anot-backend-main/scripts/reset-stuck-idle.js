#!/usr/bin/env node
'use strict'
/** Run on EB: USE_SSM=true node reset-stuck-idle.js */
async function main() {
  await require('./src/config/loadSecrets').loadSecrets()
  delete require.cache[require.resolve('./src/config/db')]
  const pool = require('./src/config/db')
  const ids = [189,190,191,193,363,365,366,368,373,374,376,378,379,383,384,385,386,387,388,389,390,391,392,393,394,395]
  const before = await pool.query(
    'SELECT id, transcription_status FROM visits WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  )
  console.log('Before:', before.rows.map((r) => `${r.id}=${r.transcription_status}`).join(','))
  const r = await pool.query(
    'UPDATE visits SET transcription_status = $1 WHERE id = ANY($2::int[]) RETURNING id',
    ['idle', ids],
  )
  console.log('Reset count:', r.rowCount)
  await pool.end()
}
main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
