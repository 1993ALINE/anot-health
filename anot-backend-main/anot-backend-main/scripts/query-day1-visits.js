#!/usr/bin/env node
'use strict'
require('dotenv').config()
const pool = require('../src/config/db')
async function main() {
  const patterns = await pool.query(`
    SELECT COUNT(*)::int as cnt, LEFT(mrn, 20) as mrn_prefix
    FROM patients GROUP BY LEFT(mrn, 20) ORDER BY cnt DESC LIMIT 20
  `)
  console.log('MRN prefixes:', JSON.stringify(patterns.rows, null, 2))

  const recent = await pool.query(`
    SELECT p.id, p.name, p.mrn, p.created_at::date as created_date
    FROM patients p ORDER BY p.created_at DESC LIMIT 20
  `)
  console.log('Recent patients:', JSON.stringify(recent.rows, null, 2))

  const visitCounts = await pool.query(`
    SELECT v.visit_date, COUNT(*)::int as visit_count
    FROM visits v GROUP BY v.visit_date ORDER BY v.visit_date DESC LIMIT 15
  `)
  console.log('Visit counts by date:', JSON.stringify(visitCounts.rows, null, 2))

  // Try common Day 1 patterns
  for (const pattern of ['LT-D1%', 'LOAD-D1%', 'DAY1%', 'LT-DAY1%', 'D1-%']) {
    const r = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM patients WHERE mrn LIKE $1`,
      [pattern]
    )
    if (r.rows[0].cnt > 0) console.log(`Pattern ${pattern}: ${r.rows[0].cnt} patients`)
  }

  // Nahid's clinician visits without audio
  const nahid = await pool.query(`SELECT id FROM users WHERE email = 'nahid@anot.health' LIMIT 1`)
  if (nahid.rows[0]) {
    const uid = nahid.rows[0].id
    const visits = await pool.query(`
      SELECT v.id, v.visit_date, v.visit_type, v.status, v.transcription_status,
             p.name as patient_name, p.mrn,
             (v.audio_path IS NOT NULL AND v.audio_path != '' AND v.audio_path != '[]') as has_audio
      FROM visits v
      JOIN patients p ON p.id = v.patient_id
      WHERE v.clinician_id = $1
      ORDER BY v.id
    `, [uid])
    console.log(`Nahid visits (${visits.rows.length} total):`)
    const noAudio = visits.rows.filter(v => !v.has_audio)
    console.log(`  Without audio: ${noAudio.length}`)
    console.log(`  With audio: ${visits.rows.length - noAudio.length}`)
    if (visits.rows.length <= 100) {
      console.log(JSON.stringify(visits.rows.map(v => ({
        id: v.id, patient: v.patient_name, mrn: v.mrn, date: v.visit_date,
        type: v.visit_type, status: v.status, tx: v.transcription_status, has_audio: v.has_audio
      })), null, 2))
    }
  }

  await pool.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
