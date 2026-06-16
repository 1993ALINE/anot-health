#!/usr/bin/env node
/**
 * reencrypt-settings-key.js — rotate SETTINGS_ENCRYPTION_KEY safely.
 *
 * WHAT IT DOES
 *   The system_settings table stores third-party API keys encrypted with
 *   AES-256-GCM, where the key is SHA-256(SETTINGS_ENCRYPTION_KEY). Two columns
 *   hold ciphertext: deepgram_api_key_enc and anthropic_api_key_enc. When you
 *   rotate SETTINGS_ENCRYPTION_KEY (e.g. moving the secret into SSM, or a
 *   periodic rotation), every existing blob must be decrypted with the OLD key
 *   and re-encrypted with the NEW key — otherwise the app can no longer decrypt
 *   them and silently loses the saved keys.
 *
 * SAFETY MODEL (all-or-nothing)
 *   1. Runs inside a single DB transaction with SELECT … FOR UPDATE.
 *   2. Decrypts every blob with the OLD key first. If ANY blob fails to decrypt
 *      with the old key, we ROLLBACK and exit non-zero (wrong OLD key supplied —
 *      we must NOT write garbage).
 *   3. Re-encrypts with the NEW key, then VERIFIES the new ciphertext decrypts
 *      back to the exact original plaintext before committing. Any mismatch ->
 *      ROLLBACK.
 *   4. --dry-run does all of the above but ROLLBACKs at the end (no writes).
 *
 * USAGE
 *   Set DB connection env (DATABASE_URL or DB_*), then:
 *     OLD_SETTINGS_ENCRYPTION_KEY=<current> \
 *     NEW_SETTINGS_ENCRYPTION_KEY=<new>     \
 *     node scripts/reencrypt-settings-key.js [--dry-run]
 *
 *   On Windows PowerShell:
 *     $env:OLD_SETTINGS_ENCRYPTION_KEY="current"; `
 *     $env:NEW_SETTINGS_ENCRYPTION_KEY="new";     `
 *     node scripts/reencrypt-settings-key.js --dry-run
 *
 * IMPORTANT: deploy the NEW key to the running app (SSM) only AFTER this script
 * has committed successfully against the same database the app uses.
 */

const crypto = require('crypto')
const dotenv = require('dotenv')
dotenv.config()

// Reuse the app's pool so TLS-to-RDS policy is identical (verified TLS, CA
// bundle, sslmode stripping). It also gives us withTransaction().
const pool = require('../src/config/db')
const { withTransaction } = pool

const DRY_RUN = process.argv.includes('--dry-run')

// Columns that hold AES-256-GCM ciphertext in system_settings.
const ENCRYPTED_COLUMNS = ['deepgram_api_key_enc', 'anthropic_api_key_enc']

// ─── crypto (must match src/utils/settingsEncryption.js exactly) ────────────
function keyBuf(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey), 'utf8').digest()
}

function encryptString(plain, rawKey) {
  if (plain == null || String(plain).length === 0) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf(rawKey), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

// Throws on failure (wrong key / corrupt blob) so the caller can abort the txn.
function decryptStringStrict(blob, rawKey) {
  const buf = Buffer.from(String(blob), 'base64')
  if (buf.length < 28) throw new Error('ciphertext too short / not a valid blob')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf(rawKey), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

async function main() {
  const oldKey = process.env.OLD_SETTINGS_ENCRYPTION_KEY
  const newKey = process.env.NEW_SETTINGS_ENCRYPTION_KEY

  if (!oldKey) fail('OLD_SETTINGS_ENCRYPTION_KEY is required.')
  if (!newKey) fail('NEW_SETTINGS_ENCRYPTION_KEY is required.')
  if (oldKey === newKey) fail('OLD and NEW keys are identical — nothing to rotate.')

  console.log(`[reencrypt] Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will commit)'}`)
  console.log(`[reencrypt] Rotating columns: ${ENCRYPTED_COLUMNS.join(', ')}`)

  let rotated = 0
  let scanned = 0

  await withTransaction(async (client) => {
    // Lock the singleton row(s) for the duration of the rotation.
    const { rows } = await client.query(
      `SELECT id, ${ENCRYPTED_COLUMNS.join(', ')} FROM system_settings ORDER BY id FOR UPDATE`,
    )

    if (rows.length === 0) {
      console.log('[reencrypt] No system_settings rows found — nothing to do.')
      return
    }

    for (const row of rows) {
      const updates = {}

      for (const col of ENCRYPTED_COLUMNS) {
        const blob = row[col]
        if (!blob) continue // nothing stored in this column
        scanned++

        // 1) Decrypt with OLD key (strict — abort the whole txn on failure).
        let plaintext
        try {
          plaintext = decryptStringStrict(blob, oldKey)
        } catch (err) {
          throw new Error(
            `Row id=${row.id} column ${col}: decryption with OLD key failed (${err.message}). ` +
              'Wrong OLD_SETTINGS_ENCRYPTION_KEY? Aborting — no changes written.',
          )
        }

        // 2) Re-encrypt with NEW key.
        const newBlob = encryptString(plaintext, newKey)

        // 3) Verify round-trip with the NEW key before trusting it.
        const check = decryptStringStrict(newBlob, newKey)
        if (check !== plaintext) {
          throw new Error(
            `Row id=${row.id} column ${col}: re-encryption verification failed. Aborting.`,
          )
        }

        updates[col] = newBlob
        rotated++
        console.log(`[reencrypt] ✓ row id=${row.id} ${col} re-encrypted (len ${plaintext.length} chars)`)
      }

      const cols = Object.keys(updates)
      if (cols.length > 0) {
        const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
        const params = cols.map((c) => updates[c])
        params.push(row.id)
        await client.query(
          `UPDATE system_settings SET ${setSql}, updated_at = NOW() WHERE id = $${params.length}`,
          params,
        )
      }
    }

    if (DRY_RUN) {
      // Force a rollback so the transaction wrapper undoes everything.
      throw new DryRunRollback()
    }
  }).catch((err) => {
    if (err instanceof DryRunRollback) {
      console.log(
        `[reencrypt] DRY RUN complete — would have re-encrypted ${rotated}/${scanned} blob(s). Rolled back, no writes.`,
      )
      return
    }
    fail(err.message)
  })

  if (!DRY_RUN) {
    console.log(`[reencrypt] ✅ Done. Committed ${rotated} re-encrypted blob(s) across the table.`)
    console.log('[reencrypt]    Next: deploy NEW_SETTINGS_ENCRYPTION_KEY to the app (SSM) and restart.')
  }
}

// Sentinel used to trigger ROLLBACK in dry-run without signalling a real error.
class DryRunRollback extends Error {}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Unexpected error:', err.message)
    pool.end().finally(() => process.exit(1))
  })
