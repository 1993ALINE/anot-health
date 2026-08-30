#!/usr/bin/env node
/**
 * Apply SQL migrations from migrations/ in filename order.
 * Tracks applied files in schema_migrations so re-runs are idempotent.
 *
 * Usage:
 *   npm run migrate
 *   npm run migrate:prod
 */

const fs = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations')
const ROLLBACK_SUFFIX = '_rollback.sql'

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`)
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith(ROLLBACK_SUFFIX))
    .sort()
}

async function getAppliedFilenames(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations ORDER BY filename')
  return new Set(rows.map((row) => row.filename))
}

async function applyMigration(client, filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename)
  const sql = fs.readFileSync(filePath, 'utf8').trim()
  if (!sql) {
    console.log(`[migrate] Skipping empty file: ${filename}`)
    return
  }

  console.log(`[migrate] Applying ${filename} ...`)
  await client.query(sql)
  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename])
  console.log(`[migrate] Applied ${filename}`)
}

async function main() {
  const loadSecrets = require('../src/config/loadSecrets')
  await loadSecrets()

  const pool = require('../src/config/db')
  const files = listMigrationFiles()

  if (files.length === 0) {
    console.log('[migrate] No migration files found.')
    await pool.end()
    return
  }

  console.log(`[migrate] Found ${files.length} migration file(s).`)

  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedFilenames(client)

    let appliedCount = 0
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`[migrate] Already applied: ${filename}`)
        continue
      }
      await applyMigration(client, filename)
      appliedCount++
    }

    console.log(
      appliedCount === 0
        ? '[migrate] Database schema is up to date.'
        : `[migrate] Successfully applied ${appliedCount} migration(s).`,
    )
  } catch (err) {
    console.error('[migrate] Migration failed:', err.message)
    if (err.stack) console.error(err.stack)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[migrate] Unexpected error:', err.message)
  process.exit(1)
})
