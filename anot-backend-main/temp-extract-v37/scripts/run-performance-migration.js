#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const migrationFile = path.join(__dirname, '../migrations/20260607_performance_indexes.sql')
const sql = fs.readFileSync(migrationFile, 'utf8')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

async function runMigration() {
  try {
    console.log('Running performance indexes migration...')
    await pool.query(sql)
    console.log('✅ Performance indexes created successfully!')
    process.exit(0)
  } catch (error) {
    console.error('❌ Migration failed:', error.message)
    process.exit(1)
  }
}

runMigration()
