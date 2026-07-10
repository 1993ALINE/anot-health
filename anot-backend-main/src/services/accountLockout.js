'use strict'

const pool = require('../config/db')

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function getLockoutConfig() {
  return {
    maxAttempts: parsePositiveInt(process.env.ACCOUNT_LOCKOUT_MAX, 5),
    lockoutMinutes: parsePositiveInt(process.env.ACCOUNT_LOCKOUT_MINUTES, 30),
    windowMinutes: parsePositiveInt(process.env.ACCOUNT_LOCKOUT_WINDOW_MINUTES, 15),
  }
}

function isLocked(user) {
  if (!user?.locked_until) return false
  return new Date(user.locked_until).getTime() > Date.now()
}

function lockoutMessage(user) {
  const until = user?.locked_until ? new Date(user.locked_until) : null
  if (!until || until.getTime() <= Date.now()) {
    return 'Too many failed login attempts. Please try again later.'
  }
  const mins = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
  return `Account temporarily locked due to repeated failed login attempts. Try again in ${mins} minute(s).`
}

async function recordFailedLogin(userId) {
  const { maxAttempts, lockoutMinutes, windowMinutes } = getLockoutConfig()
  const { rows } = await pool.query(
    `UPDATE users SET
       failed_login_attempts = CASE
         WHEN last_failed_login_at IS NULL
           OR last_failed_login_at < NOW() - ($3::int * INTERVAL '1 minute')
         THEN 1
         ELSE failed_login_attempts + 1
       END,
       last_failed_login_at = NOW(),
       locked_until = CASE
         WHEN (
           CASE
             WHEN last_failed_login_at IS NULL
               OR last_failed_login_at < NOW() - ($3::int * INTERVAL '1 minute')
             THEN 1
             ELSE failed_login_attempts + 1
           END
         ) >= $2
         THEN NOW() + ($4::int * INTERVAL '1 minute')
         ELSE locked_until
       END
     WHERE id = $1
     RETURNING failed_login_attempts, locked_until`,
    [userId, maxAttempts, windowMinutes, lockoutMinutes],
  )
  return rows[0] || null
}

async function resetFailedLogins(userId) {
  await pool.query(
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_failed_login_at = NULL WHERE id = $1`,
    [userId],
  )
}

module.exports = {
  getLockoutConfig,
  isLocked,
  lockoutMessage,
  recordFailedLogin,
  resetFailedLogins,
}
