/**
 * Database Migration: Create transcriptions table
 * 
 * This table tracks batch transcription jobs for cost-optimized STT
 * Run with: node scripts/migrations/001-create-transcriptions-table.js
 */

// Load secrets before requiring db
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = require('../../src/config/db');

async function up() {
  console.log('[Migration] Creating transcriptions table...');
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id SERIAL PRIMARY KEY,
        visit_id INTEGER NOT NULL UNIQUE REFERENCES visits(id) ON DELETE CASCADE,
        deepgram_request_id VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        transcript TEXT,
        confidence DECIMAL(5,4),
        error TEXT,
        model VARCHAR(100),
        audio_duration_seconds INTEGER,
        submitted_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_transcriptions_status 
        ON transcriptions(status);
      
      CREATE INDEX IF NOT EXISTS idx_transcriptions_visit_id 
        ON transcriptions(visit_id);
      
      CREATE INDEX IF NOT EXISTS idx_transcriptions_submitted_at 
        ON transcriptions(submitted_at) 
        WHERE status = 'pending';
    `);
    
    console.log('[Migration] ✅ Transcriptions table created successfully');
    
  } catch (error) {
    console.error('[Migration] ❌ Failed to create transcriptions table:', error);
    throw error;
  }
}

async function down() {
  console.log('[Migration] Dropping transcriptions table...');
  
  try {
    await pool.query(`
      DROP TABLE IF EXISTS transcriptions CASCADE;
    `);
    
    console.log('[Migration] ✅ Transcriptions table dropped successfully');
    
  } catch (error) {
    console.error('[Migration] ❌ Failed to drop transcriptions table:', error);
    throw error;
  }
}

// Run migration if called directly
if (require.main === module) {
  (async () => {
    try {
      await up();
      console.log('[Migration] Complete!');
      process.exit(0);
    } catch (error) {
      console.error('[Migration] Failed:', error.message);
      process.exit(1);
    }
  })();
}

module.exports = { up, down };
