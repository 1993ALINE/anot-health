/** Legacy TOTP secret encryption — no-op after email/SMS MFA migration. */
async function encryptPlaintextMfaSecrets() {
    console.log('[encryptMfaSecrets] TOTP secrets removed — skipping legacy encryption migration')
}

module.exports = { encryptPlaintextMfaSecrets }
