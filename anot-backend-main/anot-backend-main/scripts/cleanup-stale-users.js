/**
 * Delete a fixed list of stale test/dev users from the database (intended for
 * production RDS). Reads DB credentials from SSM Parameter Store the same way the
 * app does (src/config/loadSecrets.js), previews exactly what will be removed,
 * requires explicit confirmation, and verifies the user count before/after.
 *
 * ── USAGE (run from anot-backend-main/anot-backend-main, where node_modules live) ──
 *
 *   # Preview only — connects, lists matched users + dependents, writes NOTHING:
 *   node scripts/cleanup-stale-users.js --dry-run
 *
 *   # Execute the deletion (prompts: type DELETE to proceed):
 *   node scripts/cleanup-stale-users.js --live
 *
 *   # Live, non-interactive (CI) — skips the prompt:
 *   node scripts/cleanup-stale-users.js --live --yes
 *
 *   # Required to delete accounts NOT on the @dev.anot.local domain (see SAFETY):
 *   node scripts/cleanup-stale-users.js --live --allow-prod-domain
 *
 * ── CREDENTIALS / SSM ────────────────────────────────────────────────────────
 *   By default USE_SSM is forced on, so creds are pulled+decrypted from the SSM
 *   prefix (/anot/prod by default → DATABASE_URL, DB_PASSWORD, DB_HOST, …) using
 *   the EC2 instance profile, exactly like the running app. Override the prefix
 *   with SSM_PREFIX and the region with SSM_REGION/AWS_REGION. To test against a
 *   local .env instead, set USE_SSM=false (then it uses DATABASE_URL / DB_* from
 *   the env / .env). TLS verification is mandatory (PHI in transit) — the bundled
 *   Amazon RDS CA (certs/rds-global-bundle.pem) is used unless DB_SSL_CA is set.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 *   - This script only deletes the users in TARGET_EMAILS below — nothing else.
 *   - It does NOT delete clinical data (visits / notes / grades). If a target
 *     user still owns any such rows, the DELETE will hit a foreign-key constraint
 *     and the whole transaction rolls back (no partial deletes) — the preview
 *     reports those dependents so you can decide what to do.
 *   - audit_logs has no FK to users and is left untouched (HIPAA retention).
 *   - Accounts whose email is NOT on the @dev.anot.local dev domain are treated
 *     as "looks like a real account" and require the explicit --allow-prod-domain
 *     flag in --live mode. (admin/clinician/qps/scribe@dev.anot.local are the
 *     known seeded dev accounts; the @anot.health entries are NOT obviously test
 *     data — verify them before deleting.)
 *
 * Exit code: 0 on success (incl. dry-run), 1 on any failure / refusal.
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { Pool } = require('pg')

// Pull secrets from SSM by default (this targets prod RDS). Set USE_SSM=false to
// run against a local .env instead. Must happen before we build the pool.
if (process.env.USE_SSM == null || process.env.USE_SSM === '') {
  process.env.USE_SSM = 'true'
}
const loadSecrets = require('../src/config/loadSecrets')

// ── The users to delete (by email). Edit here; everything is case-insensitive. ──
const TARGET_EMAILS = [
  'admin@dev.anot.local',
  'aline@anot.health',
  'ahmed@anot.health',
  'clinician@dev.anot.local',
  'dave@anot.health',
  'levinsohn@anot.health',
  'rabi@anot.health',
  'ashiq@anot.health',
  'qps@dev.anot.local',
  'ashik@anot.health',
  'chowdhury@anot.health',
  'hridoy@anot.health',
  'scribe@dev.anot.local',
].map((e) => e.toLowerCase().trim())

// Emails on this domain are the known seeded dev accounts (see seed-dev-users.js).
const DEV_DOMAIN = '@dev.anot.local'

// ── Protected accounts that must NEVER be deleted (real production users). ──────
// Mirrors the KEEP list in cleanup-test-data.js. If any TARGET email resolves to
// one of these, the script aborts before touching the database.
const KEEP_ACCOUNTS = [
  'atiqur@anot.health',
  'ashikur@anot.health',
  'fahad@anot.health',
  'shahib@anot.health',
  'farhan@anot.health',
].map((e) => e.toLowerCase().trim())

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run') || args.has('-n')
const LIVE = args.has('--live')
const ASSUME_YES = args.has('--yes') || args.has('-y') || process.env.CONFIRM === 'YES'
const ALLOW_PROD_DOMAIN = args.has('--allow-prod-domain')

if (args.has('--help') || args.has('-h')) {
  console.log(
    'Usage: node scripts/cleanup-stale-users.js (--dry-run | --live) [--yes] [--allow-prod-domain]',
  )
  process.exit(0)
}

if (DRY_RUN === LIVE) {
  // Neither or both supplied — refuse rather than guess (this is destructive).
  console.error('Choose exactly one mode: --dry-run (preview) or --live (execute).')
  process.exit(1)
}

// ── DB connection (built AFTER loadSecrets hydrates process.env) ──────────────
const BUNDLED_RDS_CA = path.join(__dirname, '..', 'certs', 'rds-global-bundle.pem')

function buildSslConfig() {
  const explicit =
    process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA) ? process.env.DB_SSL_CA : null
  const caPath = explicit || (fs.existsSync(BUNDLED_RDS_CA) ? BUNDLED_RDS_CA : null)
  if (caPath) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
  }
  if (process.env.DB_SSL_NO_VERIFY === 'true') {
    console.warn(
      '⚠ TLS certificate verification is DISABLED (DB_SSL_NO_VERIFY=true). Encrypted but ' +
        'MITM-vulnerable — set DB_SSL_CA to the RDS CA bundle instead. Never in production.',
    )
    return { rejectUnauthorized: false }
  }
  // Fall back to Node's built-in trust store (RDS certs chain to Amazon roots).
  return { rejectUnauthorized: true }
}

function buildPool() {
  const useUrl = !!process.env.DATABASE_URL
  const sslEnabled =
    useUrl ||
    process.env.DB_SSL === 'true' ||
    !!process.env.DB_SSL_CA ||
    process.env.DB_SSL_NO_VERIFY === 'true' ||
    fs.existsSync(BUNDLED_RDS_CA)

  return new Pool(
    useUrl
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: buildSslConfig(),
          connectionTimeoutMillis: 15000,
        }
      : {
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          connectionTimeoutMillis: 15000,
          ...(sslEnabled ? { ssl: buildSslConfig() } : {}),
        },
  )
}

function dbLabel() {
  try {
    if (process.env.DATABASE_URL) {
      const u = new URL(process.env.DATABASE_URL)
      return `${u.hostname}${u.pathname}`
    }
    return `${process.env.DB_HOST || '(no host)'}/${process.env.DB_NAME || ''}`
  } catch {
    return '(unknown host)'
  }
}

function ts() {
  return new Date().toISOString()
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
  // 1) Load DB creds (SSM in prod, .env when USE_SSM=false).
  await loadSecrets()

  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    console.error(
      'No DB credentials available. With USE_SSM=true the SSM prefix must expose DATABASE_URL ' +
        'or DB_HOST/DB_*; with USE_SSM=false provide them via .env / environment.',
    )
    process.exit(1)
  }

  const pool = buildPool()

  console.log('\n🧹 Anot stale-user cleanup')
  console.log(`   When:     ${ts()}`)
  console.log(`   Database: ${dbLabel()}`)
  console.log(`   Mode:     ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`   Targets:  ${TARGET_EMAILS.length} email(s)`)
  console.log(`   Protected (KEEP — never deleted): ${KEEP_ACCOUNTS.join(', ')}\n`)

  try {
    // 2) Resolve which target emails actually exist in THIS database.
    const matched = await pool.query(
      `SELECT id, name, email, role, status, created_at
         FROM users
        WHERE LOWER(email) = ANY($1::text[])
        ORDER BY email`,
      [TARGET_EMAILS],
    )

    const foundEmails = matched.rows.map((r) => r.email.toLowerCase())
    const notFound = TARGET_EMAILS.filter((e) => !foundEmails.includes(e))

    // GUARD: never delete a protected production account. If any matched user is
    // on the KEEP list, abort immediately (before any write, in either mode).
    const protectedHits = matched.rows.filter((r) =>
      KEEP_ACCOUNTS.includes(r.email.toLowerCase()),
    )
    if (protectedHits.length > 0) {
      for (const r of protectedHits) {
        console.error(
          `FATAL: Target user ${r.email} is in the protected KEEP list and cannot be deleted. Aborting.`,
        )
      }
      await pool.end()
      return 1
    }

    if (matched.rows.length === 0) {
      console.log('No matching users found in this database — nothing to delete.')
      if (notFound.length) console.log(`   (Not present: ${notFound.join(', ')})`)
      await pool.end()
      return 0
    }

    // 3) Per-user dependent rows that would BLOCK a user delete (no FK cascade),
    //    plus audit_logs (no FK; reported for awareness, never deleted).
    const targetIds = matched.rows.map((r) => r.id)
    const deps = await pool.query(
      `SELECT u.id,
              (SELECT COUNT(*) FROM visits v WHERE v.clinician_id = u.id)::int          AS visits_as_clinician,
              (SELECT COUNT(*) FROM visits v WHERE v.scribe_id = u.id)::int             AS visits_as_scribe,
              (SELECT COUNT(*) FROM notes n WHERE n.submitted_by = u.id)::int           AS notes_submitted,
              (SELECT COUNT(*) FROM notes n WHERE n.locked_by = u.id)::int              AS notes_locked,
              (SELECT COUNT(*) FROM notes n WHERE n.ehr_uploaded_by = u.id)::int        AS notes_ehr_uploaded,
              (SELECT COUNT(*) FROM grades g WHERE g.qps_id = u.id)::int                AS grades_as_qps,
              (SELECT COUNT(*) FROM audit_logs a WHERE a.user_id = u.id)::int           AS audit_rows
         FROM users u
        WHERE u.id = ANY($1::int[])`,
      [targetIds],
    )
    const depById = new Map(deps.rows.map((r) => [r.id, r]))

    // 4) Preview.
    console.log(`Matched ${matched.rows.length} user(s) to delete:\n`)
    let blockedCount = 0
    let prodDomainCount = 0
    for (const u of matched.rows) {
      const d = depById.get(u.id) || {}
      const blockers =
        (d.visits_as_clinician || 0) +
        (d.visits_as_scribe || 0) +
        (d.notes_submitted || 0) +
        (d.notes_locked || 0) +
        (d.notes_ehr_uploaded || 0) +
        (d.grades_as_qps || 0)
      const isProdDomain = !u.email.toLowerCase().endsWith(DEV_DOMAIN)
      if (blockers > 0) blockedCount++
      if (isProdDomain) prodDomainCount++

      const created = u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : '?'
      console.log(
        `   - ${u.email}  [id=${u.id}, ${u.role}, ${u.status}, created ${created}]` +
          (isProdDomain ? '  ⚠ NON-DEV DOMAIN' : ''),
      )
      if (blockers > 0) {
        console.log(
          `       ↳ owns clinical data (blocks delete): ` +
            `visits(clinician=${d.visits_as_clinician}, scribe=${d.visits_as_scribe}), ` +
            `notes(submitted=${d.notes_submitted}, locked=${d.notes_locked}, ehr=${d.notes_ehr_uploaded}), ` +
            `grades(qps=${d.grades_as_qps})`,
        )
      }
      if (d.audit_rows > 0) {
        console.log(`       ↳ ${d.audit_rows} audit_logs row(s) — preserved (not deleted)`)
      }
    }

    if (notFound.length) {
      console.log(`\n   Not present in this DB (skipped): ${notFound.join(', ')}`)
    }

    const beforeCount = (await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n
    console.log(`\n   Total users currently in DB: ${beforeCount}`)

    // 5) Safety gates.
    if (prodDomainCount > 0) {
      console.log(
        `\n⚠ ${prodDomainCount} matched account(s) are NOT on the ${DEV_DOMAIN} dev domain ` +
          `(they look like real accounts). Verify these are truly stale before deleting.`,
      )
    }
    if (blockedCount > 0) {
      console.log(
        `⚠ ${blockedCount} matched account(s) still own clinical data. The delete is one ` +
          `transaction, so if any of these block, NOTHING is deleted (full rollback). This ` +
          `script will not delete visits/notes/grades for you.`,
      )
    }

    if (DRY_RUN) {
      console.log('\nDry run complete. No changes were made.')
      await pool.end()
      return 0
    }

    // ── LIVE ───────────────────────────────────────────────────────────────────
    if (prodDomainCount > 0 && !ALLOW_PROD_DOMAIN) {
      console.error(
        `\n❌ Refusing to delete ${prodDomainCount} non-${DEV_DOMAIN} account(s) without ` +
          `--allow-prod-domain. Re-run with that flag once you have verified the list. ` +
          `No changes made.`,
      )
      await pool.end()
      return 1
    }

    if (!ASSUME_YES) {
      const ok = await askConfirmation(
        `\nType DELETE to permanently remove the ${matched.rows.length} user(s) above, anything else to cancel: `,
      )
      if (!ok) {
        console.log('Cancelled. No changes made.')
        await pool.end()
        return 0
      }
    }

    // 6) Delete — single transaction (all-or-nothing). scribe_assignments cascade.
    const client = await pool.connect()
    let deleted = 0
    try {
      await client.query('BEGIN')
      console.log(`[${ts()}] BEGIN — deleting ${matched.rows.length} user(s)…`)
      const res = await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [targetIds])
      deleted = res.rowCount
      await client.query('COMMIT')
      console.log(`[${ts()}] COMMIT — ${deleted} user(s) deleted.`)
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      client.release()
      console.error(`\n[${ts()}] ❌ Deletion failed — transaction rolled back, no changes made.`)
      console.error(`   ${err.message}`)
      if (/foreign key|violates/i.test(err.message)) {
        console.error(
          '   ↳ A target user still owns clinical data (visits/notes/grades). Reassign or ' +
            'remove that data first; this script intentionally does not delete it.',
        )
      }
      await pool.end()
      return 1
    }
    client.release()

    // 7) Verify before/after counts.
    const afterCount = (await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n
    const expectedAfter = beforeCount - deleted
    console.log(`\nVerification: users before=${beforeCount}, deleted=${deleted}, after=${afterCount}`)

    const stillThere = await pool.query(
      'SELECT email FROM users WHERE LOWER(email) = ANY($1::text[]) ORDER BY email',
      [TARGET_EMAILS],
    )

    let ok = afterCount === expectedAfter && stillThere.rows.length === 0
    if (ok) {
      console.log('✅ Verified: counts reconcile and no target emails remain.')
    } else {
      console.error('❌ Verification mismatch:')
      console.error(`   expected after=${expectedAfter}, actual after=${afterCount}`)
      if (stillThere.rows.length) {
        console.error(`   still present: ${stillThere.rows.map((r) => r.email).join(', ')}`)
      }
    }

    await pool.end()
    return ok ? 0 : 1
  } catch (err) {
    console.error(`\n[${ts()}] ❌ ${err.message}`)
    await pool.end().catch(() => {})
    return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
