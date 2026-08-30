const pool = require('../config/db')
const { invalidateUserAuthCache } = require('../middleware/auth')

/** Bump token_version so all outstanding JWTs for this user are rejected. */
async function incrementTokenVersion(userId) {
    await pool.query(
        'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1',
        [Number(userId)]
    )
    invalidateUserAuthCache(userId)
}

module.exports = { incrementTokenVersion }
