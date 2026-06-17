// ─── SSM SECRETS BOOTSTRAP ──────────────────────────────────────────────────
//
// WHY THIS FILE EXISTS (read this before touching anything):
//   In production (Elastic Beanstalk) we do NOT want secrets — DB password,
//   JWT_SECRET, SETTINGS_ENCRYPTION_KEY, API keys — baked into the EB
//   environment properties or a committed .env. Instead they live as encrypted
//   SecureString parameters under an SSM Parameter Store prefix (e.g.
//   /anot/prod/*). At boot we fetch them ONCE and hydrate process.env so the
//   rest of the app (db.js, settingsEncryption.js, server.js …) keeps reading
//   plain process.env exactly as it does today. Nothing downstream changes.
//
// THE GOLDEN RULE — ORDERING:
//   loadSecrets() MUST be awaited in server.js BEFORE the first require of any
//   module that reads process.env at import time (./config/db, ./instrument,
//   etc.). db.js calls dotenv.config() and builds a connection Pool the moment
//   it is required, so if SSM values aren't in process.env yet, it connects
//   with stale/empty creds. server.js is structured so this can't happen.
//
// LOCAL DEVELOPMENT (offline-friendly):
//   When USE_SSM is unset or "false" we skip AWS entirely and rely on the .env
//   file loaded by dotenv (same as before v40). No AWS credentials, no network
//   call — `npm run dev` works on a plane. This is the default.
//
// PRODUCTION:
//   Set USE_SSM=true (an EB environment property) plus the region/prefix. The
//   EC2 instance profile must grant ssm:GetParametersByPath + kms:Decrypt on
//   the parameters. We page through GetParametersByPath WithDecryption:true and
//   copy each parameter into process.env.
//
// CREDENTIALS (why we purge static keys in prod):
//   AWS authentication in production comes from the EC2 INSTANCE PROFILE attached
//   to the Elastic Beanstalk instances (role aws-elasticbeanstalk-ec2-role). The
//   AWS SDK default credential chain, however, checks STATIC env-var keys
//   (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN) and named
//   profiles (AWS_PROFILE) BEFORE the instance profile. A leftover IAM-user key
//   (e.g. the old "anot-s3-audio" S3 user) in the EB env or a bundled .env makes
//   every SDK call authenticate as THAT user, and SSM then fails with:
//     "User: arn:aws:iam::...:user/anot-s3-audio is not authorized to perform:
//      ssm:GetParametersByPath".
//   So when USE_SSM=true we strip those static credentials from process.env
//   (before creating any AWS client) and let the SDK use the instance profile.
//
// SECURITY:
//   We log the NAMES of the variables we loaded and a count — never the values.

const path = require('path')
const dotenv = require('dotenv')

// Always load .env first. In production the .env may be absent/minimal; that's
// fine — SSM fills the gaps below. Locally this is the whole story.
dotenv.config()

/**
 * Map an SSM parameter name to an environment variable name.
 * e.g. prefix "/anot/prod", param "/anot/prod/JWT_SECRET" -> "JWT_SECRET".
 * The leaf segment is used verbatim (we store params already named like env
 * vars, e.g. /anot/prod/DB_PASSWORD), so casing is preserved.
 */
/**
 * Remove static AWS credentials from process.env so the AWS SDK falls through to
 * the EC2 instance profile for EVERY client (SSM here, S3 in s3Storage.js, etc).
 * This runs at boot BEFORE any AWS client is constructed (loadSecrets is awaited
 * first in server.js), so it also neutralizes keys that arrived via a bundled
 * .env, not just EB environment properties.
 *
 * Escape hatch: AWS_KEEP_ENV_CREDENTIALS=true keeps the static keys (for a box
 * that legitimately must use them). Never logs credential values.
 *
 * @returns {string[]} names of the credential vars that were removed
 */
function purgeStaticAwsCredentials() {
  if (String(process.env.AWS_KEEP_ENV_CREDENTIALS || '').toLowerCase() === 'true') {
    console.warn(
      '[loadSecrets] AWS_KEEP_ENV_CREDENTIALS=true — keeping static AWS env credentials ' +
        '(the EC2 instance profile will NOT be forced).',
    )
    return []
  }

  const credentialVars = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_CREDENTIAL_PROFILES_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]

  const removed = []
  for (const name of credentialVars) {
    if (process.env[name] != null && process.env[name] !== '') {
      delete process.env[name]
      removed.push(name)
    }
  }

  if (removed.length > 0) {
    // Names only — never the secret values.
    console.warn(
      `[loadSecrets] Ignoring ${removed.length} static AWS credential var(s) so the EC2 ` +
        `instance profile is used for all AWS calls: ${removed.join(', ')}`,
    )
  } else {
    console.log('[loadSecrets] No static AWS credential env vars present — using the instance profile.')
  }
  return removed
}

