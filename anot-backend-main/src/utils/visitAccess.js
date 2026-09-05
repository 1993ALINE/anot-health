const pool = require('../config/db')

// Centralized authorization for "can this user touch this visit?".
//
//   admin, super_admin, qps  → any visit
//   clinician   → only their own visits (visits.clinician_id = user.id)
//   scribe      → visits where they are the recorded scribe OR the clinician
//                 is currently assigned to them via scribe_assignments
//
// Returns the visit row when allowed, or null. Pass a transactional client
// to participate in an existing transaction (used with row locks in callers).
async function getVisitForUser(visitId, user, client = pool) {
  if (!user) return null
  const id = parseInt(visitId, 10)
  if (!Number.isInteger(id)) return null

  if (user.role === 'admin' || user.role === 'super_admin' || user.role === 'qps') {
    const r = await client.query('SELECT * FROM visits WHERE id = $1', [id])
    return r.rows[0] || null
  }

  if (user.role === 'clinician') {
    const r = await client.query(
      'SELECT * FROM visits WHERE id = $1 AND clinician_id = $2',
      [id, user.id]
    )
    return r.rows[0] || null
  }

  if (user.role === 'scribe') {
    const r = await client.query(
      `SELECT v.*
         FROM visits v
        WHERE v.id = $1
          AND (
            v.scribe_id = $2
            OR v.clinician_id IN (
              SELECT clinician_id FROM scribe_assignments WHERE scribe_id = $2
            )
            OR v.id IN (SELECT visit_id FROM notes WHERE submitted_by = $2)
          )`,
      [id, user.id]
    )
    return r.rows[0] || null
  }

  return null
}

module.exports = { getVisitForUser }
