#!/usr/bin/env node
/**
 * Reset MFA enrollments for PHI-access roles.
 * Clears mfa_enabled, secrets, and recovery codes.
 *
 * Usage: node scripts/reset-mfa-enrollments.js
 */

require('dotenv').config()
const pool = require('../src/config/db')

const PHI_ROLES = ['clinician', 'scribe', 'qps', 'admin', 'super_admin']

async function main() {
  const before = await pool.query(
    `SELECT role, mfa_enabled, COUNT(*)::int AS n
       FROM users
      GROUP BY role, mfa_enabled
      ORDER BY role, mfa_enabled`,
  )
  console.log('BEFORE:', JSON.stringify(before.rows, null, 2))

  const upd = await pool.query(
    `UPDATE users
        SET mfa_enabled = false,
            mfa_secret = NULL,
            mfa_secret_encrypted = NULL,
            mfa_recovery_codes = '[]'::jsonb
      WHERE role = ANY($1::text[])`,
    [PHI_ROLES],
  )
  console.log(`Updated ${upd.rowCount} row(s)`)

  const after = await pool.query(
    `SELECT role, mfa_enabled, COUNT(*)::int AS n
       FROM users
      GROUP BY role, mfa_enabled
      ORDER BY role, mfa_enabled`,
  )
  console.log('AFTER:', JSON.stringify(after.rows, null, 2))

  const stillEnabled = await pool.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE mfa_enabled = true`,
  )
  const leftoverSecrets = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM users
      WHERE mfa_secret IS NOT NULL OR mfa_secret_encrypted IS NOT NULL`,
  )

  console.log(`Users with mfa_enabled=true: ${stillEnabled.rows[0].n}`)
  console.log(`Users with MFA secrets remaining: ${leftoverSecrets.rows[0].n}`)

  if (stillEnabled.rows[0].n === 0) {
    console.log('VERIFY OK: all users have mfa_enabled = false')
  } else {
    const bad = await pool.query(
      `SELECT id, email, role, mfa_enabled FROM users WHERE mfa_enabled = true`,
    )
    console.error('STILL ENABLED:', JSON.stringify(bad.rows, null, 2))
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
