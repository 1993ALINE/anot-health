'use strict'

const pool = require('../config/db')
const { withTransaction } = require('../config/db')
const { auditLog } = require('../utils/auditLogger')
const { sendHttpError } = require('../utils/errorMessages')
const { isSuperAdmin } = require('../utils/roles')
const { invalidateUserAuthCache } = require('../middleware/auth')
const { SUPER_ADMIN_EMAIL } = require('./adminResetController')

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  )
  const rows = result?.rows || []
  return Array.isArray(rows) && rows.length > 0
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tableName, columnName],
  )
  const rows = result?.rows || []
  return Array.isArray(rows) && rows.length > 0
}

function isProtectedSuperAdminEmail(email) {
  if (!email) return false
  return String(email).trim().toLowerCase() === String(SUPER_ADMIN_EMAIL).trim().toLowerCase()
}

/**
 * Super Admin & Admin — permanently delete a non–super-admin user and cascade
 * related records for that user.
 * DELETE /api/admin/users/:userId
 */
const deleteAdminUser = async (req, res) => {
  try {
    const caller = req.user
    const callerRole = caller?.role
    const userId = Number(req.params.userId)

    if (!userId || !Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Valid user ID is required.' })
    }

    if (callerRole !== 'super_admin' && callerRole !== 'admin') {
      return res.status(403).json({ error: 'Forbidden. Only administrators can delete users.' })
    }

    if (userId === caller.id) {
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

    if (callerRole === 'admin' && target.role === 'admin') {
      return res.status(403).json({ error: 'Only Super Admins can delete other administrator accounts.' })
    }

    await withTransaction(async (client) => {
      // 1. Scribe assignments (both clinician & scribe)
      if (await tableExists(client, 'scribe_assignments')) {
        await client.query('DELETE FROM scribe_assignments WHERE clinician_id = $1 OR scribe_id = $1', [userId])
      }

      // 2. Clinician templates (column is user_id)
      if (await tableExists(client, 'clinician_templates')) {
        await client.query('DELETE FROM clinician_templates WHERE user_id = $1', [userId])
      }

      // 3. MFA tokens and recovery usage
      if (await tableExists(client, 'mfa_tokens')) {
        await client.query('DELETE FROM mfa_tokens WHERE user_id = $1', [userId])
      }
      if (await tableExists(client, 'mfa_recovery_code_usage')) {
        await client.query('DELETE FROM mfa_recovery_code_usage WHERE user_id = $1', [userId])
      }

      // 4. User consents
      if (await tableExists(client, 'user_consents')) {
        await client.query('DELETE FROM user_consents WHERE user_id = $1', [userId])
      }

      // 5. Linked grades (column is qps_id)
      if (await tableExists(client, 'grades')) {
        if (await columnExists(client, 'grades', 'qps_id')) {
          await client.query('UPDATE grades SET qps_id = NULL WHERE qps_id = $1', [userId])
        }
      }

      // 6. Linked notes/visits: unlink or cascade clinician visits
      if (await tableExists(client, 'notes')) {
        if (await columnExists(client, 'notes', 'submitted_by')) {
          await client.query('UPDATE notes SET submitted_by = NULL WHERE submitted_by = $1', [userId])
        }
        if (await columnExists(client, 'notes', 'locked_by')) {
          await client.query('UPDATE notes SET locked_by = NULL WHERE locked_by = $1', [userId])
        }
        if (await columnExists(client, 'notes', 'ehr_uploaded_by')) {
          await client.query('UPDATE notes SET ehr_uploaded_by = NULL WHERE ehr_uploaded_by = $1', [userId])
        }
      }
      if (await tableExists(client, 'visits')) {
        if (await columnExists(client, 'visits', 'scribe_id')) {
          await client.query('UPDATE visits SET scribe_id = NULL WHERE scribe_id = $1', [userId])
        }
        if (target.role === 'clinician') {
          if (await tableExists(client, 'notes')) {
            if (await tableExists(client, 'grades')) {
              await client.query(
                'DELETE FROM grades WHERE note_id IN (SELECT n.id FROM notes n JOIN visits v ON n.visit_id = v.id WHERE v.clinician_id = $1)',
                [userId]
              )
            }
            if (await tableExists(client, 'qps_reviews')) {
              await client.query(
                'DELETE FROM qps_reviews WHERE note_id IN (SELECT n.id FROM notes n JOIN visits v ON n.visit_id = v.id WHERE v.clinician_id = $1)',
                [userId]
              )
            }
            await client.query(
              'DELETE FROM notes WHERE visit_id IN (SELECT id FROM visits WHERE clinician_id = $1)',
              [userId]
            )
          }
          await client.query('DELETE FROM visits WHERE clinician_id = $1', [userId])
        }
      }

      // 7. Active sessions
      if (await tableExists(client, 'sessions')) {
        await client.query('DELETE FROM sessions WHERE user_id = $1', [userId])
      }

      // 8. Permanently delete the user row
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
      `Permanently deleted ${target.role}: ${target.name}`,
      {
        req,
        module_key: 'admins',
        action_category: 'delete',
        status: 'critical',
        metadata: { deleted_role: target.role, deleted_email: target.email },
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
