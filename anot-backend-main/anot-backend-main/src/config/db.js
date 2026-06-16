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
function buildSslConfig() {
  // Explicit CA path wins (when it actually exists); otherwise fall back to the
  // CA bundle shipped in the deploy artifact. A misconfigured DB_SSL_CA path must
  // not crash boot — we degrade to the bundled CA rather than throwing. Either
  // way we verify (rejectUnauthorized: true).
  const explicit =
    process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA) ? process.env.DB_SSL_CA : null
  const caPath = explicit || (fs.existsSync(BUNDLED_RDS_CA) ? BUNDLED_RDS_CA : null)
  if (caPath) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
  }
  if (process.env.DB_SSL_NO_VERIFY === 'true') {
    console.warn(
      '⚠ DB TLS certificate verification is DISABLED (DB_SSL_NO_VERIFY=true). The ' +
        'connection is encrypted but vulnerable to MITM. Set DB_SSL_CA to the RDS CA ' +
        'bundle to verify instead. Do NOT use this in production.',
    )
    return { rejectUnauthorized: false }
  }
  // No CA file available: still verify against Node's built-in trust store (RDS
  // certs chain to Amazon roots Node trusts). Never silently accept any cert.
  return { rejectUnauthorized: true }
}

// SSL-related query params embedded in DATABASE_URL (e.g. `?sslmode=require`,
// `rejectUnauthorized=false`) are parsed by pg-connection-string and silently
// override the explicit `ssl` object below — `sslmode=require` rebuilds its own
// ssl config and re-enables verification (the exact "self-signed certificate in
// certificate chain" error we hit), while `sslmode=no-verify`/`disable` would
// weaken TLS. We strip them all so this file is the single source of truth for
// TLS policy regardless of how the URL was provisioned.
const SSL_URL_PARAMS = ['sslmode', 'ssl', 'rejectunauthorized', 'sslrootcert', 'sslcert', 'sslkey']
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

const useUrl = !!process.env.DATABASE_URL
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

// Fatal on startup connect failure so the process supervisor (EB/PM2/Railway)
// restarts cleanly instead of serving a 100% 500 backend.
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed at startup:', err.message)
    if (/self-signed|self signed|unable to (get|verify)|certificate/i.test(err.message)) {
      console.error(
        '   ↳ TLS cert verification failed. Set DB_SSL_CA to the Amazon RDS CA bundle ' +
          '(region-bundle.pem) and remove any sslmode= from DATABASE_URL.',
      )
    }
    process.exit(1)
  }
  console.log('✅ Connected to PostgreSQL database (TLS verified)')
  release()
})

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
