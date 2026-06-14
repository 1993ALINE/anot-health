// ⚠️ TEMPORARY ENDPOINT — DELETE AFTER USE.
// One-off admin reset to clear atiqur's forced-password-change / PHI-training
// flags. Gated behind a shared secret (ADMIN_RESET_SECRET) so it can't be hit
// without the key. Remove this file and its mount in server.js once used.

const express = require('express')
const router = express.Router()
const pool = require('../config/db')

const TARGET_EMAIL = 'atiqur@anot.health'

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
        WHERE email = $1`,
      [TARGET_EMAIL]
    )

    if (result.rowCount === 0) {
      console.warn(`[admin-reset] No user found for email=${TARGET_EMAIL}; nothing updated.`)
      return res.status(404).json({ error: `No user found for ${TARGET_EMAIL}.` })
    }

    console.log(
      `[admin-reset] ✅ Reset flags for ${TARGET_EMAIL} (rows=${result.rowCount}) ` +
      `by ip=${req.clientIp || req.ip} at ${new Date().toISOString()}`
    )

    return res.json({
      success: true,
      message: `Reset force_password_change and phi_training_acknowledged for ${TARGET_EMAIL}.`,
      rowsUpdated: result.rowCount,
    })
  } catch (err) {
    console.error('[admin-reset] ❌ Reset failed:', err.message)
    return res.status(500).json({ error: 'Reset failed.' })
  }
})

module.exports = router
