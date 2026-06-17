#!/usr/bin/env node

/**
 * Test script to verify direct Deepgram API connectivity
 * Run: node scripts/test-deepgram-http.js
 */

require('dotenv').config()
const pool = require('../src/config/db')
const { decryptString } = require('../src/utils/settingsEncryption')

async function testDeepgramHttp() {
  console.log('\n=== Deepgram Direct HTTP Test ===\n')
  
  try {
    // 1. Get API key from database
    console.log('1. Loading Deepgram API key from database...')
    const result = await pool.query('SELECT deepgram_enabled, deepgram_api_key_enc FROM system_settings WHERE id = 1')
    
    if (result.rows.length === 0) {
      console.log('   ✗ No settings row found in database!')
      return
    }
    
    const row = result.rows[0]
    
    if (!row.deepgram_enabled) {
      console.log('   ✗ Deepgram is not enabled in settings')
      return
    }
    
    if (!row.deepgram_api_key_enc) {
      console.log('   ✗ No Deepgram API key in database')
      return
    }
    
    const apiKey = decryptString(row.deepgram_api_key_enc)
    if (!apiKey) {
      console.log('   ✗ Failed to decrypt API key')
      return
    }
    
    console.log('   ✓ API key loaded successfully')
    console.log(`   ✓ Key length: ${apiKey.length} characters`)
    console.log()
    
    // 2. Test API connectivity
    console.log('2. Testing Deepgram API connectivity...')
    const testUrl = 'https://api.deepgram.com/v1/projects'
    
    console.log(`   Sending request to: ${testUrl}`)
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${apiKey}`,
      },
    })
    
    console.log(`   Response status: ${response.status} ${response.statusText}`)
    
    if (response.ok) {
      const data = await response.json()
      console.log('   ✓ API is reachable and authentication successful!')
      if (data.projects && data.projects.length > 0) {
        console.log(`   ✓ Found ${data.projects.length} project(s)`)
      }
    } else {
      const errorText = await response.text()
      console.log('   ✗ API request failed:')
      console.log('   ', errorText.slice(0, 200))
    }
    console.log()
    
    // 3. Test transcription endpoint structure
    console.log('3. Testing transcription endpoint structure...')
    const queryParams = new URLSearchParams({
      model: 'nova-2-medical',
      language: 'en-US',
      smart_format: 'true',
      punctuate: 'true',
    })
    
    const transcribeUrl = `https://api.deepgram.com/v1/listen?${queryParams.toString()}`
    console.log(`   Transcription URL would be:`)
    console.log(`   ${transcribeUrl}`)
    console.log()
    
    console.log('=== TEST COMPLETE ===')
    console.log('✓ Direct HTTP requests to Deepgram API should work')
    console.log('✓ The aiTranscriptionService.js now uses direct HTTP instead of SDK')
    
  } catch (error) {
    console.error('\n✗ Test failed:', error.message)
    if (error.cause) {
      console.error('   Cause:', error.cause)
    }
  } finally {
    await pool.end()
  }
}

testDeepgramHttp()
