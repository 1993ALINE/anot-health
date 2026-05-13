/**
 * One-shot: apply migrations/20260210_visits_visit_type_add_other.sql
 * Run from anot-backend-main/anot-backend-main: node scripts/run-migration-visits-visit-type.js
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.DATABASE_SSL_INSECURE === 'true'
            ? { rejectUnauthorized: false }
            : { rejectUnauthorized: true },
      }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      },
)

const sqlPath = path.join(__dirname, '..', 'migrations', '20260210_visits_visit_type_add_other.sql')

async function main() {
  const sql = fs.readFileSync(sqlPath, 'utf8')
  await pool.query(sql)
  console.log('Applied:', sqlPath)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  pool.end()
  process.exit(1)
})
