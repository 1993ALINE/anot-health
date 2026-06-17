// Provisions (or re-provisions) the masud@anot.health test account directly,
// bypassing the admin UI. Use this to verify the full first-login flow:
//   forced password change  -> PHI training acknowledgment -> dashboard.
//
// Schema notes (match the rest of this app):
//   - bcrypt hash is stored in users.password (NOT password_hash), cost 10
//   - account state lives in users.status ('active' / 'inactive')
//   - force_password_change / phi_training_* columns are ensured by
//     ensureUserProfileSchema() before we rely on them.
//
// Behavior:
//   - CLEAN SLATE: deletes any existing masud@anot.health row first, so the
//     account is always created fresh with a brand-new temp password.
//   - Generates a secure 16-char temp password via generateSecurePassword()
//     (guaranteed to satisfy the HIPAA complexity policy) and bcrypt-hashes it.
//   - INSERTs with force_password_change=true, phi_training_acknowledged=false,
//     status='active', phi_training_version=1.
//   - Prints the temp password to stdout EXACTLY ONCE for secure hand-off. It is
//     never stored in plaintext or written to the audit trail.
//
// Usage (from anot-backend-main/anot-backend-main):
//   Ensure DB connection env is set (DATABASE_URL, or DB_HOST/DB_PORT/DB_NAME/
//   DB_USER/DB_PASSWORD with DB_SSL=true for RDS), then:
//     node create-masud-final.js

const bcrypt = require('bcryptjs')
const pool = require('./src/config/db')
const { generateSecurePassword, validatePassword } = require('./src/utils/passwordPolicy')
const { ensureUserProfileSchema } = require('./src/utils/ensureUserProfileSchema')
const { auditLog, reportAuditFailure } = require('./src/utils/auditLogger')

const BCRYPT_COST = 10
const PHI_TRAINING_VERSION = 1

const ACCOUNT = {
  email: 'masud@anot.health',
  name: 'Masud',
  role: 'clinician',
}

async function createMasud() {
  // Make sure force_password_change + phi_training_* columns exist.
  await ensureUserProfileSchema()

  const email = ACCOUNT.email.trim().toLowerCase()

  // Generate a secure temp password and confirm it satisfies the policy before
  // we touch the database (so a generator regression never produces a weak hash).
  const tempPassword = generateSecurePassword(16)
  const pwCheck = validatePassword(tempPassword)
  if (!pwCheck.valid) {
    throw new Error(`Generated password failed policy validation: ${pwCheck.message}`)
  }
  const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_COST)

  const client = await pool.connect()
  let created
  try {
    await client.query('BEGIN')

    // Clean slate: remove any existing account so we always create fresh.
    const deleted = await client.query('DELETE FROM users WHERE email = $1 RETURNING id', [email])
    if (deleted.rows.length > 0) {
      console.log(`Removed existing account ${email} (id=${deleted.rows[0].id}) for a clean slate.`)
    }

    const insert = await client.query(
      `INSERT INTO users
         (name, email, password, role, status,
          force_password_change, phi_training_acknowledged, phi_training_version)
       VALUES ($1, $2, $3, $4, 'active', true, false, $5)
       RETURNING id, name, email, role, status`,
      [ACCOUNT.name, email, hashedPassword, ACCOUNT.role, PHI_TRAINING_VERSION],
    )
    created = insert.rows[0]

    // Append-only audit trail for the provisioning event (no secrets recorded).
    await auditLog(
      { id: null, name: 'Provisioning Script', role: 'system' },
      'USER_CREATED',
      'user',
      created.id,
      `Provisioned ${ACCOUNT.role} test account ${email} (force_password_change=true, phi_training_acknowledged=false)`,
      client,
      {
        module_key: 'user_management',
        action_category: 'create',
        metadata: {
          role: ACCOUNT.role,
          force_password_change: true,
          phi_training_acknowledged: false,
          phi_training_version: PHI_TRAINING_VERSION,
          replaced_existing: deleted.rows.length > 0,
          source: 'create-masud-final.js',
        },
      },
    ).catch(reportAuditFailure)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23503') {
      throw new Error(
        `${email} has linked clinical records (visits/notes/grades) and cannot be deleted for a clean slate. ` +
        'Remove or reassign those records first, or deactivate the account instead.',
      )
    }
    throw err
  } finally {
    client.release()
  }

  console.log('\n========================================================')
  console.log('  ANOT HEALTH — masud@anot.health PROVISIONED (one-time)')
  console.log('========================================================')
  console.log(`  Name:     ${created.name}`)
  console.log(`  Email:    ${created.email}`)
  console.log(`  Role:     ${created.role}`)
  console.log(`  Status:   ${created.status}`)
  console.log(`  Temp password (shown ONCE): ${tempPassword}`)
  console.log('--------------------------------------------------------')
  console.log('  ⚠️  Must change password on first login')
  console.log('  ⚠️  Must acknowledge PHI training before first access')
  console.log('========================================================\n')
}

createMasud()
  .catch((err) => {
    console.error('❌ Failed to provision masud@anot.health:', err.message)
    process.exitCode = 1
  })
  .finally(() => pool.end())
