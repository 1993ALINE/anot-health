const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
const dotenv = require('dotenv')
dotenv.config()

// CA bundle shipped inside the deploy artifact. On the EB Node.js platform the app
// lives at /var/app/current, so this resolves to .../certs/rds-global-bundle.pem
// without any download at runtime. DB_SSL_CA (if set) takes precedence.
const BUNDLED_RDS_CA = path.join(__dirname, '..', '..', 'certs', 'rds-global-bundle.pem')

// ─── TLS / SSL POLICY ─────────────────────────────────────────────────────────
// This connection carries PHI, so TLS is mandatory and the RDS server certificate
// MUST be verified (HIPAA §164.312(e): protect ePHI in transit AND authenticate
// the endpoint to prevent man-in-the-middle). We do NOT silently disable cert
// validation. Configuration, in order of preference:
//
//   DB_SSL_CA         Absolute path to the Amazon RDS CA bundle (PEM). Verifies
//                     the server cert against AWS's CA (rejectUnauthorized: true).
//                     The Docker image downloads this to /opt/rds/rds-ca.pem and
//                     sets DB_SSL_CA to it.
//   DB_SSL_NO_VERIFY  'true' => encrypt but skip cert verification. Escape hatch
//                     ONLY (e.g. local debugging); logs a loud warning. Never in prod.
//   (neither)         Default: verify against Node's built-in trust store
//                     (rejectUnauthorized: true). RDS certs chain to Amazon roots
//                     trusted by modern Node, so this also works — DB_SSL_CA just
//                     pins the exact CA and is the recommended production setting.
function databaseHostLooksLikeRds() {
  try {
    if (process.env.DATABASE_URL) {
      const host = new URL(process.env.DATABASE_URL).hostname.toLowerCase()
      return host.includes('.rds.amazonaws.com')
    }
  } catch {
    /* ignore malformed URL — validated earlier in startupDiagnostics */
  }
  const host = String(process.env.DB_HOST || '').toLowerCase()
  return host.includes('.rds.amazonaws.com')
}

function buildSslConfig() {
  if (process.env.DB_SSL_NO_VERIFY === 'true') {
    console.warn(
      '⚠ DB TLS certificate verification is DISABLED (DB_SSL_NO_VERIFY=true). The ' +
        'connection is encrypted but vulnerable to MITM. Set DB_SSL_CA to the RDS CA ' +
        'bundle to verify instead. Do NOT use this in production.',
    )
    return { rejectUnauthorized: false }
  }

  // Explicit CA path wins (when it actually exists). Otherwise use the bundled RDS
  // CA only when the target host is actually RDS — applying the Amazon CA to Neon
  // or other providers causes "unable to get local issuer certificate" at boot.
  const explicit =
    process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA) ? process.env.DB_SSL_CA : null
  const useBundledRdsCa =
    !explicit && databaseHostLooksLikeRds() && fs.existsSync(BUNDLED_RDS_CA)
  const caPath = explicit || (useBundledRdsCa ? BUNDLED_RDS_CA : null)
  if (caPath) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
  }
  // No CA file: verify against Node's built-in trust store (Neon, etc.).
  return { rejectUnauthorized: true }
}

// SSL-related query params embedded in DATABASE_URL (e.g. `?sslmode=require`,
// `rejectUnauthorized=false`) are parsed by pg-connection-string and silently
// override the explicit `ssl` object below — `sslmode=require` rebuilds its own
// ssl config and re-enables verification (the exact "self-signed certificate in
// certificate chain" error we hit), while `sslmode=no-verify`/`disable` would
// weaken TLS. We strip them all so this file is the single source of truth for
// TLS policy regardless of how the URL was provisioned.
const SSL_URL_PARAMS = ['sslmode', 'ssl', 'rejectunauthorized', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding']
function stripSslParams(connectionString) {
  try {
    const u = new URL(connectionString)
    for (const key of [...u.searchParams.keys()]) {
      if (SSL_URL_PARAMS.includes(key.toLowerCase())) u.searchParams.delete(key)
    }
    return u.toString()
  } catch {
    return connectionString
  }
}

function databaseUrlIsUsable() {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) return false
  if (!/^postgres(ql)?:\/\//i.test(url)) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

const useUrl = databaseUrlIsUsable()
const sslEnabled =
  useUrl ||
  process.env.DB_SSL === 'true' ||
  !!process.env.DB_SSL_CA ||
  process.env.DB_SSL_NO_VERIFY === 'true'

const pool = new Pool(
  useUrl
    ? {
        connectionString: stripSslParams(process.env.DATABASE_URL),
        ssl: buildSslConfig(),
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
      }
    : {
        host:     process.env.DB_HOST,
        port:     process.env.DB_PORT,
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        ...(sslEnabled ? { ssl: buildSslConfig() } : {}),
      }
)

// Managed Postgres (RDS/Neon) terminates idle connections; without this handler the
// emitted 'error' event on an idle client crashes the whole process.
pool.on('error', (err) => {
  console.error('PostgreSQL idle client error (connection will be re-established):', err.message)
})

/**
 * Verify database connectivity at boot. Called from server.js after env validation
 * so failures log actionable diagnostics before EB marks the deployment unhealthy.
 */
async function verifyDatabaseConnection() {
  let client
  try {
    client = await pool.connect()
    await client.query('SELECT 1 AS ok')
    console.log('[startup] ✅ Database connection verified (TLS active)')
  } catch (err) {
    console.error('[startup] ❌ Database connection failed:', err.message)
    if (/self-signed|self signed|unable to (get|verify)|certificate/i.test(err.message)) {
      console.error(
        '   ↳ TLS cert verification failed. For RDS set DB_SSL_CA to the Amazon RDS CA bundle ' +
          '(certs/rds-global-bundle.pem ships in the deploy artifact) and remove sslmode= from DATABASE_URL.',
      )
    }
    if (/password authentication failed|no pg_hba/i.test(err.message)) {
      console.error(
        '   ↳ Authentication failed. Verify DATABASE_URL / DB_PASSWORD in SSM matches the live RDS password.',
      )
    }
    if (/ENOTFOUND|getaddrinfo|ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
      console.error(
        '   ↳ Network/host unreachable. Verify DB_HOST in DATABASE_URL and security group allows EB → RDS.',
      )
    }
    throw err
  } finally {
    if (client) client.release()
  }
}

// Transaction helper: acquires a client, BEGIN/COMMIT/ROLLBACK, always releases.
//   await withTransaction(async (client) => { await client.query(...) ... })
async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) { /* ignore */ }
    throw err
  } finally {
    client.release()
  }
}

module.exports = pool
module.exports.withTransaction = withTransaction
module.exports.verifyDatabaseConnection = verifyDatabaseConnection
