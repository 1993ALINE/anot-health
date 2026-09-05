#!/usr/bin/env node
/**
 * purge-all-patient-data.js
 *
 * Permanently purges all previous test patients, visits, clinical SOAP notes,
 * transcripts, and consent records from the Anot Health platform.
 * Staff accounts, templates, and system settings remain completely preserved.
 */

'use strict'

const https = require('https')

const BASE_URL = process.env.API_BASE_URL || 'https://app.anot.health'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SUPER_ADMIN_EMAIL || 'ashikur@anot.health'
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || 'Password@2026'

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AnotAdmin/1.0',
        ...headers,
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { json = data }
        resolve({ status: res.statusCode, headers: res.headers, body: json })
      })
    })

    req.on('error', reject)
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

async function main() {
  console.log('================================================================')
  console.log('🚨 ANOT HEALTH — PURGING ALL PREVIOUS PATIENT DATA')
  console.log(`Target: ${BASE_URL}`)
  console.log('================================================================\n')

  // 1. Fetch CSRF token
  console.log('1️⃣ Fetching CSRF token...')
  const csrfRes = await request('GET', '/api/csrf-token')
  const setCookies = csrfRes.headers['set-cookie'] || []
  let cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ')
  const csrfToken = csrfRes.body?.csrfToken || ''

  // 2. Authenticate as Admin
  console.log(`2️⃣ Authenticating as Administrator (${ADMIN_EMAIL})...`)
  const loginRes = await request('POST', '/api/auth/login', {
    email: ADMIN_EMAIL,
    password: PASSWORD,
    force: true,
  }, {
    'Cookie': cookieHeader,
    'X-CSRF-Token': csrfToken,
  })

  if (loginRes.status !== 200 || !loginRes.body?.token) {
    console.error('❌ Super Admin login failed:', loginRes.status, loginRes.body)
    process.exit(1)
  }

  const token = loginRes.body.token
  const loginCookies = loginRes.headers['set-cookie'] || []
  if (loginCookies.length > 0) {
    cookieHeader = `${cookieHeader}; ${loginCookies.map(c => c.split(';')[0]).join('; ')}`
  }
  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Cookie': cookieHeader,
    'X-CSRF-Token': csrfToken,
  }
  console.log('✅ Logged in successfully as Super Admin!\n')

  // 3. Inspect current count of patients and visits before purge
  console.log("3️⃣ Checking current patient roster...")
  const patientsBefore = await request('GET', '/api/patients', null, authHeaders)
  const patientCountBefore = Array.isArray(patientsBefore.body?.patients) ? patientsBefore.body.patients.length : 0
  console.log(`   Patients before purge: ${patientCountBefore}`)

  // 4. Execute bulk delete
  console.log('\n4️⃣ Executing bulk purge of all patients, visits, and clinical notes...')
  const purgeRes = await request('DELETE', '/api/patients/bulk/all', null, authHeaders)

  if (purgeRes.status === 200) {
    console.log('✅ Purge API succeeded! Response:', purgeRes.body)
  } else {
    console.error('❌ Purge API returned error:', purgeRes.status, purgeRes.body)
    process.exit(1)
  }

  // 5. Verify patient roster is empty
  console.log("\n5️⃣ Verifying patient roster is now empty...")
  const patientsAfter = await request('GET', '/api/patients', null, authHeaders)
  const patientCountAfter = Array.isArray(patientsAfter.body?.patients) ? patientsAfter.body.patients.length : 0
  console.log(`   Patients remaining: ${patientCountAfter}`)

  if (patientCountAfter === 0) {
    console.log('\n🎉 ALL PREVIOUS PATIENT DATA HAS BEEN PERMANENTLY PURGED!')
  } else {
    console.warn(`\n⚠️ Warning: ${patientCountAfter} patient(s) still detected in roster.`)
  }
}

main().catch(err => {
  console.error('Fatal error during patient purge:', err)
  process.exit(1)
})
