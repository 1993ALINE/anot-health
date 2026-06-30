'use strict'

/**
 * Pre-flight checks run at boot (after loadSecrets, before accepting traffic).
 * Logs actionable diagnostics to EB/CloudWatch when startup fails.
 */

const { getEmailTransport, getTwilioClient } = require('../services/mfaDelivery')

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
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
]

const MIN_JWT_SECRET_LENGTH = 32

function maskSecret(value) {
  if (!value || typeof value !== 'string') return '(unset)'
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`
}

function hasDiscreteDbCredentials() {
  return !!(
    process.env.DB_HOST?.trim() &&
    process.env.DB_NAME?.trim() &&
    process.env.DB_USER?.trim() &&
    process.env.DB_PASSWORD != null &&
    String(process.env.DB_PASSWORD).length > 0
  )
}

function databaseConfigSummary() {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const u = new URL(process.env.DATABASE_URL)
      const db = u.pathname.replace(/^\//, '') || '(unknown)'
      return `DATABASE_URL → ${u.hostname}:${u.port || '5432'}/${db}`
    } catch {
      if (hasDiscreteDbCredentials()) {
        const port = process.env.DB_PORT || '5432'
        return `DB_* → ${process.env.DB_USER}@${process.env.DB_HOST}:${port}/${process.env.DB_NAME} (DATABASE_URL unparsable)`
      }
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
    if (hasDiscreteDbCredentials()) {
      console.warn(
        '[startup] DATABASE_URL is not parseable as a URL — using DB_HOST/DB_NAME/DB_USER/DB_PASSWORD instead. ' +
          'Consider URL-encoding the password in SSM /anot/prod/DATABASE_URL.',
      )
      return { ok: true }
    }
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

function isEmailDeliveryConfigured() {
  if (process.env.SENDGRID_API_KEY?.trim()) return true
  const host = process.env.SMTP_HOST?.trim() || process.env.EMAIL_HOST?.trim()
  const user = process.env.SMTP_USER?.trim() || process.env.EMAIL_USER?.trim()
  const pass = process.env.SMTP_PASS?.trim() || process.env.EMAIL_PASSWORD?.trim()
  return !!(host && user && pass)
}

function isSmsDeliveryConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
    process.env.TWILIO_AUTH_TOKEN?.trim() &&
    process.env.TWILIO_PHONE_NUMBER?.trim()
  )
}

/**
 * MFA codes require at least one delivery channel. Warns when misconfigured;
 * does not block boot unless MFA_DELIVERY_REQUIRED=true (production opt-in).
 */
function validateMfaDeliveryConfig() {
  const email = isEmailDeliveryConfigured()
  const sms = isSmsDeliveryConfigured()

  if (email) {
    console.log('[startup] MFA email delivery: configured')
  } else {
    console.warn(
      '[startup] ⚠ MFA email delivery not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS ' +
        '(or EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD, or SENDGRID_API_KEY).',
    )
  }

  if (sms) {
    console.log('[startup] MFA SMS delivery: configured')
  } else {
    console.warn(
      '[startup] ⚠ MFA SMS delivery not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.',
    )
  }

  if (!email && !sms) {
    const msg =
      'No MFA delivery channel is configured. Login MFA codes cannot be sent until email or SMS is set up.'
    const strict = String(process.env.MFA_DELIVERY_REQUIRED || '').toLowerCase() === 'true'
    if (strict || process.env.NODE_ENV === 'production') {
      return { ok: false, message: msg, email, sms }
    }
    console.warn(`[startup] ⚠ ${msg} (Set MFA_DELIVERY_REQUIRED=false to allow boot in production without MFA delivery.)`)
  }

  return { ok: true, email, sms }
}

/** Verify SMTP credentials with a lightweight connection check (nodemailer verify). */
async function verifySmtpConnection() {
  if (!isEmailDeliveryConfigured()) {
    return { ok: false, skipped: true }
  }

  const transport = getEmailTransport()
  if (!transport) {
    return { ok: false, message: 'Email transport could not be created from SMTP_* / EMAIL_* env vars.' }
  }

  try {
    await transport.verify()
    console.log('[startup] ✅ SMTP connection verified')
    return { ok: true }
  } catch (err) {
    const msg = `SMTP connection failed: ${err.message}`
    console.error(`[startup] ❌ ${msg}`)
    return { ok: false, message: msg }
  }
}

/** Verify Twilio credentials by fetching the account record. */
async function verifyTwilioCredentials() {
  if (!isSmsDeliveryConfigured()) {
    return { ok: false, skipped: true }
  }

  const client = getTwilioClient()
  if (!client) {
    return { ok: false, message: 'Twilio client could not be created from TWILIO_* env vars.' }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID?.trim()
  try {
    await client.api.accounts(sid).fetch()
    console.log('[startup] ✅ Twilio credentials verified')
    return { ok: true }
  } catch (err) {
    const msg = `Twilio credential check failed: ${err.message}`
    console.error(`[startup] ❌ ${msg}`)
    return { ok: false, message: msg }
  }
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

  const mfaDeliveryCheck = validateMfaDeliveryConfig()
  if (!mfaDeliveryCheck.ok) {
    throw new Error(mfaDeliveryCheck.message)
  }

  if (mfaDeliveryCheck.email && process.env.NODE_ENV === 'production') {
    const smtpCheck = await verifySmtpConnection()
    if (!smtpCheck.ok && !smtpCheck.skipped) {
      const strict = String(process.env.MFA_DELIVERY_VERIFY_STRICT || '').toLowerCase() === 'true'
      if (strict) {
        throw new Error(smtpCheck.message || 'SMTP connection verification failed.')
      }
      console.warn(
        `[startup] ⚠ ${smtpCheck.message || 'SMTP connection verification failed.'} ` +
          'MFA email codes will fail until credentials are fixed. Set MFA_DELIVERY_VERIFY_STRICT=true to block boot.',
      )
    }
  }

  if (mfaDeliveryCheck.sms && process.env.NODE_ENV === 'production') {
    const twilioCheck = await verifyTwilioCredentials()
    if (!twilioCheck.ok && !twilioCheck.skipped) {
      const strict = String(process.env.MFA_DELIVERY_VERIFY_STRICT || '').toLowerCase() === 'true'
      if (strict) {
        throw new Error(twilioCheck.message || 'Twilio credential verification failed.')
      }
      console.warn(
        `[startup] ⚠ ${twilioCheck.message || 'Twilio credential verification failed.'} ` +
          'MFA SMS codes will fail until credentials are fixed. Set MFA_DELIVERY_VERIFY_STRICT=true to block boot.',
      )
    }
  }

  if (process.env.NODE_ENV === 'production' && process.env.MFA_BYPASS) {
    throw new Error('MFA_BYPASS not allowed in production')
  }

  if (process.env.NODE_ENV === 'production') {
    const encKey = process.env.SETTINGS_ENCRYPTION_KEY?.trim()
    if (!encKey || encKey.length < 32) {
      throw new Error(
        'SETTINGS_ENCRYPTION_KEY must be set in production (≥32 chars). Store in SSM /anot/prod/SETTINGS_ENCRYPTION_KEY.',
      )
    }
    if (!process.env.SENTRY_DSN?.trim()) {
      console.warn('[startup] ⚠ SENTRY_DSN not set — error monitoring disabled in production.')
    }
  }

  console.log('[startup] ✅ Environment validation passed')
}

/** Alias used by server.js — same pre-flight checks before app.listen(). */
const validateStartupConfig = runStartupDiagnostics

module.exports = {
  runStartupDiagnostics,
  validateStartupConfig,
  verifySmtpConnection,
  verifyTwilioCredentials,
  validateRequiredEnv,
  validateJwtSecret,
  validateDatabaseUrlFormat,
  validateMfaDeliveryConfig,
  isEmailDeliveryConfigured,
  isSmsDeliveryConfigured,
  hasDatabaseConfig,
  hasDiscreteDbCredentials,
  logRuntimeInfo,
  MIN_JWT_SECRET_LENGTH,
}
