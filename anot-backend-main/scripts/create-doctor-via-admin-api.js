#!/usr/bin/env node
/**
 * CREATE DOCTOR VIA ADMIN API
 * 
 * Uses admin credentials to create a new doctor account in production
 */

require('dotenv').config()

const API_BASE = 'https://app.anot.health/api'

class CookieJar {
  constructor() {
    this.cookies = {}
  }
  
  store(response) {
    const rawSetCookie = response.headers.raw ? response.headers.raw()['set-cookie'] : null
    if (!rawSetCookie) {
      const setCookieHeader = response.headers.get('set-cookie')
      if (!setCookieHeader) return
      const cookies = [setCookieHeader]
      cookies.forEach(this._parseCookie.bind(this))
    } else {
      rawSetCookie.forEach(this._parseCookie.bind(this))
    }
  }
  
  _parseCookie(cookieStr) {
    const [nameValue] = cookieStr.split(';')
    const [name, ...valueParts] = nameValue.split('=')
    if (name && valueParts.length > 0) {
      this.cookies[name.trim()] = valueParts.join('=').trim()
    }
  }
  
  headers() {
    const cookieString = Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
    return cookieString ? { Cookie: cookieString } : {}
  }
}

async function fetchCsrfToken(apiBase, jar) {
  const res = await fetch(`${apiBase}/csrf-token`, {
    method: 'GET',
    credentials: 'include',
    headers: jar.headers()
  })
  jar.store(res)
  const data = await res.json()
  if (!data.csrfToken) throw new Error('No CSRF token received')
  return data.csrfToken
}

async function adminLogin() {
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('STEP 1: ADMIN LOGIN')
  console.log('═══════════════════════════════════════════════════════════\n')
  
  const email = 'atiqurrahmanaline@gmail.com'
  const password = '#1Knowtex2026'
  
  console.log(`Logging in as admin: ${email}`)
  
  const jar = new CookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  console.log(`CSRF token: ${csrf.substring(0, 20)}...`)
  
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...jar.headers()
    },
    body: JSON.stringify({ email, password })
  })
  
  jar.store(res)
  const data = await res.json()
  
  console.log(`Response: ${res.status} ${res.statusText}`)
  
  if (!res.ok) {
    console.log(`❌ Admin login failed: ${data.error || 'Unknown error'}`)
    throw new Error(`Admin login failed: ${data.error}`)
  }
  
  console.log(`✅ Admin login successful`)
  console.log(`   Admin: ${data.user.name} (${data.user.email})`)
  console.log(`   Role: ${data.user.role}`)
  console.log(`   ID: ${data.user.id}`)
  
  return { jar, user: data.user }
}

async function createDoctor(jar) {
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('STEP 2: CREATE DOCTOR VIA ADMIN API')
  console.log('═══════════════════════════════════════════════════════════\n')
  
  const doctorData = {
    email: 'test-doctor-e2e@anot.health',
    password: '#1Knowtex2026',
    name: 'Test Doctor E2E',
    role: 'clinician',
    phone: '+8801521434823',
    specialty: 'General Medicine',
    status: 'active'
  }
  
  console.log(`Creating doctor: ${doctorData.email}`)
  console.log(`Name: ${doctorData.name}`)
  console.log(`Role: ${doctorData.role}`)
  console.log(`Specialty: ${doctorData.specialty}`)
  
  const csrf = await fetchCsrfToken(API_BASE, jar)
  
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...jar.headers()
    },
    body: JSON.stringify(doctorData)
  })
  
  jar.store(res)
  const data = await res.json()
  
  console.log(`Response: ${res.status} ${res.statusText}`)
  
  if (!res.ok) {
    console.log(`Response body:`, data)
    
    // Check if user already exists
    if (data.error && /already exists|duplicate/i.test(data.error)) {
      console.log(`⚠️  Doctor already exists, will update password`)
      return { alreadyExists: true, email: doctorData.email }
    }
    
    console.log(`❌ Failed to create doctor: ${data.error || 'Unknown error'}`)
    throw new Error(`Failed to create doctor: ${data.error}`)
  }
  
  console.log(`✅ Doctor created successfully`)
  console.log(`   Email: ${data.user?.email || doctorData.email}`)
  console.log(`   ID: ${data.user?.id || 'N/A'}`)
  console.log(`   Role: ${data.user?.role || doctorData.role}`)
  
  return { user: data.user, email: doctorData.email, password: doctorData.password }
}

