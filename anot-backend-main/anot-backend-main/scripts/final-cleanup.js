#!/usr/bin/env node
'use strict'

/**
 * Final production database cleanup — deletes ALL test PHI, keeps one super admin.
 *
 * Usage (from anot-backend-main/anot-backend-main):
 *   node scripts/final-cleanup.js              # dry-run: show counts only
 *   node scripts/final-cleanup.js --confirm    # execute deletion
 *
 * Production (loads DATABASE_URL from SSM when USE_SSM=true):
 *   USE_SSM=true SSM_PREFIX=/anot/prod node scripts/final-cleanup.js --confirm
 *
 * Preserved account: atiqurrahmanaline@gmail.com (super admin)
 * system_settings is NOT modified.
 */

const loadSecrets = require('../src/config/loadSecrets')

const SUPER_ADMIN_EMAIL = 'atiqurrahmanaline@gmail.com'

/** FK-safe purge order (audit_logs requires anot.allow_audit_purge GUC). */
const PURGE_TABLES = [
  'audit_logs',
  'grades',
  'notes',
  'sessions',
  'visits',
  'scribe_assignments',
]

const COUNT_TABLES = [
  'users',
  'patients',
  'visits',
  'notes',
  'grades',
  'audit_logs',
  'scribe_assignments',
]

function parseArgs(argv) {
  return { confirm: argv.includes('--confirm') }
}

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  )
  return rows.length > 0
}

async function countRows(client, tableName) {
  const { rows } = await client.query(`SELECT COUNT(*)::bigint AS c FROM ${tableName}`)
  return Number(rows[0].c)
}

async function collectCounts(client) {
  const counts = {}
  for (const table of COUNT_TABLES) {
    if (await tableExists(client, table)) {
      counts[table] = await countRows(client, table)
    }
  }
  return counts
}

async function fetchSuperAdmin(client) {
  const { rows } = await client.query(
    `SELECT id, email, role, status FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
    [SUPER_ADMIN_EMAIL],
  )
  return rows[0] || null
}

async function countUsersToRemove(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::bigint AS c FROM users WHERE LOWER(TRIM(email)) <> LOWER(TRIM($1))`,
    [SUPER_ADMIN_EMAIL],
  )
  return Number(rows[0].c)
}

function printSection(title) {
  console.log('')
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`)
}

async function runDryRun(pool) {
  printSection('Dry run (no changes)')
  console.log('Pass --confirm to delete test data.\n')

  const superAdmin = await fetchSuperAdmin(pool)
  if (!superAdmin) {
    console.error(`❌ Super admin not found: ${SUPER_ADMIN_EMAIL}`)
    console.error('   Abort — will not run cleanup without the preserved account.')
    process.exit(1)
  }

  console.log('Preserved super admin:')
  console.log(`  id=${superAdmin.id}  email=${superAdmin.email}  role=${superAdmin.role}  status=${superAdmin.status}`)

  const before = await collectCounts(pool)
  const usersToRemove = await countUsersToRemove(pool)

  printSection('Rows that would be deleted')
  for (const table of PURGE_TABLES) {
    if (before[table] != null) {
      console.log(`  ${table}: ${before[table]}`)
    } else {
      console.log(`  ${table}: (table not present — skipped)`)
    }
  }
  console.log(`  users (test accounts): ${usersToRemove}`)
  if (before.patients != null) {
    console.log(`  patients: ${before.patients}`)
  }

  printSection('Would remain after cleanup')
  console.log(`  users: 1 (${SUPER_ADMIN_EMAIL})`)
  console.log('  patients: 0')
  console.log('  visits: 0')
  console.log('  notes: 0')
  console.log('  grades: 0')
}

async function runCleanup(pool) {
  printSection('Executing cleanup')

  const superAdminBefore = await fetchSuperAdmin(pool)
  if (!superAdminBefore) {
    console.error(`❌ Super admin not found: ${SUPER_ADMIN_EMAIL}`)
    console.error('   Abort — refusing to delete users without a preserved super admin.')
    process.exit(1)
  }

  const before = await collectCounts(pool)
  console.log('Before:', JSON.stringify(before))

  const deleted = {}
  const { withTransaction } = require('../src/config/db')

  await withTransaction(async (client) => {
    for (const table of PURGE_TABLES) {
      if (!(await tableExists(client, table))) {
        deleted[table] = 0
        continue
      }
      if (table === 'audit_logs') {
        await client.query(`SET LOCAL anot.allow_audit_purge = 'on'`)
      }
      const result = await client.query(`DELETE FROM ${table}`)
      deleted[table] = result.rowCount
    }

    const userResult = await client.query(
      `DELETE FROM users WHERE LOWER(TRIM(email)) <> LOWER(TRIM($1))`,
      [SUPER_ADMIN_EMAIL],
    )
    deleted.users_removed = userResult.rowCount

    if (await tableExists(client, 'patients')) {
      const patientResult = await client.query('DELETE FROM patients')
      deleted.patients = patientResult.rowCount
    } else {
      deleted.patients = 0
    }
  })

  const superAdminAfter = await fetchSuperAdmin(pool)
  if (!superAdminAfter) {
    console.error(`❌ Super admin missing after cleanup: ${SUPER_ADMIN_EMAIL}`)
    console.error('Deleted:', JSON.stringify(deleted))
    process.exit(1)
  }

  const after = await collectCounts(pool)

  printSection('Deleted')
  for (const [key, value] of Object.entries(deleted)) {
    console.log(`  ${key}: ${value}`)
  }

  printSection('Remaining')
  console.log(`  users: ${after.users ?? 0}`)
  if (after.users === 1) {
    console.log(`    → ${superAdminAfter.email} (${superAdminAfter.role})`)
  }
  console.log(`  patients: ${after.patients ?? 0}`)
  console.log(`  visits: ${after.visits ?? 0}`)
  console.log(`  notes: ${after.notes ?? 0}`)
  console.log(`  grades: ${after.grades ?? 0}`)
  console.log(`  audit_logs: ${after.audit_logs ?? 0}`)
  console.log(`  scribe_assignments: ${after.scribe_assignments ?? 0}`)

  console.log('')
  if (after.users === 1 && superAdminAfter.role === 'super_admin') {
    console.log('✅ Cleanup complete — super admin preserved.')
  } else {
    console.warn('⚠ Cleanup finished but verify remaining counts manually.')
  }

  return { deleted, after, super_admin: superAdminAfter }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  console.log('=== Anot final production database cleanup ===')
  console.log(`Target DB: ${process.env.DATABASE_URL ? '(DATABASE_URL set)' : '(from .env)'}`)
  console.log(`Mode: ${opts.confirm ? 'DELETE (--confirm)' : 'dry-run'}`)

  await loadSecrets()
  const pool = require('../src/config/db')
  await pool.query('SELECT 1')
  console.log('Database connection OK')

  try {
    if (!opts.confirm) {
      await runDryRun(pool)
      console.log('')
      console.log('To execute: node scripts/final-cleanup.js --confirm')
      return
    }

    await runCleanup(pool)
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch((err) => {
  console.error('final-cleanup failed:', err.message)
  process.exit(1)
})
