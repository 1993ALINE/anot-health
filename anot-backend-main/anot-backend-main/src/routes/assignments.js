const express = require('express')
const router  = express.Router()
const pool    = require('../config/db')
const { withTransaction } = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModulesIfAdmin } = require('../middleware/adminPortalModules')
const { logAdminPortalModuleAccess } = require('../middleware/adminPortalAudit')
const { auditLog } = require('../utils/auditLogger')

router.use(protect)
router.use(loadAdminPortalModuleKeys)

// ─── GET ALL ASSIGNMENTS ──────────────────────────────────────────────────────

router.get('/', restrict('admin', 'super_admin', 'scribe', 'qps', 'clinician'), requireAdminPortalModulesIfAdmin('overview', 'assignments'), logAdminPortalModuleAccess('assignments'), async (req, res) => {
  try {
    const base = `
      SELECT
        sa.id,
        sa.clinician_id,
        sa.scribe_id,
        sa.assigned_at,
        c.name     AS clinician_name,
        c.specialty AS clinician_specialty,
        s.name     AS scribe_name,
        s.email    AS scribe_email
      FROM scribe_assignments sa
      JOIN users c ON c.id = sa.clinician_id
      JOIN users s ON s.id = sa.scribe_id
    `
    const params = []
    let where = ''
    if (req.user.role === 'scribe') {
      params.push(req.user.id)
      where = ` WHERE sa.scribe_id = $${params.length}`
    } else if (req.user.role === 'clinician') {
      params.push(req.user.id)
      where = ` WHERE sa.clinician_id = $${params.length}`
    } else if (req.user.role === 'qps') {
      where = ` WHERE sa.clinician_id IN (
        SELECT DISTINCT v.clinician_id FROM notes n
        JOIN visits v ON v.id = n.visit_id
        WHERE n.status IN ('submitted','uploaded')
      )`
    }
    const result = await pool.query(
      `${base}${where} ORDER BY sa.assigned_at DESC`,
      params,
    )
    res.json({ assignments: result.rows })
  } catch (err) {
    console.error('Get assignments error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
})

// ─── CREATE ASSIGNMENT ────────────────────────────────────────────────────────

router.post('/', restrict('admin', 'super_admin'), requireAdminPortalModulesIfAdmin('assignments'), async (req, res) => {
  try {
    const { clinician_id, scribe_id } = req.body
    if (!clinician_id || !scribe_id) {
      return res.status(400).json({ error: 'Clinician and scribe are required.' })
    }

    // Single transaction so an assignment is never created without the visit
    // reassignment, and vice versa.
    const out = await withTransaction(async (client) => {
      const result = await client.query(`
        INSERT INTO scribe_assignments (clinician_id, scribe_id)
        VALUES ($1, $2) RETURNING *
      `, [clinician_id, scribe_id])

      const updated = await client.query(`
        UPDATE visits
        SET scribe_id = $1
        WHERE clinician_id = $2
          AND status NOT IN ('uploaded')
        RETURNING id
      `, [scribe_id, clinician_id])

      const full = await client.query(`
        SELECT
          sa.id, sa.clinician_id, sa.scribe_id, sa.assigned_at,
          c.name     AS clinician_name,
          c.specialty AS clinician_specialty,
          s.name     AS scribe_name,
          s.email    AS scribe_email
        FROM scribe_assignments sa
        JOIN users c ON c.id = sa.clinician_id
        JOIN users s ON s.id = sa.scribe_id
        WHERE sa.id = $1
      `, [result.rows[0].id])

      await auditLog(
        req.user,
        'SCRIBE_ASSIGNED',
        'assignment',
        String(result.rows[0].id),
        `${full.rows[0].scribe_name} assigned to ${full.rows[0].clinician_name} — ${updated.rowCount} visits updated`,
        client,
        { req, module_key: 'assignments', action_category: 'create', status: 'success' }
      )

      return { assignment: full.rows[0], visits_updated: updated.rowCount }
    })

    console.log(`✅ Updated ${out.visits_updated} existing visits to new scribe`)

    res.status(201).json(out)
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This scribe is already assigned to this clinician.' })
    }
    console.error('Create assignment error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
})

// ─── GET MY CLINICIANS (Scribe) — defined before /:id routes ----------------------------

router.get('/my-clinicians', restrict('scribe'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sa.clinician_id,
        c.name      AS clinician_name,
        c.specialty
      FROM scribe_assignments sa
      JOIN users c ON c.id = sa.clinician_id
      WHERE sa.scribe_id = $1
    `, [req.user.id])
    res.json({ clinicians: result.rows })
  } catch (err) {
    console.error('Get my clinicians error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
})

// ─── DELETE ASSIGNMENT ────────────────────────────────────────────────────────

router.delete('/:id', restrict('admin', 'super_admin'), requireAdminPortalModulesIfAdmin('assignments'), async (req, res) => {
  try {
    const assignment = await pool.query(`
      SELECT sa.*, c.name AS clinician_name, s.name AS scribe_name
      FROM scribe_assignments sa
      JOIN users c ON c.id = sa.clinician_id
      JOIN users s ON s.id = sa.scribe_id
      WHERE sa.id = $1
    `, [req.params.id])

    if (!assignment.rows[0]) {
      return res.status(404).json({ error: 'Assignment not found.' })
    }

    await pool.query('DELETE FROM scribe_assignments WHERE id = $1', [req.params.id])

    await auditLog(req.user, 'SCRIBE_UNASSIGNED', 'assignment', req.params.id,
      `${assignment.rows[0].scribe_name} removed from ${assignment.rows[0].clinician_name}`,
      { req, module_key: 'assignments', action_category: 'delete', status: 'warning' })

    res.json({ message: 'Assignment removed.' })
  } catch (err) {
    console.error('Delete assignment error:', err.message)
    res.status(500).json({ error: 'Server error.' })
  }
})

module.exports = router