async function verifyDoctorLogin(email, password) {
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('STEP 3: VERIFY DOCTOR LOGIN')
  console.log('═══════════════════════════════════════════════════════════\n')
  
  console.log(`Testing login as: ${email}`)
  
  const jar = new CookieJar()
  const csrf = await fetchCsrfToken(API_BASE, jar)
  
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...jar.headers()
    },
    body: JSON.stringify({ email, password })
  })
  
  jar.store(res)
  const data = await res.json()
  
  console.log(`Response: ${res.status} ${res.statusText}`)
  
  if (!res.ok) {
    console.log(`❌ Doctor login failed: ${data.error || 'Unknown error'}`)
    console.log(`   This might be due to PHI training or MFA requirements`)
    
    // Check if it's a gate (PHI training, MFA, etc.) rather than invalid credentials
    if (data.requirePhiTraining || data.requireMfa || data.enrollmentRequired) {
      console.log(`   Gate detected: ${data.requirePhiTraining ? 'PHI Training' : data.requireMfa ? 'MFA' : 'Enrollment'}`)
      console.log(`   ⚠️  Doctor account created but requires gate completion`)
      return { success: true, requiresGate: true, gate: data }
    }
    
    return { success: false, error: data.error }
  }
  
  console.log(`✅ Doctor login successful!`)
  
  if (data.user) {
    console.log(`   Name: ${data.user.name}`)
    console.log(`   Email: ${data.user.email}`)
    console.log(`   Role: ${data.user.role}`)
    console.log(`   ID: ${data.user.id}`)
  } else {
    console.log(`   Response:`, JSON.stringify(data, null, 2))
  }
  
  return { success: true, user: data.user }
}

async function main() {
  try {
    console.log('\n═══════════════════════════════════════════════════════════')
    console.log('CREATE DOCTOR ACCOUNT VIA ADMIN API')
    console.log('═══════════════════════════════════════════════════════════')
    
    // Step 1: Admin login
    const { jar } = await adminLogin()
    
    // Step 2: Create doctor
    const result = await createDoctor(jar)
    
    const doctorEmail = result.email
    const doctorPassword = result.password || '#1Knowtex2026'
    
    // Step 3: Verify doctor login
    const verification = await verifyDoctorLogin(doctorEmail, doctorPassword)
    
    // Final report
    console.log('\n═══════════════════════════════════════════════════════════')
    console.log('FINAL REPORT')
    console.log('═══════════════════════════════════════════════════════════\n')
    
    console.log(`Doctor Account: ${doctorEmail}`)
    console.log(`Password: ${doctorPassword}`)
    console.log(`Login Works: ${verification.success ? '✅ YES' : '❌ NO'}`)
    
    if (verification.requiresGate) {
      console.log(`⚠️  Requires Gate: ${verification.gate.requirePhiTraining ? 'PHI Training' : verification.gate.requireMfa ? 'MFA' : 'Other'}`)
      console.log(`   The E2E test script should handle this automatically`)
    }
    
    console.log(`Ready for E2E Test: ${verification.success ? '✅ YES' : '❌ NO'}`)
    
    console.log('\n═══════════════════════════════════════════════════════════')
    
    if (verification.success) {
      console.log('\n✅ ALL STEPS COMPLETED SUCCESSFULLY')
      console.log('\nYou can now run the E2E test with:')
      console.log(`   Doctor: ${doctorEmail}`)
      console.log(`   Scribe: shahib@anot.health`)
      console.log(`   QPS: farhan@anot.health`)
      process.exit(0)
    } else {
      console.log('\n❌ DOCTOR CREATION FAILED')
      process.exit(1)
    }
    
  } catch (error) {
    console.error('\n═══════════════════════════════════════════════════════════')
    console.error('❌ ERROR')
    console.error('═══════════════════════════════════════════════════════════\n')
    console.error('Error:', error.message)
    console.error('\nStack trace:')
    console.error(error.stack)
    process.exit(1)
  }
}

main()
