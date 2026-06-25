const pool = require('../config/db')
const { encryptString } = require('../utils/settingsEncryption')

/** One-time migration: encrypt any remaining plaintext MFA secrets at startup. */
async function encryptPlaintextMfaSecrets() {
    const { rows } = await pool.query(
        `SELECT id, mfa_secret FROM users
         WHERE mfa_secret IS NOT NULL AND mfa_secret <> ''
           AND (mfa_secret_encrypted IS NULL OR mfa_secret_encrypted = '')`
    )
    if (!rows.length) return

    let migrated = 0
    for (const row of rows) {
        const encrypted = encryptString(row.mfa_secret)
        if (!encrypted) {
            console.warn(`[encryptMfaSecrets] Skipped user ${row.id}: encryption key unavailable`)
            continue
        }
        await pool.query(
            'UPDATE users SET mfa_secret_encrypted = $1 WHERE id = $2',
            [encrypted, row.id]
        )
        migrated++
    }
    if (migrated > 0) {
        console.log(`[encryptMfaSecrets] Encrypted MFA secrets for ${migrated} user(s)`)
    }
}

module.exports = { encryptPlaintextMfaSecrets }
