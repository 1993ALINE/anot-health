// ⚠️ TEMPORARY ENDPOINT — DELETE AFTER USE.
// One-off admin reset to clear the forced-password-change / PHI-training flags
// for every user that still needs it. Gated behind a shared secret
// (ADMIN_RESET_SECRET) so it can't be hit without the key. Remove this file and
// its mount in server.js once used.

const express = require('express')
const router = express.Router()
const pool = require('../config/db')

// POST /api/admin-reset
router.post('/', async (req, res) => {
  const expected = process.env.ADMIN_RESET_SECRET
  if (!expected) {
    console.error('[admin-reset] ADMIN_RESET_SECRET is not configured; refusing request.')
    return res.status(503).json({ error: 'Reset endpoint is not configured.' })
  }

  // Accept the secret from a header or the JSON body.
  const provided = req.get('x-reset-key') || req.body?.secret || req.body?.key

  if (!provided || provided !== expected) {
    console.warn(`[admin-reset] Rejected reset attempt from ip=${req.clientIp || req.ip}`)
    return res.status(401).json({ error: 'Invalid or missing reset key.' })
  }

  try {
    const result = await pool.query(
      `UPDATE users
          SET force_password_change = false,
              phi_training_acknowledged = true
        WHERE force_password_change = true OR phi_training_acknowledged = false`
    )

    console.log(
      `[admin-reset] ✅ Reset ${result.rowCount} account(s) ` +
      `by ip=${req.clientIp || req.ip} at ${new Date().toISOString()}`
    )

    return res.json({
      success: true,
      message: `Reset ${result.rowCount} account(s).`,
      rowsUpdated: result.rowCount,
    })
  } catch (err) {
    console.error('[admin-reset] ❌ Reset failed:', err.message)
    return res.status(500).json({ error: 'Reset failed.' })
  }
})

module.exports = router
