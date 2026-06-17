/**
 * Seeds or updates fixed dev-only users (bcrypt passwords). For local / Neon dev DBs only.
 *
 * Safety: refuses to run unless ALLOW_DEV_SEED=true or --force-dev-seed is passed.
 *
 * Usage (from anot-backend-main/anot-backend-main):
 *   ALLOW_DEV_SEED=true node scripts/seed-dev-users.js
 *   node scripts/seed-dev-users.js --force-dev-seed
 */

const path = require('path')
const bcrypt = require('bcryptjs')
const { Pool } = require('pg')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const { isDisallowedPassword } = require('../src/utils/passwordPolicy')

const allowed =
  process.env.ALLOW_DEV_SEED === 'true' || process.argv.includes('--force-dev-seed')

if (!allowed) {
  console.error(
    'Refusing to seed: set ALLOW_DEV_SEED=true or pass --force-dev-seed (dev databases only).',
  )
  process.exit(1)
}

if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
  console.error('Missing DATABASE_URL (or DB_* vars). Add a .env in the backend folder.')
  process.exit(1)
}

/** Fixed dev accounts — use only on disposable dev data. */
const SEED_USERS = [
  {
    name: 'Dev Clinician',
    email: 'clinician@dev.anot.local',
    password: 'DevClinician!2026',
    role: 'clinician',
    specialty: 'Internal Medicine',
  },
  {
    name: 'Dev Scribe',
    email: 'scribe@dev.anot.local',
    password: 'DevScribe!2026',
    role: 'scribe',
    specialty: null,
  },
  {
    name: 'Dev QPS',
    email: 'qps@dev.anot.local',
    password: 'DevQps!2026',
    role: 'qps',
    specialty: null,
  },
  {
    name: 'Dev Admin',
    email: 'admin@dev.anot.local',
    password: 'DevAdmin!2026',
    role: 'admin',
    specialty: null,
  },
  {
    name: 'Dev Super Admin',
    email: 'superadmin@dev.anot.local',
    password: 'DevSuperAdmin!2026',
    role: 'super_admin',
    specialty: null,
  },
]

for (const u of SEED_USERS) {
  if (isDisallowedPassword(u.password)) {
    console.error(`Seed password for ${u.email} is disallowed by policy. Change SEED_USERS.`)
    process.exit(1)
  }
}

const useUrl = !!process.env.DATABASE_URL
const pool = new Pool(
  useUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: true },
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
      },
)

async function main() {
  console.log('Seeding dev users…\n')

  for (const u of SEED_USERS) {
    const email = u.email.toLowerCase().trim()
    const hash = await bcrypt.hash(u.password, 10)
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email])

    if (existing.rows.length) {
      await pool.query(
        `UPDATE users
         SET password = $1, name = $2, role = $3, specialty = $4, status = 'active'
         WHERE email = $5`,
        [hash, u.name.trim(), u.role, u.specialty || null, email],
      )
      console.log(`  updated  ${email} (${u.role})`)
    } else {
      await pool.query(
        `INSERT INTO users (name, email, password, role, specialty, phone, npi, license, status)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, 'active')`,
        [u.name.trim(), email, hash, u.role, u.specialty || null],
      )
      console.log(`  created  ${email} (${u.role})`)
    }
  }

  console.log('\n── Dev logins (rotate or delete before any real deployment) ──')
  for (const u of SEED_USERS) {
    console.log(`  ${u.email}`)
    console.log(`    password: ${u.password}`)
    console.log(`    role:     ${u.role}\n`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  pool.end().catch(() => {})
  process.exit(1)
})
