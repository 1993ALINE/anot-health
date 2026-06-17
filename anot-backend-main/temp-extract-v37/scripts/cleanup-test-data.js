/**
 * Delete test data: removes every user EXCEPT a small allow-list of real
 * accounts, along with the visits / notes / grades / assignments that belong to
 * the removed (test) users. Runs inside a single transaction so it either fully
 * succeeds or fully rolls back.
 *
 * Usage (run from anot-backend-main/anot-backend-main, where .env + node_modules live):
 *
 *   # 1. Preview only — connects and prints what WOULD be deleted, writes nothing:
 *   node scripts/cleanup-test-data.js --dry-run
 *
 *   # 2. Real run — prompts for confirmation (type DELETE) before committing:
 *   node scripts/cleanup-test-data.js
 *
 *   # 3. Non-interactive run (e.g. CI) — skips the prompt:
 *   node scripts/cleanup-test-data.js --yes
 *
 *   # 4. Also purge audit_logs rows for the deleted users (off by default —
 *   #    audit logs are normally kept for HIPAA compliance):
 *   node scripts/cleanup-test-data.js --purge-audit
 *
 * Targeting a specific database (e.g. production RDS) — pass creds via env, do NOT
 * hardcode them here. Example (PowerShell), with TLS verification against the RDS
 * CA bundle (download from AWS: region-bundle.pem):
 *   $env:DB_HOST="anot-postgres.xxxxxxxx.ap-southeast-1.rds.amazonaws.com"
 *   $env:DB_PORT="5432"; $env:DB_NAME="anot"; $env:DB_USER="anot_app"
 *   $env:DB_PASSWORD="<password>"; $env:DB_SSL="true"
 *   $env:DB_SSL_CA="C:\path\to\ap-southeast-1-bundle.pem"
 *   node scripts/cleanup-test-data.js --dry-run
 * If you cannot supply the CA bundle, DB_SSL_NO_VERIFY=true encrypts without
 * verifying the cert (discouraged — MITM risk). Prefer DB_SSL_CA.
 *
 * Safety properties:
 *   - KEEP list is the source of truth: anything NOT in it is treated as test data.
 *   - Aborts if none of the KEEP accounts are found (guards against pointing at
 *     the wrong / empty database and wiping everything).
 *   - Shows a preview + the target DB host and requires explicit confirmation.
 *   - Single BEGIN/COMMIT/ROLLBACK transaction; any error rolls everything back.
 *   - audit_logs is append-only (DB trigger); it is preserved unless --purge-audit
 *     is passed, in which case only the deleted users' rows are removed via the
 *     sanctioned purge GUC, in a separate transaction.
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { Pool } = require('pg')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

// ── Accounts to KEEP. Everything else is deleted. ────────────────────────────
const KEEP_EMAILS = [
  'atiqur@anot.health',
  'ashikur@anot.health',
  'fahad@anot.health',
  'shahib@anot.health',
  'farhan@anot.health',
].map((e) => e.toLowerCase().trim())

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run') || args.has('-n')
const ASSUME_YES = args.has('--yes') || args.has('-y') || process.env.CONFIRM === 'YES'
const PURGE_AUDIT = args.has('--purge-audit')

if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node scripts/cleanup-test-data.js [--dry-run] [--yes] [--purge-audit]')
  process.exit(0)
}

// ── DB connection ────────────────────────────────────────────────────────────
// Credentials come from the environment (or the backend .env) — never hardcode
// them in this tracked file. To target production RDS, pass DB_HOST/DB_PORT/
// DB_NAME/DB_USER/DB_PASSWORD (or DATABASE_URL) at runtime; see the header.
if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
  console.error('Missing DATABASE_URL (or DB_* vars). Add a .env in the backend folder or pass them at runtime.')
  process.exit(1)
}

// TLS: verify the server certificate by default (the connection carries PHI, so
// an unverified cert exposes it to MITM). Provide DB_SSL_CA (path to the RDS CA
// bundle, e.g. ap-southeast-1-bundle.pem) to verify against AWS's CA. As a last
// resort, DB_SSL_NO_VERIFY=true encrypts without verifying — discouraged.
function buildSslConfig() {
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true }
  }
  if (process.env.DB_SSL_NO_VERIFY === 'true') {
    console.warn(
      '⚠ TLS certificate verification is DISABLED (DB_SSL_NO_VERIFY=true). The connection is ' +
        'encrypted but vulnerable to MITM. Set DB_SSL_CA to the RDS CA bundle to verify instead.',
    )
    return { rejectUnauthorized: false }
  }
  return { rejectUnauthorized: true }
}

const useUrl = !!process.env.DATABASE_URL
const sslEnabled =
  useUrl ||
  process.env.DB_SSL === 'true' ||
  !!process.env.DB_SSL_CA ||
  process.env.DB_SSL_NO_VERIFY === 'true'

const pool = new Pool(
  useUrl
    ? { connectionString: process.env.DATABASE_URL, ssl: buildSslConfig() }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ...(sslEnabled ? { ssl: buildSslConfig() } : {}),
      },
)

function dbLabel() {
  try {
    if (useUrl) {
      const u = new URL(process.env.DATABASE_URL)
      return `${u.hostname}${u.pathname}`
    }
    return `${process.env.DB_HOST}/${process.env.DB_NAME}`
  } catch {
    return '(unknown host)'
  }
}

function askConfirmation(promptText) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false)
      return
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(promptText, (answer) => {
      rl.close()
      resolve(answer.trim() === 'DELETE')
    })
  })
}

async function main() {
  console.log('\n🧹 Anot test-data cleanup')
  console.log(`   Database: ${dbLabel()}`)
  console.log(`   Keeping:  ${KEEP_EMAILS.join(', ')}`)
  console.log(`   Mode:     ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}\n`)

  // Guard: make sure the keep accounts actually exist in THIS database.
  const keepRows = await pool.query(
    'SELECT id, email FROM users WHERE LOWER(email) = ANY($1::text[])',
    [KEEP_EMAILS],
  )
  if (keepRows.rows.length === 0) {
    console.error(
      'Aborting: none of the KEEP accounts were found in this database. ' +
        'This usually means the connection points at the wrong/empty DB. No changes made.',
    )
    await pool.end()
    process.exit(1)
  }
  const missingKeep = KEEP_EMAILS.filter(
    (e) => !keepRows.rows.some((r) => r.email.toLowerCase() === e),
  )
  if (missingKeep.length) {
    console.warn(`⚠ Note: these KEEP emails were not found (nothing to keep for them): ${missingKeep.join(', ')}`)
  }

  // Resolve the users that will be deleted (everyone not in the keep list).
  const targetRows = await pool.query(
    `SELECT id, email, role, status
       FROM users
      WHERE LOWER(email) <> ALL($1::text[])
      ORDER BY role, email`,
    [KEEP_EMAILS],
  )
  const targetIds = targetRows.rows.map((r) => r.id)

  if (targetIds.length === 0) {
    console.log('✅ Nothing to delete — only the KEEP accounts exist. Done.')
    await pool.end()
    return
  }

  // Preview counts (read-only).
  const visitsRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM visits WHERE clinician_id = ANY($1::int[]) OR scribe_id = ANY($1::int[])',
    [targetIds],
  )
  const notesRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM notes
      WHERE visit_id IN (
        SELECT id FROM visits WHERE clinician_id = ANY($1::int[]) OR scribe_id = ANY($1::int[])
      )`,
    [targetIds],
  )
  const visitsToDelete = visitsRes.rows[0].n
  const notesToDelete = notesRes.rows[0].n

  console.log(`Will delete ${targetIds.length} user(s):`)
  for (const r of targetRows.rows) {
    console.log(`   - ${r.email}  (${r.role}, ${r.status})`)
  }
  console.log(`\nWill also delete ${visitsToDelete} visit(s) and ${notesToDelete} note(s) (plus their grades & assignments).`)
  console.log(`Audit logs: ${PURGE_AUDIT ? 'WILL purge rows for deleted users' : 'PRESERVED (compliance)'}\n`)

  if (DRY_RUN) {
    console.log('Dry run complete. No changes were made.')
    await pool.end()
    return
  }

  // Confirmation gate.
  if (!ASSUME_YES) {
    const ok = await askConfirmation('Type DELETE to permanently remove the above, anything else to cancel: ')
    if (!ok) {
      console.log('Cancelled. No changes made.')
      await pool.end()
      return
    }
  }

  // ── Destructive work, all in one transaction ───────────────────────────────
  const client = await pool.connect()
  let deletedUsers = 0
  let deletedVisits = 0
  let deletedNotes = 0
  try {
    await client.query('BEGIN')

    // Exact count of notes that will cascade-delete with the visits.
    const noteCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM notes
        WHERE visit_id IN (
          SELECT id FROM visits WHERE clinician_id = ANY($1::int[]) OR scribe_id = ANY($1::int[])
        )`,
      [targetIds],
    )
    deletedNotes = noteCountRes.rows[0].n

    // Grades authored by a test QPS on a RETAINED note would block the user
    // delete (grades.qps_id has no cascade) — remove them.
    await client.query('DELETE FROM grades WHERE qps_id = ANY($1::int[])', [targetIds])

    // Null out references to test users on RETAINED notes so the user delete
    // doesn't violate FK constraints (these notes belong to kept visits).
    await client.query('UPDATE notes SET submitted_by = NULL WHERE submitted_by = ANY($1::int[])', [targetIds])
    await client.query('UPDATE notes SET locked_by = NULL WHERE locked_by = ANY($1::int[])', [targetIds])
    await client.query('UPDATE notes SET ehr_uploaded_by = NULL WHERE ehr_uploaded_by = ANY($1::int[])', [targetIds])

    // Delete test visits. Cascades to their notes (notes.visit_id ON DELETE
    // CASCADE) and those notes' grades (grades.note_id ON DELETE CASCADE).
    const delVisits = await client.query(
      'DELETE FROM visits WHERE clinician_id = ANY($1::int[]) OR scribe_id = ANY($1::int[])',
      [targetIds],
    )
    deletedVisits = delVisits.rowCount

    // Delete the test users. Cascades scribe_assignments (ON DELETE CASCADE).
    const delUsers = await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [targetIds])
    deletedUsers = delUsers.rowCount

    await client.query('COMMIT')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* ignore */ }
    client.release()
    console.error('\n❌ Cleanup failed — transaction rolled back, no changes made.')
    console.error(err.message)
    await pool.end()
    process.exit(1)
  }
  client.release()

  console.log(`\n✅ ${deletedUsers} users deleted, ${deletedVisits} visits deleted, ${deletedNotes} notes deleted`)

  // ── Optional, separate audit purge (append-only table) ─────────────────────
  if (PURGE_AUDIT) {
    const auditClient = await pool.connect()
    try {
      await auditClient.query('BEGIN')
      // The append-only trigger only permits DELETE when this GUC is set.
      await auditClient.query("SET LOCAL anot.allow_audit_purge = 'on'")
      const delAudit = await auditClient.query(
        'DELETE FROM audit_logs WHERE user_id = ANY($1::int[])',
        [targetIds],
      )
      await auditClient.query('COMMIT')
      console.log(`🗑  ${delAudit.rowCount} audit log row(s) purged for deleted users.`)
    } catch (err) {
      try { await auditClient.query('ROLLBACK') } catch { /* ignore */ }
      console.error(`⚠ Audit purge skipped/failed (cleanup above still committed): ${err.message}`)
    } finally {
      auditClient.release()
    }
  } else {
    console.log('ℹ Audit logs preserved for compliance (re-run with --purge-audit to remove them).')
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  pool.end().catch(() => {})
  process.exit(1)
})
