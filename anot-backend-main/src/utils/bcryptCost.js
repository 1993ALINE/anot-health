'use strict'

/** HIPAA-aligned bcrypt cost (12+). Override with BCRYPT_ROUNDS for tests only. */
function getBcryptRounds() {
  const n = parseInt(String(process.env.BCRYPT_ROUNDS || '12'), 10)
  if (!Number.isFinite(n)) {
    return 12
  }
  return n
}

module.exports = { getBcryptRounds }
