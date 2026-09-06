/**
 * changePasswordGate — adaptive auth middleware for PUT /auth/change-password.
 *
 * The change-password endpoint must serve two distinct callers:
 *
 *  1. Forced first-login / admin-reset flow
 *     The user holds only a short-lived temporaryToken
 *     (require_password_change claim) issued at login.  The endpoint must
 *     accept this token without requiring the current password.
 *
 *  2. Self-service password change from inside the portal
 *     The user has a full session cookie and must supply their currentPassword.
 *
 * Problem with plain `protect` middleware:
 *   The browser always sends the session cookie alongside the Bearer token
 *   (credentials: 'include' is unconditional).  When the temporaryToken has
 *   expired, `protect` silently falls back to the session cookie, sets
 *   req.user to a regular session payload (no require_password_change claim),
 *   and the controller ends up requiring a currentPassword that the forced-
 *   change UI never collects — returning "Current and new password are required".
 *
 * Solution:
 *   When a temporaryToken is present in the request body we bypass `protect`
 *   and validate the token ourselves.  If the token is valid and carries the
 *   require_password_change claim we set req.user from it and continue.  If
 *   the DB user has force_password_change = true we accept the request even
 *   when the token has expired (the flag is the authoritative source of truth).
 *   If no temporaryToken is in the body we delegate to the normal protect
 *   middleware so the self-service portal flow still works.
 */

const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const { protect } = require('./auth')

const { extractBearerToken } = require('./auth')

/**
 * Resolve the target user for a forced-password-change request.
 *
 * Priority:
 *   1. Bearer temporaryToken with require_password_change claim (valid sig, any exp)
 *   2. Body temporaryToken with require_password_change claim (valid sig, any exp)
 *   3. DB flag: user looked up by the decoded (possibly expired) token id has
 *      force_password_change = true  →  still honour the request.
 *
 * Returns { userId, isForced } or null when the token is unusable.
 */
async function resolveForced(rawToken) {
  if (!rawToken) return null

  let decoded = null
  let tokenExpired = false

  // Try strict verify first (not expired, valid sig)
  try {
    decoded = jwt.verify(rawToken, process.env.JWT_SECRET)
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      tokenExpired = true
      // Decode without verification so we can still read the payload
      try {
        decoded = jwt.decode(rawToken)
      } catch (_) {
        return null
      }
    } else {
      // Invalid signature — reject
      return null
    }
  }

  if (!decoded || decoded.require_password_change !== true) {
    return null
  }

  const userId = decoded.id || decoded.userId
  if (!userId) return null

  if (!tokenExpired) {
    // Token is fully valid
    return { userId, decoded, isForced: true }
  }

  // Token expired — check the DB flag as the authoritative fallback
  try {
    const { rows } = await pool.query(
      'SELECT id, force_password_change FROM users WHERE id = $1',
      [userId]
    )
    const row = rows[0]
    if (row && row.force_password_change === true) {
      return { userId: row.id, decoded, isForced: true }
    }
  } catch (_) {}

  return null
}

async function changePasswordGate(req, res, next) {
  const bodyToken = (req.body || {}).temporaryToken
  const bearerToken = extractBearerToken(req.headers?.authorization)
  const rawToken = bodyToken || bearerToken

  // If there's a temporaryToken attempt, try the forced-change path first.
  if (rawToken) {
    try {
      const forced = await resolveForced(rawToken)
      if (forced) {
        // Attach a minimal req.user so the controller can read it.
        // The controller will re-verify and set isTemporaryPasswordChange itself.
        req.user = {
          ...(forced.decoded || {}),
          id: forced.userId,
          require_password_change: true,
        }
        return next()
      }
    } catch (_) {}
  }

  // Fall back to standard protect (self-service change inside the portal,
  // or a completely invalid/missing token).
  return protect(req, res, next)
}

module.exports = { changePasswordGate }
