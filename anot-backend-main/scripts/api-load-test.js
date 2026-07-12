/**
 * API-Based Load Test
 * 
 * Alternative to browser automation - uses direct API calls
 * Faster and more reliable for CI/CD environments
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const { generateTestAudio } = require('./generate-test-audio');

// Configuration
const CONFIG = {
  apiBaseURL: process.env.API_BASE_URL || 'https://app.anot.health',
  admin: {
    email: process.env.ADMIN_EMAIL || 'superadmin@dev.anot.local',
    password: process.env.ADMIN_PASSWORD || 'DevSuperAdmin!2026'
  },
  scribe: {
    email: 'scribe@dev.anot.local',
    password: 'DevScribe!2026'
  },
  qps: {
    email: 'qps@dev.anot.local',
    password: 'DevQps!2026'
  },
  testClinician: {
    email: 'celina@anot.health',
    password: 'Password@2026',
    firstName: 'Celina',
    lastName: 'Clinician',
    role: 'clinician',
    specialty: 'Internal Medicine'
  },
  testPatients: 20,
  audioDurationMinutes: 20,
  skipPhase1: true // Use existing production clinician
};

// Test state
const STATE = {
  tokens: {},
  patientIds: [],
  visitIds: [],
  clinicianId: null,
  startTime: Date.now(),
  metrics: {},
  results: {},
  csrf: {
    token: null,
    cookies: []
  }
};

// Utility: Make API request
async function apiRequest(method, endpoint, data = null, token = null, isFormData = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.apiBaseURL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Origin': CONFIG.apiBaseURL,
        'Referer': CONFIG.apiBaseURL + '/'
      }
    };
    
    // Add authorization
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    // Add CSRF token for mutating requests
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && STATE.csrf.token) {
      options.headers['X-CSRF-Token'] = STATE.csrf.token;
    }
    
    // Add cookies
    if (STATE.csrf.cookies.length > 0) {
      options.headers['Cookie'] = STATE.csrf.cookies.join('; ');
    }
    
    // Handle different content types
    let body = null;
    if (data) {
      if (isFormData) {
        // FormData will set its own headers
        body = data;
        Object.assign(options.headers, data.getHeaders());
      } else {
        body = JSON.stringify(data);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }
    }
    
    const req = client.request(options, (res) => {
      let responseData = '';
      
      // Capture Set-Cookie headers to maintain session
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        setCookies.forEach(cookie => {
          const cookieValue = cookie.split(';')[0];
          const cookieName = cookieValue.split('=')[0];
          
          // Remove existing cookie with same name
          STATE.csrf.cookies = STATE.csrf.cookies.filter(c => !c.startsWith(cookieName + '='));
          
          // Add new cookie
          STATE.csrf.cookies.push(cookieValue);
        });
      }
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = responseData ? JSON.parse(responseData) : {};
          
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed });
          } else {
            reject(new Error(`API Error: ${res.statusCode} - ${parsed.message || responseData}`));
          }
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      if (isFormData) {
        body.pipe(req);
      } else {
        req.write(body);
        req.end();
      }
    } else {
      req.end();
    }
  });
}

// Utility: Get CSRF token
async function getCsrfToken() {
  console.log('Fetching CSRF token...');
  
  const response = await apiRequest('GET', '/api/csrf-token');
  
  STATE.csrf.token = response.data.csrfToken;
  
  console.log(`✓ CSRF token obtained`);
  return STATE.csrf.token;
}

// Utility: Login and get token
async function login(email, password) {
  console.log(`Logging in as: ${email}`);
  
  const response = await apiRequest('POST', '/api/auth/login', {
    email,
    password
  });
  
  const token = response.data.token;
  STATE.tokens[email] = token;
  
  console.log(`✓ Logged in successfully`);
  return token;
}

// Phase 1: Create clinician
async function phase1_createClinician() {
  console.log('\n═══ PHASE 1: CREATE CLINICIAN ═══\n');
  const start = Date.now();
  
  try {
    // Admin login
    const adminToken = await login(CONFIG.admin.email, CONFIG.admin.password);
    
    // Create clinician
    console.log(`Creating clinician: ${CONFIG.testClinician.email}`);
    
    const response = await apiRequest('POST', '/api/admin/users', {
      email: CONFIG.testClinician.email,
      firstName: CONFIG.testClinician.firstName,
      lastName: CONFIG.testClinician.lastName,
      role: CONFIG.testClinician.role,
      password: CONFIG.testClinician.password,
      specialty: CONFIG.testClinician.specialty
    }, adminToken);
    
    STATE.clinicianId = response.data.userId || response.data.id;
    console.log(`✓ Clinician created with ID: ${STATE.clinicianId}`);
    
    // Verify login
    const clinicianToken = await login(CONFIG.testClinician.email, CONFIG.testClinician.password);
    console.log(`✓ Clinician login verified`);
    
    const duration = Date.now() - start;
    STATE.results.phase1 = { status: 'PASS', duration };
    
    console.log(`\n✅ PHASE 1 COMPLETE (${(duration / 1000).toFixed(1)}s)`);
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 1 FAILED: ${error.message}`);
    STATE.results.phase1 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Phase 2: Create patients
async function phase2_createPatients() {
  console.log('\n═══ PHASE 2: CREATE 20 PATIENTS ═══\n');
  const start = Date.now();
  
  try {
    const token = STATE.tokens[CONFIG.testClinician.email];
    const timestamp = Date.now();
    
    for (let i = 1; i <= CONFIG.testPatients; i++) {
      const patientData = {
        name: `Load Test Patient ${i}`,
        mrn: `LT-${timestamp}-${String(i).padStart(3, '0')}`,
        dateOfBirth: '1980-01-01',
        gender: i % 2 === 0 ? 'M' : 'F'
      };
      
      console.log(`Creating patient ${i}/20: ${patientData.name}`);
      
      const response = await apiRequest('POST', '/api/patients', patientData, token);
      
      STATE.patientIds.push(response.data.patient.id);
      console.log(`✓ Patient ${i}/20 created (ID: ${response.data.patient.id})`);
    }
    
    const duration = Date.now() - start;
    STATE.results.phase2 = { status: 'PASS', duration, count: STATE.patientIds.length };
    
    console.log(`\n✅ PHASE 2 COMPLETE - ${STATE.patientIds.length} patients created (${(duration / 1000).toFixed(1)}s)`);
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 2 FAILED: ${error.message}`);
    STATE.results.phase2 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Phase 3: Schedule visits
async function phase3_scheduleVisits() {
  console.log('\n═══ PHASE 3: SCHEDULE 20 VISITS ═══\n');
  const start = Date.now();
  
  try {
    const token = STATE.tokens[CONFIG.testClinician.email];
    const today = new Date().toISOString().split('T')[0];
    
    for (let i = 1; i <= CONFIG.testPatients; i++) {
      const hour = 9 + Math.floor((i - 1) / 2);
      const minute = (i - 1) % 2 === 0 ? '00' : '30';
      const timeStr = `${String(hour).padStart(2, '0')}:${minute}`;
      
      const visitData = {
        patient_id: STATE.patientIds[i - 1],
        visit_date: today,
        visit_time: timeStr,
        visit_type: 'Follow-up',
        chief_complaint: `Load test visit #${i}`
      };
      
      console.log(`Scheduling visit ${i}/20 at ${timeStr}`);
      
      const response = await apiRequest('POST', '/api/visits', visitData, token);
      
      STATE.visitIds.push(response.data.visit.id);
      console.log(`✓ Visit ${i}/20 scheduled (ID: ${response.data.visit.id})`);
    }
    
    const duration = Date.now() - start;
    STATE.results.phase3 = { status: 'PASS', duration, count: STATE.visitIds.length };
    
    console.log(`\n✅ PHASE 3 COMPLETE - ${STATE.visitIds.length} visits scheduled (${(duration / 1000).toFixed(1)}s)`);
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 3 FAILED: ${error.message}`);
    STATE.results.phase3 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Phase 3.5: Record patient consent
async function phase3_5_recordConsent() {
  console.log('\n═══ PHASE 3.5: RECORD PATIENT CONSENT ═══\n');
  const start = Date.now();
  
  try {
    const token = STATE.tokens[CONFIG.testClinician.email];
    
    for (let i = 0; i < STATE.visitIds.length; i++) {
      const visitId = STATE.visitIds[i];
      
      console.log(`Recording consent for visit ${i + 1}/20 (ID: ${visitId})`);
      
      await apiRequest('POST', '/api/consent/recording', { visitId }, token);
      
      console.log(`✓ Consent ${i + 1}/20 recorded`);
    }
    
    const duration = Date.now() - start;
    STATE.results.phase3_5 = { status: 'PASS', duration, count: STATE.visitIds.length };
    
    console.log(`\n✅ PHASE 3.5 COMPLETE - Consent recorded for ${STATE.visitIds.length} visits (${(duration / 1000).toFixed(1)}s)`);
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 3.5 FAILED: ${error.message}`);
    STATE.results.phase3_5 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Phase 4: Upload audio
async function phase4_uploadAudio() {
  console.log('\n═══ PHASE 4: UPLOAD 20-MINUTE AUDIO FILES ═══\n');
  const start = Date.now();
  
  try {
    const token = STATE.tokens[CONFIG.testClinician.email];
    
    // Generate test audio
    console.log('Generating test audio file...');
    const audioPath = generateTestAudio(CONFIG.audioDurationMinutes);
    console.log(`✓ Audio file ready: ${audioPath}`);
    
    const uploadTimes = [];
    
    for (let i = 0; i < STATE.visitIds.length; i++) {
      const visitId = STATE.visitIds[i];
      
      console.log(`\nUploading audio for visit ${i + 1}/20 (ID: ${visitId})...`);
      const uploadStart = Date.now();
      
      // Create form data
      const form = new FormData();
      form.append('audio', fs.createReadStream(audioPath));
      form.append('visitId', visitId);
      
      await apiRequest('POST', `/api/audio/${visitId}`, form, token, true);
      
      const uploadTime = Date.now() - uploadStart;
      uploadTimes.push(uploadTime);
      
      console.log(`✓ Audio ${i + 1}/20 uploaded in ${(uploadTime / 1000).toFixed(1)}s`);
    }
    
    const avgUploadTime = uploadTimes.reduce((a, b) => a + b, 0) / uploadTimes.length;
    const duration = Date.now() - start;
    
    STATE.results.phase4 = { 
      status: 'PASS', 
      duration, 
      count: uploadTimes.length,
      avgUploadTime
    };
    
    console.log(`\n✅ PHASE 4 COMPLETE - ${uploadTimes.length} audio files uploaded`);
    console.log(`   Average upload time: ${(avgUploadTime / 1000).toFixed(1)}s per file`);
    console.log(`   Total time: ${(duration / 1000).toFixed(1)}s`);
    
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 4 FAILED: ${error.message}`);
    STATE.results.phase4 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Phase 5: Monitor transcription
async function phase5_monitorTranscription() {
  console.log('\n═══ PHASE 5: MONITOR TRANSCRIPTION ═══\n');
  const start = Date.now();
  
  try {
    const token = STATE.tokens[CONFIG.testClinician.email];
    
    let allTranscribed = false;
    let attempts = 0;
    const maxAttempts = 60; // 30 minutes (30s intervals)
    
    while (!allTranscribed && attempts < maxAttempts) {
      attempts++;
      
      // Get all visits for the clinician
      const response = await apiRequest('GET', '/api/visits', null, token);
      const allVisits = response.data.visits || response.data;
      
      // Count how many of our test visits are transcribed
      let transcribedCount = 0;
      
      for (const visitId of STATE.visitIds) {
        const visit = allVisits.find(v => v.id === visitId);
        if (visit) {
          const status = visit.status;
          
          if (status === 'transcribed' || status === 'completed' || status === 'notes_generated') {
            transcribedCount++;
          }
        }
      }
      
      console.log(`Transcription progress: ${transcribedCount}/${CONFIG.testPatients} (Attempt ${attempts}/${maxAttempts})`);
      
      if (transcribedCount >= CONFIG.testPatients) {
        allTranscribed = true;
        break;
      }
      
      // Wait 30 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    
    if (!allTranscribed) {
      throw new Error('Transcription timeout - not all visits transcribed after 30 minutes');
    }
    
    const duration = Date.now() - start;
    STATE.results.phase5 = { status: 'PASS', duration, count: CONFIG.testPatients };
    
    console.log(`\n✅ PHASE 5 COMPLETE - All transcriptions finished (${(duration / 1000 / 60).toFixed(1)} minutes)`);
    return true;
    
  } catch (error) {
    console.error(`❌ PHASE 5 FAILED: ${error.message}`);
    STATE.results.phase5 = { status: 'FAIL', error: error.message };
    throw error;
  }
}

// Main execution
async function runLoadTest() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('API-BASED LOAD TEST: Full E2E Workflow');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  try {
    // Get CSRF token first
    await getCsrfToken();
    
    if (CONFIG.skipPhase1) {
      console.log('Skipping Phase 1 - Using existing clinician\n');
      // Just login as the clinician
      console.log('═══ SETUP: LOGIN AS CLINICIAN ═══\n');
      const clinicianToken = await login(CONFIG.testClinician.email, CONFIG.testClinician.password);
      console.log(`✓ Logged in as ${CONFIG.testClinician.email}\n`);
      STATE.clinicianId = null; // We don't need the ID
    } else {
      await phase1_createClinician();
    }
    
    await phase2_createPatients();
    await phase3_scheduleVisits();
    await phase3_5_recordConsent();
    await phase4_uploadAudio();
    await phase5_monitorTranscription();
    
    // Note: Phases 6-8 (Scribe review, QPS grading, Clinician lock) 
    // require UI interaction or specific API endpoints
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('LOAD TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const totalDuration = Date.now() - STATE.startTime;
    
    console.log('Results:');
    Object.entries(STATE.results).forEach(([phase, result]) => {
      const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';
      console.log(`  ${phase}: ${result.status} (${duration})`);
    });
    
    console.log(`\nTotal time: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
    console.log('\n✅ Automated phases complete!');
    console.log('\nNext steps:');
    console.log('  1. Wait for transcriptions to complete (~15 minutes)');
    console.log('  2. Scribe review (manual or via API)');
    console.log('  3. QPS grading (manual or via API)');
    console.log('  4. Clinician lock (manual or via API)');
    
  } catch (error) {
    console.error('\n❌ Load test failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runLoadTest().catch(console.error);
}

module.exports = { runLoadTest };
