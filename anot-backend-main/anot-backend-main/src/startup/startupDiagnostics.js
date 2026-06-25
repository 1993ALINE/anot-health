'use strict'

/**
 * Pre-flight checks run at boot (after loadSecrets, before accepting traffic).
 * Logs actionable diagnostics to EB/CloudWatch when startup fails.
 */

const REQUIRED_ENV_KEYS = ['JWT_SECRET']

const PRODUCTION_REQUIRED_KEYS = [
  'JWT_SECRET',
  'DATABASE_URL',
]

const RECOMMENDED_SSM_KEYS = [
  'JWT_SECRET',
  'DATABASE_URL',
  'SETTINGS_ENCRYPTION_KEY',
  'ANTHROPIC_API_KEY',
  'CORS_ORIGINS',
  'SENTRY_DSN',
]

const MIN_JWT_SECRET_LENGTH = 32

function maskSecret(value) {
  if (!value || typeof value !== 'string') return '(unset)'
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`
}

function databaseConfigSummary() {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const u = new URL(process.env.DATABASE_URL)
      const db = u.pathname.replace(/^\//, '') || '(unknown)'
      return `DATABASE_URL → ${u.hostname}:${u.port || '5432'}/${db}`
    } catch {
      return 'DATABASE_URL → (invalid URL format)'
    }
  }
  const host = process.env.DB_HOST || '(unset)'
  const port = process.env.DB_PORT || '5432'
  const name = process.env.DB_NAME || '(unset)'
  const user = process.env.DB_USER || '(unset)'
  return `DB_* → ${user}@${host}:${port}/${name}`
}

function hasDatabaseConfig() {
  if (process.env.DATABASE_URL?.trim()) return true
  return !!(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER)
}

function validateDatabaseUrlFormat() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return { ok: true }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return {
      ok: false,
      message:
        'DATABASE_URL must start with postgresql:// or postgres://. ' +
        'Check SSM /anot/prod/DATABASE_URL and EB environment properties.',
    }
  }

  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    return {
      ok: false,
      message: 'DATABASE_URL is not a valid URL. Check for unescaped special characters in the password.',
    }
  }

  if (/sslmode=/i.test(url)) {
    console.warn(
      '[startup] DATABASE_URL contains sslmode= — db.js strips URL SSL params; TLS is configured in src/config/db.js instead.',
    )
  }

  return { ok: true }
}

function validateJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim()
  if (!secret) {
    return { ok: false, message: 'JWT_SECRET is required (set in SSM /anot/prod/JWT_SECRET or .env).' }
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    return {
      ok: false,
      message: `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (currently ${secret.length}).`,
    }
  }
  return { ok: true }
}

function validateRequiredEnv() {
  const isProduction = process.env.NODE_ENV === 'production'
  const required = isProduction ? PRODUCTION_REQUIRED_KEYS : [...REQUIRED_ENV_KEYS]
  if (!process.env.DATABASE_URL?.trim() && hasDatabaseConfig()) {
    // Style B discrete DB_* vars — ok for local dev.
  } else if (!required.includes('DATABASE_URL') && !hasDatabaseConfig()) {
    required.push('DATABASE_URL')
  }

  const missing = required.filter((key) => {
    const v = process.env[key]
    return v == null || String(v).trim() === ''
  })

  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `Missing required environment variable(s): ${missing.join(', ')}. ` +
        (process.env.USE_SSM === 'true'
          ? `Verify SSM prefix ${process.env.SSM_PREFIX || '/anot/prod'} and IAM GetParametersByPath permissions.`
          : 'Set them in .env or EB environment properties.'),
    }
  }

  const jwtCheck = validateJwtSecret()
  if (!jwtCheck.ok) return jwtCheck

  const dbFormat = validateDatabaseUrlFormat()
  if (!dbFormat.ok) return dbFormat

  if (!hasDatabaseConfig()) {
    return {
      ok: false,
      message: 'Database not configured — set DATABASE_URL or DB_HOST + DB_NAME + DB_USER.',
    }
  }

  return { ok: true }
}

function validateSsmHydration(secretsResult) {
  const useSsm = String(process.env.USE_SSM || '').toLowerCase() === 'true'
  if (!useSsm) return { ok: true }

  const loaded = secretsResult?.loaded || []
  if (loaded.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production'
    const prefix = process.env.SSM_PREFIX || '/anot/prod'
    const msg =
      `USE_SSM=true but no parameters were loaded from "${prefix}". ` +
      'Check the prefix, parameter names, and EC2 instance profile IAM (ssm:GetParametersByPath, kms:Decrypt).'
    if (isProduction && String(process.env.SSM_OPTIONAL || '').toLowerCase() !== 'true') {
      return { ok: false, message: msg }
    }
    console.warn(`[startup] ⚠ ${msg}`)
    return { ok: true }
  }

  const missingRecommended = RECOMMENDED_SSM_KEYS.filter((key) => {
    const v = process.env[key]
    return v == null || String(v).trim() === ''
  })
  if (missingRecommended.length > 0) {
    console.warn(
      `[startup] ⚠ SSM loaded ${loaded.length} parameter(s) but these recommended keys are still unset: ` +
        `${missingRecommended.join(', ')}`,
    )
  }

  return { ok: true }
}

function logRuntimeInfo() {
  console.log('[startup] ─── Runtime ───')
  console.log(`[startup] Node.js ${process.version}`)
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV || 'development'}`)
  console.log(`[startup] PORT=${process.env.PORT || '5000 (default)'}`)
  console.log(`[startup] BIND_HOST=${process.env.BIND_HOST || '0.0.0.0 (default)'}`)
  console.log(`[startup] USE_SSM=${process.env.USE_SSM || 'false'}`)
  if (process.env.USE_SSM === 'true') {
    console.log(`[startup] SSM_PREFIX=${process.env.SSM_PREFIX || '/anot/prod'}`)
    console.log(`[startup] SSM_REGION=${process.env.SSM_REGION || process.env.AWS_REGION || 'ap-southeast-1'}`)
  }
  console.log(`[startup] Database: ${databaseConfigSummary()}`)
  console.log(`[startup] JWT_SECRET=${maskSecret(process.env.JWT_SECRET?.trim())}`)
  if (process.env.DB_SSL_CA) {
    console.log(`[startup] DB_SSL_CA=${process.env.DB_SSL_CA}`)
  } else if (process.env.DB_SSL_NO_VERIFY === 'true') {
    console.warn('[startup] DB_SSL_NO_VERIFY=true — TLS cert verification disabled (not for production).')
  }
}

/**
 * Run all pre-flight checks. Throws on failure so bootstrap().catch exits the process.
 * @param {{ secretsResult?: { loaded: string[], source: string } }} opts
 */
async function runStartupDiagnostics(opts = {}) {
  logRuntimeInfo()

  const ssmCheck = validateSsmHydration(opts.secretsResult)
  if (!ssmCheck.ok) {
    throw new Error(ssmCheck.message)
  }

  const envCheck = validateRequiredEnv()
  if (!envCheck.ok) {
    throw new Error(envCheck.message)
  }

  console.log('[startup] ✅ Environment validation passed')
}

module.exports = {
  runStartupDiagnostics,
  validateRequiredEnv,
  validateJwtSecret,
  validateDatabaseUrlFormat,
  hasDatabaseConfig,
  logRuntimeInfo,
  MIN_JWT_SECRET_LENGTH,
}
