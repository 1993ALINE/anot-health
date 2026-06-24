/**
 * Validate referential integrity before applying FK migration.
 * Usage: node scripts/validate-fk-integrity.js
 */
require('dotenv').config()
const pool = require('../src/config/db').pool || require('../src/config/db')

const checks = [
  { name: 'visits.clinician_id orphans', sql: `SELECT COUNT(*) AS n FROM visits v LEFT JOIN users u ON v.clinician_id = u.id WHERE u.id IS NULL` },
  { name: 'visits.scribe_id orphans', sql: `SELECT COUNT(*) AS n FROM visits v LEFT JOIN users u ON v.scribe_id = u.id WHERE v.scribe_id IS NOT NULL AND u.id IS NULL` },
  { name: 'notes.submitted_by orphans', sql: `SELECT COUNT(*) AS n FROM notes n LEFT JOIN users u ON n.submitted_by = u.id WHERE n.submitted_by IS NOT NULL AND u.id IS NULL` },
]

async function main() {
  let failed = false
  for (const c of checks) {
    const { rows } = await pool.query(c.sql)
    const n = parseInt(rows[0].n, 10)
    console.log(`${c.name}: ${n}`)
    if (n > 0) failed = true
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })