#!/usr/bin/env node
/**
 * DEV-ONLY — disposable local/staging database seed script.
 *
 * Creates or updates known test accounts with documented passwords.
 * NEVER run this against production. Requires ALLOW_DEV_SEED=true or --force-dev-seed.
 *
 * Usage:
 *   ALLOW_DEV_SEED=true node scripts/seed-dev-users.js
 *   node scripts/seed-dev-users.js --force-dev-seed
 */

require('dotenv').config()
const bcrypt = require('bcryptjs')
const { getBcryptRounds } = require('../src/utils/bcryptCost')
const pool = require('../src/config/db')

const DEV_ACCOUNTS = [
  { email: 'clinician@dev.anot.local', password: 'DevClinician!2026', name: 'Dev Clinician', role: 'clinician', specialty: 'Internal Medicine' },
  { email: 'scribe@dev.anot.local', password: 'DevScribe!2026', name: 'Dev Scribe', role: 'scribe' },
  { email: 'qps@dev.anot.local', password: 'DevQps!2026', name: 'Dev QPS', role: 'qps' },
  { email: 'admin@dev.anot.local', password: 'DevAdmin!2026', name: 'Dev Admin', role: 'admin' },
  { email: 'superadmin@dev.anot.local', password: 'DevSuperAdmin!2026', name: 'Dev Super Admin', role: 'super_admin' },
]

function assertDevSeedAllowed() {
  const forced = process.argv.includes('--force-dev-seed')
  const allowed = process.env.ALLOW_DEV_SEED === 'true' || forced
  if (!allowed) {
    console.error('Refusing to run: set ALLOW_DEV_SEED=true or pass --force-dev-seed (DEV-ONLY script).')
    process.exit(1)
  }
  if (process.env.NODE_ENV === 'production' && !forced) {
    console.error('Refusing to run in NODE_ENV=production without --force-dev-seed.')
    process.exit(1)
  }
}

async function upsertDevUser(account) {
  const email = account.email.toLowerCase()
  const hash = await bcrypt.hash(account.password, getBcryptRounds())
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE users
       SET name = $1, password = $2, role = $3, specialty = $4, status = 'active',
           force_password_change = false, phi_training_acknowledged = true
       WHERE email = $5`,
      [account.name, hash, account.role, account.specialty || null, email],
    )
    return 'updated'
  }
  await pool.query(
    `INSERT INTO users (name, email, password, role, specialty, status, force_password_change, phi_training_acknowledged, phi_training_version)
     VALUES ($1, $2, $3, $4, $5, 'active', false, true, 1)`,
    [account.name, email, hash, account.role, account.specialty || null],
  )
  return 'created'
}

async function main() {
  assertDevSeedAllowed()
  console.warn('=== DEV-ONLY SEED — documented passwords below; never use in production ===')
  for (const account of DEV_ACCOUNTS) {
    const action = await upsertDevUser(account)
    console.log(`${action}: ${account.email} / ${account.password} (${account.role})`)
  }
  console.warn('=== End dev seed — rotate or delete these accounts outside local dev ===')
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Dev seed failed:', err.message)
    pool.end().finally(() => process.exit(1))
  })
