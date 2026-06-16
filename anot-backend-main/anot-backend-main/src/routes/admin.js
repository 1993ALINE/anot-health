// ─── TEMPORARY: one-shot test-data cleanup endpoint ────────────────────────────
//
// POST /api/admin/cleanup-test-users   (super_admin only, body: { confirm: true })
//
// This is a deliberately TEMPORARY utility so the test-data cleanup can run from
// inside the Elastic Beanstalk app (which can reach RDS) instead of from a laptop
// that has no network path to the private database. It mirrors the safe logic in
// scripts/cleanup-test-data.js:
//
//   1. Requires a valid super_admin session (protect + restrict).
//   2. Deletes every user EXCEPT the allow-list (atiqur, ashikur, fahad, shahib,
//      farhan), plus the visits / notes / grades / assignments that belong to the
//      removed test users — all inside ONE transaction (full commit or rollback).
//   3. PRESERVES audit_logs (HIPAA compliance) — nothing is purged from them.
//   4. Returns the count of deleted users (and related rows).
//   5. SELF-DESTRUCTS after the first successful run: it sets an in-memory guard,
//      writes a consumed-marker file, and deletes its own source file so a process
//      restart won't re-expose it. server.js mounts it defensively, so a missing
//      file after self-destruct never crashes startup.
//
// Once the cleanup has been run in production this file (and its mount line in
// server.js) should be removed in the next deploy.

const fs = require('fs')
const path = require('path')
const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')

// Accounts to KEEP. Everything else is treated as test data and removed.
const KEEP_EMAILS = [
  'atiqur@anot.health',
  'ashikur@anot.health',
  'fahad@anot.health',
  'shahib@anot.health',
  'farhan@anot.health',
].map((e) => e.toLowerCase().trim())

// Marker file persisted next to this module so the "already consumed" state
// survives a process restart even if the self-delete of the source file fails.
const CONSUMED_MARKER = path.join(__dirname, '.cleanup-test-users.consumed')

// In-memory guard for the lifetime of this process.
let consumed = false

function alreadyConsumed() {
  if (consumed) return true
  try {
    if (fs.existsSync(CONSUMED_MARKER)) {
      consumed = true
      return true
    }
  } catch (_) {
    /* if we can't read the marker, fall through to the in-memory guard only */
  }
  return false
}

function selfDestruct() {
  consumed = true
  // Best-effort persistent marker so a restart still refuses the endpoint.
  try {
    fs.writeFileSync(CONSUMED_MARKER, `consumed_at=${new Date().toISOString()}\n`)
  } catch (err) {
    console.warn('[cleanup-test-users] could not write consumed marker:', err.message)
  }
  // Best-effort removal of this route's source so a future restart can't reload
  // it. server.js mounts this router inside try/catch, so a missing file is safe.
  try {
    fs.unlinkSync(__filename)
    console.warn('[cleanup-test-users] endpoint self-destructed (source file removed).')
  } catch (err) {
    console.warn('[cleanup-test-users] could not remove source file:', err.message)
  }
}

router.use(protect)
router.use(restrict('super_admin'))

router.post('/cleanup-test-users', async (req, res) => {
  if (alreadyConsumed()) {
    return res.status(410).json({
      error: 'This one-time cleanup endpoint has already been used and is disabled.',
    })
  }

  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'Confirmation required. Send { "confirm": true } to proceed.',
    })
  }

  try {
    // Guard: make sure the KEEP accounts actually exist in THIS database, so we
    // never wipe everything by accidentally pointing at the wrong/empty DB.
    const keepRows = await pool.query(
      'SELECT id, email FROM users WHERE LOWER(email) = ANY($1::text[])',
      [KEEP_EMAILS],
    )
    if (keepRows.rows.length === 0) {
      return res.status(409).json({
        error:
          'Aborted: none of the KEEP accounts were found in this database. ' +
          'Refusing to delete anything.',
      })
    }

    // Resolve the test users to delete (everyone not in the keep list).
    const targetRows = await pool.query(
      `SELECT id, email, role, status
         FROM users
        WHERE LOWER(email) <> ALL($1::text[])
        ORDER BY role, email`,
      [KEEP_EMAILS],
    )
    const targetIds = targetRows.rows.map((r) => r.id)

    if (targetIds.length === 0) {
      // Nothing to do, but the endpoint is still single-use: consume it.
      selfDestruct()
      return res.json({
        ok: true,
        deletedUsers: 0,
        deletedVisits: 0,
        deletedNotes: 0,
        message: 'Nothing to delete — only the KEEP accounts exist. Endpoint disabled.',
      })
    }

    // ── Destructive work, all in one transaction ─────────────────────────────
    const client = await pool.connect()
    let deletedUsers = 0
    let deletedVisits = 0
    let deletedNotes = 0
    try {
      await client.query('BEGIN')

      // Exact count of notes that will cascade-delete with the test visits.
      const noteCountRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM notes
          WHERE visit_id IN (
            SELECT id FROM visits WHERE clinician_id = ANY($1::int[]) OR scribe_id = ANY($1::int[])
          )`,
        [targetIds],
      )
      deletedNotes = noteCountRes.rows[0].n

      // Grades authored by a test QPS on a RETAINED note would block the user
      // delete (grades.qps_id has no cascade) — remove them first.
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
      // audit_logs is append-only and is intentionally left untouched.
      const delUsers = await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [targetIds])
      deletedUsers = delUsers.rowCount

      await client.query('COMMIT')
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (_) { /* ignore */ }
      client.release()
      console.error('[cleanup-test-users] failed — rolled back:', err.message)
      return res.status(500).json({ error: 'Cleanup failed; transaction rolled back. No changes made.' })
    }
    client.release()

    // Record the action in the (preserved) audit trail.
    try {
      await auditLog(
        req.user,
        'TEST_USERS_CLEANUP',
        'users',
        null,
        `Deleted ${deletedUsers} test user(s), ${deletedVisits} visit(s), ${deletedNotes} note(s). Audit logs preserved.`,
        { req, action_category: 'delete', metadata: { deletedUsers, deletedVisits, deletedNotes } },
      )
    } catch (err) {
      reportAuditFailure(err)
    }

    // Disable the endpoint now that it has run successfully.
    selfDestruct()

    return res.json({
      ok: true,
      deletedUsers,
      deletedVisits,
      deletedNotes,
      auditLogsPreserved: true,
      message: 'Test users removed. This one-time endpoint is now disabled.',
    })
  } catch (err) {
    console.error('[cleanup-test-users] error:', err.message)
    return res.status(500).json({ error: 'Cleanup failed.' })
  }
})

module.exports = router
