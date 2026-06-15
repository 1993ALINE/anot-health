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

    res.status(200).json({
      atiqur_exists: r.atiqur_count > 0,
      total_users: r.total_users,
      clinicians: r.clinicians,
      admins: r.admins,
      database: 'connected',
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
