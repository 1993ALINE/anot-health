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
