'use strict'

const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { auditLog } = require('../utils/auditLogger')
const { sendHttpError } = require('../utils/errorMessages')
const { isSuperAdmin } = require('../utils/roles')
const { invalidateUserAuthCache } = require('../middleware/auth')
const { SUPER_ADMIN_EMAIL } = require('./adminResetController')

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  )
  return rows.length > 0
}

function isProtectedSuperAdminEmail(email) {
  if (!email) return false
  return String(email).trim().toLowerCase() === String(SUPER_ADMIN_EMAIL).trim().toLowerCase()
}

/**
 * Super Admin only — permanently delete a non–super-admin user and cascade
 * related sessions / audit log rows for that user.
 * DELETE /api/admin/users/:userId
 */
const deleteAdminUser = async (req, res) => {
  try {
    if (!isSuperAdmin(req.user?.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const userId = parseInt(req.params.userId, 10)
    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user id.' })
    }

    if (userId === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete your own account.' })
    }

    const { rows } = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [userId],
    )
    const target = rows[0]
    if (!target) {
      return res.status(404).json({ error: 'User not found.' })
    }

    if (target.role === 'super_admin') {
      return res.status(403).json({ error: 'Super Admin accounts cannot be deleted.' })
    }

    if (isProtectedSuperAdminEmail(target.email)) {
      return res.status(403).json({ error: 'This account cannot be deleted.' })
    }

    await withTransaction(async (client) => {
      if (await tableExists(client, 'sessions')) {
        await client.query('DELETE FROM sessions WHERE user_id = $1', [userId])
      }

      if (await tableExists(client, 'audit_logs')) {
        await client.query(`SET LOCAL anot.allow_audit_purge = 'on'`)
        await client.query('DELETE FROM audit_logs WHERE user_id = $1', [userId])
      }

      const deleted = await client.query('DELETE FROM users WHERE id = $1', [userId])
      if (deleted.rowCount === 0) {
        const err = new Error('User not found.')
        err.statusCode = 404
        throw err
      }
    })

    invalidateUserAuthCache(userId)

    await auditLog(
      req.user,
      'USER_DELETED',
      'user',
      userId,
      `Permanently deleted: ${target.name}`,
      {
        req,
        module_key: 'admins',
        action_category: 'delete',
        status: 'critical',
      },
    ).catch(() => {})

    res.json({
      status: 'success',
      deleted_user_id: userId,
      message: `${target.name} has been permanently deleted.`,
    })
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message })
    }
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'This user has linked clinical records and cannot be deleted. Deactivate the account instead.',
      })
    }
    sendHttpError(res, 500, err, { context: 'admin.deleteUser', req })
  }
}

module.exports = {
  deleteAdminUser,
  isProtectedSuperAdminEmail,
  SUPER_ADMIN_EMAIL,
}
