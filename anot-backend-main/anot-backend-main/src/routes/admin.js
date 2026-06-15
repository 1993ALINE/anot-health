const express = require('express')
const router = express.Router()
const pool = require('../config/db')
const { protect, restrict } = require('../middleware/auth')

// ─── TEMPORARY DIAGNOSTIC ENDPOINT ────────────────────────────────────────────
// GET /api/admin/diagnostics
// Lets a super-admin inspect production DB state through the working CloudFront
// → backend → RDS path (the only path that can reach RDS right now).
//
// TEMPORARY: remove this route once the production DB connectivity is sorted.
router.get('/diagnostics', protect, restrict('super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_users,
        COUNT(*) FILTER (WHERE role = 'clinician')::int                      AS clinicians,
        COUNT(*) FILTER (WHERE role IN ('admin', 'super_admin'))::int        AS admins,
        COUNT(*) FILTER (WHERE LOWER(email) = LOWER($1))::int                AS atiqur_count
      FROM users
    `, ['atiqur@anot.health'])

    const r = rows[0]

    // Inspect fahad's specific record so we can confirm, through the known-good
    // CloudFront → backend → RDS path, that the PHI-training columns are set.
    // The columns are selected only if they exist, so the endpoint never 500s
    // on a database that has not been migrated yet.
    const FAHAD_EMAIL = 'fahad@anot.health'
    const { rows: colRows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN ('phi_training_acknowledged', 'phi_training_version')
    `)
    const presentCols = new Set(colRows.map((c) => c.column_name))
    const hasPhiAck = presentCols.has('phi_training_acknowledged')
    const hasPhiVersion = presentCols.has('phi_training_version')

    const fahadCols = ['id', 'email', 'role']
    if (hasPhiAck) fahadCols.push('phi_training_acknowledged')
    if (hasPhiVersion) fahadCols.push('phi_training_version')

    const { rows: fahadRows } = await pool.query(
      `SELECT ${fahadCols.join(', ')} FROM users WHERE LOWER(email) = LOWER($1)`,
      [FAHAD_EMAIL],
    )

    const fahadRow = fahadRows[0]
    const fahad = {
      exists: Boolean(fahadRow),
      id: fahadRow ? fahadRow.id : null,
      email: fahadRow ? fahadRow.email : null,
      role: fahadRow ? fahadRow.role : null,
      phi_training_acknowledged: hasPhiAck
        ? (fahadRow ? fahadRow.phi_training_acknowledged : null)
        : '(column missing)',
      phi_training_version: hasPhiVersion
        ? (fahadRow ? fahadRow.phi_training_version : null)
        : '(column missing)',
    }

    res.status(200).json({
      atiqur_exists: r.atiqur_count > 0,
      total_users: r.total_users,
      clinicians: r.clinicians,
      admins: r.admins,
      database: 'connected',
      fahad,
    })
  } catch (err) {
    console.error('Admin diagnostics error:', err.message)
    res.status(500).json({
      database: 'error',
      error: err.message,
    })
  }
})

module.exports = router
