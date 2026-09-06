/**
 * fix-anthropic-key.js
 * 
 * Clears the old encrypted Anthropic API key from the DB so the backend
 * falls back to the ANTHROPIC_API_KEY in your .env file.
 * Also ensures anthropic_enabled = true.
 * 
 * Run: node fix-anthropic-key.js
 */

require('dotenv').config({ path: '.env' })
const pool = require('./src/config/db')
const { encryptString } = require('./src/utils/settingsEncryption')

async function main() {
  try {
    // Check current state
    const { rows } = await pool.query('SELECT anthropic_enabled, anthropic_api_key_enc, anthropic_model FROM system_settings WHERE id = 1')
    if (!rows[0]) {
      console.log('No system_settings row found. Will insert one.')
    } else {
      console.log('Current state:')
      console.log('  anthropic_enabled:', rows[0].anthropic_enabled)
      console.log('  has DB key:       ', !!rows[0].anthropic_api_key_enc)
      console.log('  model:            ', rows[0].anthropic_model)
    }

    const envKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
    if (!envKey) {
      console.error('\n❌ ANTHROPIC_API_KEY is not set in .env! Add it first.')
      process.exit(1)
    }

    console.log('\n→ Encrypting .env ANTHROPIC_API_KEY and saving to DB...')
    const encrypted = encryptString(envKey.trim())
    if (!encrypted) {
      console.error('❌ Encryption failed — check SETTINGS_ENCRYPTION_KEY in .env')
      process.exit(1)
    }

    await pool.query(`
      INSERT INTO system_settings (id, anthropic_enabled, anthropic_api_key_enc, anthropic_model)
      VALUES (1, true, $1, 'claude-3-5-sonnet-20241022')
      ON CONFLICT (id) DO UPDATE SET
        anthropic_enabled = true,
        anthropic_api_key_enc = $1,
        anthropic_model = COALESCE(EXCLUDED.anthropic_model, 'claude-3-5-sonnet-20241022')
    `, [encrypted])

    console.log('✅ Done! Anthropic API key updated in DB from .env')
    console.log('   anthropic_enabled = true')
    console.log('   model = claude-3-5-sonnet-20241022')
    console.log('\nRestart the backend server to apply the new settings cache.')
  } catch (err) {
    console.error('❌ Error:', err.message)
    process.exit(1)
  } finally {
    await pool.end().catch(() => {})
    process.exit(0)
  }
}

main()
