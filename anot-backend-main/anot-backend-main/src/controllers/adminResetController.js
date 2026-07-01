'use strict'

/**
 * TEMPORARY: Super-admin-only test data purge.
 * Remove this controller (and src/routes/admin.js) when no longer needed.
 */

const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { auditLog } = require('../utils/auditLogger')
const { logServerError } = require('../utils/errorMessages')

const SUPER_ADMIN_EMAIL = 'atiqurrahmanaline@gmail.com'

/** Delete order respects FK constraints (grades → notes → visits → users). */
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

const resetDatabase = async (req, res) => {
  try {
    const deleted = {}

    await withTransaction(async (client) => {
      for (const table of PURGE_TABLES) {
        if (!(await tableExists(client, table))) continue
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
      }
    })

    const superAdmin = await pool.query(
      `SELECT id, email, role FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`,
      [SUPER_ADMIN_EMAIL],
    )
    if (!superAdmin.rows[0]) {
      return res.status(500).json({
        error: `Super admin (${SUPER_ADMIN_EMAIL}) missing after reset.`,
        deleted,
      })
    }

    const counts = {}
    for (const table of COUNT_TABLES) {
      if (await tableExists(pool, table)) {
        counts[table] = await countRows(pool, table)
      }
    }

    await auditLog(
      req.user,
      'DATABASE_RESET',
      'system',
      null,
      'Test data purge via POST /api/admin/reset-database',
      {
        req,
        status: 'critical',
        module_key: 'admin',
        action_category: 'delete',
        metadata: { deleted_row_counts: deleted, remaining_counts: counts },
      },
    ).catch((err) => console.warn('[admin] reset-database audit log failed:', err.message))

    console.warn(
      `[admin] DATABASE RESET by user ${req.user.id} — deleted:`,
      JSON.stringify(deleted),
    )

    res.json({
      status: 'success',
      message: 'Database reset',
      deleted,
      counts,
      super_admin: {
        id: superAdmin.rows[0].id,
        email: superAdmin.rows[0].email,
        role: superAdmin.rows[0].role,
      },
    })
  } catch (err) {
    logServerError('admin.resetDatabase', err, req)
    res.status(500).json({ error: err.message || 'Database reset failed.' })
  }
}

module.exports = { resetDatabase, SUPER_ADMIN_EMAIL }
