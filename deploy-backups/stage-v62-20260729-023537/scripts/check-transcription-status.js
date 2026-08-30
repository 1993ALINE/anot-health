/**
 * Check Transcription Status
 * Monitors transcription progress for all test visits
 */

const https = require('https');

// Configuration
const CONFIG = {
  apiBaseURL: 'https://app.anot.health',
  clinician: {
    email: 'celina@anot.health',
    password: 'Password@2026'
  },
  testVisitIds: [486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 505]
};

// State
const STATE = {
  token: null,
  csrf: {
    token: null,
    cookies: []
  }
};

// API request helper
async function apiRequest(method, endpoint, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.apiBaseURL);
    
    const options = {
      method,
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': CONFIG.apiBaseURL,
        'Referer': CONFIG.apiBaseURL + '/'
      }
    };
    
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && STATE.csrf.token) {
      options.headers['X-CSRF-Token'] = STATE.csrf.token;
    }
    
    if (STATE.csrf.cookies.length > 0) {
      options.headers['Cookie'] = STATE.csrf.cookies.join('; ');
    }
    
    let body = null;
    if (data) {
      body = JSON.stringify(data);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        setCookies.forEach(cookie => {
          const cookieValue = cookie.split(';')[0];
          const cookieName = cookieValue.split('=')[0];
          STATE.csrf.cookies = STATE.csrf.cookies.filter(c => !c.startsWith(cookieName + '='));
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
      req.write(body);
    }
    req.end();
  });
}

// Get CSRF token
async function getCsrfToken() {
  const response = await apiRequest('GET', '/api/csrf-token');
  STATE.csrf.token = response.data.csrfToken;
}

// Login
async function login() {
  const response = await apiRequest('POST', '/api/auth/login', {
    email: CONFIG.clinician.email,
    password: CONFIG.clinician.password
  });
  STATE.token = response.data.token;
}

// Check transcription status
async function checkStatus() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('TRANSCRIPTION STATUS CHECK');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Checking status for 20 test visits...\n`);
  
  try {
    // Setup
    await getCsrfToken();
    await login();
    
    // Get all visits
    const response = await apiRequest('GET', '/api/visits', null, STATE.token);
    const allVisits = response.data.visits || response.data;
    
    // Filter our test visits
    const testVisits = allVisits.filter(v => CONFIG.testVisitIds.includes(v.id));
    
    // Count by status
    const statusCounts = {
      'scheduled': 0,
      'audio_uploaded': 0,
      'transcribing': 0,
      'transcribed': 0,
      'notes_generated': 0,
      'completed': 0,
      'other': 0
    };
    
    console.log('Visit Status Breakdown:\n');
    console.log('ID    | Status              | Patient');
    console.log('------|---------------------|------------------');
    
    testVisits.forEach(visit => {
      const status = visit.status || 'unknown';
      const patientName = visit.patient_name || visit.patient?.name || 'Unknown';
      
      if (statusCounts.hasOwnProperty(status)) {
        statusCounts[status]++;
      } else {
        statusCounts['other']++;
      }
      
      console.log(`${String(visit.id).padEnd(5)} | ${status.padEnd(19)} | ${patientName}`);
    });
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('STATUS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log('Total visits found:', testVisits.length, '/ 20');
    console.log('\nStatus breakdown:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      if (count > 0) {
        const percentage = ((count / testVisits.length) * 100).toFixed(0);
        console.log(`  ${status.padEnd(20)}: ${count.toString().padStart(2)} (${percentage}%)`);
      }
    });
    
    // Progress indicator
    const completed = statusCounts.transcribed + statusCounts.notes_generated + statusCounts.completed;
    const inProgress = statusCounts.transcribing + statusCounts.audio_uploaded;
    const pending = statusCounts.scheduled;
    
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('PROGRESS');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log(`✅ Completed: ${completed}/20 (${((completed/20)*100).toFixed(0)}%)`);
    console.log(`🔄 In Progress: ${inProgress}/20 (${((inProgress/20)*100).toFixed(0)}%)`);
    console.log(`⏳ Pending: ${pending}/20 (${((pending/20)*100).toFixed(0)}%)`);
    
    if (completed === 20) {
      console.log('\n🎉 ALL TRANSCRIPTIONS COMPLETE!');
    } else if (inProgress > 0) {
      console.log('\n⏳ Transcriptions in progress... Check again in a few minutes.');
    } else if (pending > 0) {
      console.log('\n⚠️ Some visits still pending - audio may need to be uploaded.');
    }
    
  } catch (error) {
    console.error('\n❌ Status check failed:', error.message);
    process.exit(1);
  }
}

// Run
if (require.main === module) {
  checkStatus().catch(console.error);
}

module.exports = { checkStatus };
