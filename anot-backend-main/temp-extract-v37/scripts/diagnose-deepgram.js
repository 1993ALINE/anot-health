#!/usr/bin/env node

/**
 * Diagnostic script to check Deepgram configuration
 * Run: node scripts/diagnose-deepgram.js
 */

require('dotenv').config()
const pool = require('../src/config/db')
const { decryptString } = require('../src/utils/settingsEncryption')
const { loadAiSettings, useDeepgram } = require('../src/services/aiSettings')

async function diagnose() {
  console.log('\n=== Deepgram Configuration Diagnostic ===\n')
  
  try {
    // 1. Check encryption key
    console.log('1. Checking encryption key configuration:')
    const encKey = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'anot-dev-settings-key'
    console.log(`   SETTINGS_ENCRYPTION_KEY: ${process.env.SETTINGS_ENCRYPTION_KEY ? '✓ Set' : '✗ Not set'}`)
    console.log(`   JWT_SECRET: ${process.env.JWT_SECRET ? '✓ Set' : '✗ Not set'}`)
    console.log(`   Using: ${process.env.SETTINGS_ENCRYPTION_KEY ? 'SETTINGS_ENCRYPTION_KEY' : process.env.JWT_SECRET ? 'JWT_SECRET' : 'default key'}`)
    console.log()
    
    // 2. Query database directly
    console.log('2. Querying database for Deepgram settings:')
    const result = await pool.query('SELECT deepgram_enabled, deepgram_api_key_enc, deepgram_model, deepgram_language, deepgram_webhook_url FROM system_settings WHERE id = 1')
    
    if (result.rows.length === 0) {
      console.log('   ✗ No settings row found in database!')
      return
    }
    
    const row = result.rows[0]
    console.log(`   deepgram_enabled: ${row.deepgram_enabled}`)
    console.log(`   deepgram_api_key_enc exists: ${!!row.deepgram_api_key_enc}`)
    console.log(`   deepgram_api_key_enc length: ${row.deepgram_api_key_enc ? row.deepgram_api_key_enc.length : 0}`)
    console.log(`   deepgram_model: ${row.deepgram_model || 'not set'}`)
    console.log(`   deepgram_language: ${row.deepgram_language || 'not set'}`)
    console.log(`   deepgram_webhook_url: ${row.deepgram_webhook_url || 'not set'}`)
    console.log()
    
    // 3. Test decryption
    console.log('3. Testing decryption:')
    if (row.deepgram_api_key_enc) {
      const decrypted = decryptString(row.deepgram_api_key_enc)
      if (decrypted) {
        console.log(`   ✓ Decryption succeeded!`)
        console.log(`   ✓ Decrypted key length: ${decrypted.length} characters`)
        console.log(`   ✓ Key preview: ${decrypted.substring(0, 8)}...${decrypted.substring(decrypted.length - 4)}`)
      } else {
        console.log(`   ✗ DECRYPTION FAILED!`)
        console.log(`   ✗ This means the encryption key has changed since the API key was saved`)
        console.log(`   ✗ You need to re-enter the Deepgram API key in the settings`)
      }
    } else {
      console.log('   ✗ No encrypted API key in database')
    }
    console.log()
    
    // 4. Load settings using the service
    console.log('4. Loading settings through aiSettings service:')
    const settings = await loadAiSettings()
    console.log(`   deepgram_enabled: ${settings.deepgram_enabled}`)
    console.log(`   deepgram_api_key exists: ${!!settings.deepgram_api_key}`)
    console.log(`   deepgram_api_key length: ${settings.deepgram_api_key ? settings.deepgram_api_key.length : 0}`)
    console.log()
    
    // 5. Check if Deepgram would be used
    console.log('5. Will Deepgram be used?')
    const willUse = useDeepgram(settings)
    if (willUse) {
      console.log('   ✓ YES - Deepgram will be used for transcription')
    } else {
      console.log('   ✗ NO - Deepgram will NOT be used')
      console.log('   Reasons:')
      if (!settings.deepgram_enabled) {
        console.log('     - deepgram_enabled is false')
      }
      if (!settings.deepgram_api_key) {
        console.log('     - deepgram_api_key is missing or decryption failed')
      }
      if (settings.deepgram_api_key && !settings.deepgram_api_key.trim()) {
        console.log('     - deepgram_api_key is empty or whitespace only')
      }
    }
    console.log()
    
    // 6. Summary
    console.log('=== SUMMARY ===')
    if (willUse) {
      console.log('✓ Deepgram is properly configured')
    } else {
      console.log('✗ Deepgram is NOT properly configured')
      console.log('')
      console.log('To fix:')
      if (!row.deepgram_api_key_enc) {
        console.log('  1. Go to Settings in the web interface')
        console.log('  2. Enter your Deepgram API key')
        console.log('  3. Save the settings')
      } else if (row.deepgram_api_key_enc && !settings.deepgram_api_key) {
        console.log('  1. The encryption key has changed - you need to re-enter the API key')
        console.log('  2. Go to Settings in the web interface')
        console.log('  3. Re-enter your Deepgram API key')
        console.log('  4. Save the settings')
      } else if (!settings.deepgram_enabled) {
        console.log('  1. Go to Settings in the web interface')
        console.log('  2. Enable Deepgram transcription')
        console.log('  3. Save the settings')
      }
    }
    
  } catch (error) {
    console.error('\n✗ Error during diagnosis:', error.message)
    console.error(error.stack)
  } finally {
    await pool.end()
  }
}

diagnose()
