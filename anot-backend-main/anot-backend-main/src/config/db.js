const { Pool } = require('pg')
const dotenv = require('dotenv')
dotenv.config()

// SSL: always verify the server certificate. We never disable certificate
// validation, since accepting unverified certs exposes the connection to MITM.
const useUrl = !!process.env.DATABASE_URL
const pool = new Pool(
  useUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        host:     process.env.DB_HOST,
        port:     process.env.DB_PORT,
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
      }
)

// Neon's pooler terminates idle connections; without this handler the emitted
// 'error' event on an idle client crashes the whole process.
pool.on('error', (err) => {
  console.error('PostgreSQL idle client error (connection will be re-established):', err.message)
})

// Fatal on startup connect failure so Railway/process supervisor restarts cleanly
// instead of serving a 100% 500 backend.
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed at startup:', err.message)
    process.exit(1)
  }
  console.log('✅ Connected to PostgreSQL database')
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

