#!/usr/bin/env node
/**
 * Reset MFA enrollments for PHI-access roles.
 * Clears mfa_enabled, secrets, and recovery codes.
 *
 * Usage:
 *   node scripts/reset-mfa-enrollments.js              # uses .env (local/dev)
 *   node scripts/reset-mfa-enrollments.js --production # loads /anot/prod/* from AWS SSM
 */

const { Pool } = require('pg')
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm')

const PHI_ROLES = ['clinician', 'scribe', 'qps', 'admin', 'super_admin']
const isProd = process.argv.includes('--production')

async function ssmGet(name, decrypt = true) {
  const region = process.env.AWS_REGION || process.env.SSM_REGION || 'ap-southeast-1'
  const client = new SSMClient({ region })
  const out = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
  )
  return out.Parameter?.Value || ''
}

async function createPool() {
  if (!isProd) {
    require('dotenv').config()
    return require('../src/config/db')
  }

  console.log('Loading production database credentials from SSM (/anot/prod)...')
  const host = await ssmGet('/anot/prod/DB_HOST')
  const user = await ssmGet('/anot/prod/DB_USER')
  const database = await ssmGet('/anot/prod/DB_NAME')
  const port = parseInt(await ssmGet('/anot/prod/DB_PORT', false), 10) || 5432
  const password = await ssmGet('/anot/prod/DB_PASSWORD')

  if (!host || !user || !database || !password) {
    throw new Error('Missing DB_HOST, DB_USER, DB_NAME, or DB_PASSWORD in SSM.')
  }

  console.log(`Connecting to ${host}:${port}/${database} as ${user}`)

  return new Pool({
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
  })
}

async function main() {
  const pool = await createPool()
  const ownPool = isProd

  try {
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
              mfa_method = NULL,
              mfa_destination = NULL
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
    const leftoverDest = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM users
        WHERE mfa_destination IS NOT NULL`,
    )

    console.log(`Users with mfa_enabled=true: ${stillEnabled.rows[0].n}`)
    console.log(`Users with MFA destination remaining: ${leftoverDest.rows[0].n}`)

    if (stillEnabled.rows[0].n === 0) {
      console.log('VERIFY OK: all users have mfa_enabled = false')
    } else {
      const bad = await pool.query(
        `SELECT id, email, role, mfa_enabled FROM users WHERE mfa_enabled = true`,
      )
      console.error('STILL ENABLED:', JSON.stringify(bad.rows, null, 2))
      process.exitCode = 1
    }
  } finally {
    await pool.end()
    if (!ownPool) {
      /* src/config/db pool is shared singleton — end() above is sufficient */
    }
  }
}

main().catch((err) => {
  console.error(err.message || err)
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout/i.test(String(err.message || err))) {
    console.error(
      'Production RDS is private. Run from the EB instance:\n' +
        '  eb ssh anot-backend-prod\n' +
        '  cd /var/app/current && node scripts/reset-mfa-enrollments.js --production',
    )
  }
  process.exitCode = 1
})