function paramNameToEnvKey(fullName, prefix) {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  const leaf = fullName.startsWith(normalizedPrefix)
    ? fullName.slice(normalizedPrefix.length)
    : path.posix.basename(fullName)
  // Nested params (/anot/prod/group/KEY) collapse to GROUP_KEY.
  return leaf.replace(/\//g, '_')
}

/**
 * Fetch every SecureString/String under the SSM prefix and hydrate process.env.
 *
 * Behaviour:
 *   - USE_SSM !== "true"  -> no-op (local dev / offline). Returns immediately.
 *   - USE_SSM === "true"  -> pages through GetParametersByPath WithDecryption,
 *                            copies each value into process.env.
 *
 * Precedence: SSM is the source of truth in production, so by default fetched
 * values OVERWRITE anything already in process.env. Set SSM_NO_OVERRIDE=true to
 * keep pre-existing env vars (useful for one-off local overrides of a single
 * value while still pulling the rest from SSM).
 *
 * Failure policy: in production a failed fetch is FATAL (we exit non-zero so EB
 * restarts rather than booting with empty creds). Set SSM_OPTIONAL=true to
 * downgrade failures to a warning (e.g. a staging box without IAM perms yet).
 *
 * @returns {Promise<{loaded: string[], source: 'env'|'ssm'}>}
 */
async function loadSecrets() {
  const useSsm = String(process.env.USE_SSM || '').toLowerCase() === 'true'

  if (!useSsm) {
    console.log('[loadSecrets] USE_SSM not enabled — using .env / process environment only.')
    return { loaded: [], source: 'env' }
  }

  const region = process.env.SSM_REGION || process.env.AWS_REGION || 'ap-southeast-1'
  const prefix = process.env.SSM_PREFIX || '/anot/prod'
  const overwrite = String(process.env.SSM_NO_OVERRIDE || '').toLowerCase() !== 'true'

  console.log(`[loadSecrets] USE_SSM=true — loading parameters from "${prefix}" (region ${region})…`)

  // Force the instance profile: drop any static IAM-user keys (e.g. the old
  // anot-s3-audio S3 user) BEFORE the SSM client is created, otherwise the SDK
  // authenticates as that user and GetParametersByPath is denied.
  purgeStaticAwsCredentials()

  // Lazy-require the SDK so local/offline installs that never enable SSM don't
  // pay the import cost (and a missing dep can't crash dev boot).
  let SSMClient, GetParametersByPathCommand
  try {
    ({ SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm'))
  } catch (err) {
    return handleFailure(
      `@aws-sdk/client-ssm is not installed but USE_SSM=true (${err.message}). ` +
        'Run "npm install" with the v40 package.json.',
    )
  }

  const client = new SSMClient({ region })
  const loaded = []

  try {
    let nextToken
    do {
      const resp = await client.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: true,
          WithDecryption: true, // decrypt SecureString params via KMS
          MaxResults: 10, // SSM hard cap per page
          NextToken: nextToken,
        }),
      )

      for (const p of resp.Parameters || []) {
        const key = paramNameToEnvKey(p.Name, prefix)
        if (!key) continue
        if (!overwrite && process.env[key] != null && process.env[key] !== '') {
          // Respect an explicit pre-set value (SSM_NO_OVERRIDE mode).
          continue
        }
        process.env[key] = p.Value
        loaded.push(key)
      }

      nextToken = resp.NextToken
    } while (nextToken)
  } catch (err) {
    return handleFailure(`SSM fetch failed: ${err.message}`)
  }

  if (loaded.length === 0) {
    console.warn(
      `[loadSecrets] ⚠ No parameters found under "${prefix}". ` +
        'Check the prefix and that parameters exist + IAM allows GetParametersByPath.',
    )
  } else {
    // Names only — NEVER log secret values.
    console.log(
      `[loadSecrets] ✅ Loaded ${loaded.length} parameter(s) from SSM: ${loaded.sort().join(', ')}`,
    )
  }

  return { loaded, source: 'ssm' }
}

/**
 * Centralised failure handling. Fatal in production (so the supervisor restarts
 * rather than serving with bad config) unless SSM_OPTIONAL=true.
 */
function handleFailure(message) {
  const optional = String(process.env.SSM_OPTIONAL || '').toLowerCase() === 'true'
  if (optional) {
    console.warn(`[loadSecrets] ⚠ ${message} — SSM_OPTIONAL=true, continuing with .env values.`)
    return { loaded: [], source: 'env' }
  }
  console.error(`[loadSecrets] ❌ FATAL: ${message}`)
  console.error('[loadSecrets]    Set SSM_OPTIONAL=true to boot from .env instead (NOT for prod).')
  process.exit(1)
}

module.exports = loadSecrets
module.exports.loadSecrets = loadSecrets
