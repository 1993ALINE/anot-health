const pool = require('../config/db')
const { adminRequiresMfa, isMfaDisabled } = require('../services/mfaService')

async function enforceAdminMfa(req, res, next) {
  if (!req.user || isMfaDisabled()) return next()
  console.log('[enforceAdminMfa] checking MFA enrollment, MFA_DISABLED:', process.env.MFA_DISABLED)
  try {
    const { rows } = await pool.query(
      'SELECT role, mfa_enabled FROM users WHERE id = $1',
      [req.user.id]
    )
    const u = rows[0]
    if (u && adminRequiresMfa(u.role, u.mfa_enabled)) {
      return res.status(403).json({
        error: 'MFA setup required for PHI access.',
        code: 'MFA_REQUIRED',
      })
    }
  } catch (err) {
    return next(err)
  }
  return next()
}

module.exports = { enforceAdminMfa }