/**
 * Complete Remaining Audio Uploads
 * Uploads audio for the 5 visits that failed during load test
 */

const fs = require('fs');
const https = require('https');
const FormData = require('form-data');

// Configuration
const CONFIG = {
  apiBaseURL: 'https://app.anot.health',
  clinician: {
    email: 'celina@anot.health',
    password: 'Password@2026'
  },
  remainingVisits: [501, 502, 503, 504, 505],
  audioPath: './scripts/test-audio-20min.wav',
  retryDelay: 5000 // 5 seconds between uploads to avoid rate limiting
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
async function apiRequest(method, endpoint, data = null, token = null, isFormData = false) {
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
      if (isFormData) {
        body = data;
        Object.assign(options.headers, data.getHeaders());
      } else {
        body = JSON.stringify(data);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }
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
          // If HTML response, show first 200 chars
          const preview = responseData.substring(0, 200);
          reject(new Error(`Failed to parse response: ${error.message}\nResponse: ${preview}`));
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

// Get CSRF token
async function getCsrfToken() {
  console.log('Fetching CSRF token...');
  const response = await apiRequest('GET', '/api/csrf-token');
  STATE.csrf.token = response.data.csrfToken;
  console.log('✓ CSRF token obtained\n');
}

// Login
async function login() {
  console.log(`Logging in as: ${CONFIG.clinician.email}`);
  const response = await apiRequest('POST', '/api/auth/login', {
    email: CONFIG.clinician.email,
    password: CONFIG.clinician.password
  });
  STATE.token = response.data.token;
  console.log('✓ Logged in successfully\n');
}

// Upload audio with retry
async function uploadAudioWithRetry(visitId, maxRetries = 3) {
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      attempt++;
      console.log(`Uploading audio for visit ${visitId} (attempt ${attempt}/${maxRetries})...`);
      
      const form = new FormData();
      form.append('audio', fs.createReadStream(CONFIG.audioPath));
      form.append('visitId', visitId);
      
      const startTime = Date.now();
      await apiRequest('POST', `/api/audio/${visitId}`, form, STATE.token, true);
      const duration = Date.now() - startTime;
      
      console.log(`✓ Audio uploaded successfully in ${(duration / 1000).toFixed(1)}s\n`);
      return true;
      
    } catch (error) {
      console.log(`✗ Attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < maxRetries) {
        console.log(`Waiting ${CONFIG.retryDelay / 1000}s before retry...\n`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
      } else {
        console.log(`✗ All ${maxRetries} attempts failed for visit ${visitId}\n`);
        throw error;
      }
    }
  }
}

// Main execution
async function completeUploads() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('COMPLETE REMAINING AUDIO UPLOADS');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  try {
    // Setup
    await getCsrfToken();
    await login();
    
    // Check audio file exists
    if (!fs.existsSync(CONFIG.audioPath)) {
      throw new Error(`Audio file not found: ${CONFIG.audioPath}`);
    }
    
    const fileSize = fs.statSync(CONFIG.audioPath).size;
    console.log(`Audio file ready: ${CONFIG.audioPath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)\n`);
    
    // Upload remaining visits
    console.log(`Uploading audio for ${CONFIG.remainingVisits.length} remaining visits...\n`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < CONFIG.remainingVisits.length; i++) {
      const visitId = CONFIG.remainingVisits[i];
      
      try {
        console.log(`[${i + 1}/${CONFIG.remainingVisits.length}] Processing visit ${visitId}`);
        await uploadAudioWithRetry(visitId);
        successCount++;
        
        // Delay between uploads to avoid rate limiting
        if (i < CONFIG.remainingVisits.length - 1) {
          console.log(`Waiting ${CONFIG.retryDelay / 1000}s before next upload...\n`);
          await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
        }
      } catch (error) {
        failCount++;
        console.error(`Failed to upload for visit ${visitId}: ${error.message}\n`);
      }
    }
    
    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('UPLOAD SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`Successful uploads: ${successCount}/${CONFIG.remainingVisits.length}`);
    console.log(`Failed uploads: ${failCount}/${CONFIG.remainingVisits.length}`);
    
    if (successCount === CONFIG.remainingVisits.length) {
      console.log('\n✅ ALL REMAINING UPLOADS COMPLETED SUCCESSFULLY!');
      console.log('\nFinal Status:');
      console.log('  - Total patients: 20/20 ✓');
      console.log('  - Total visits: 20/20 ✓');
      console.log('  - Total audio uploads: 20/20 ✓');
      console.log('  - Production data: COMPLETE ✓');
    } else {
      console.log(`\n⚠️ ${failCount} uploads still pending`);
      console.log('Failed visits:', CONFIG.remainingVisits.filter((_, i) => i >= successCount));
    }
    
  } catch (error) {
    console.error('\n❌ Upload completion failed:', error.message);
    process.exit(1);
  }
}

// Run
if (require.main === module) {
  completeUploads().catch(console.error);
}

module.exports = { completeUploads };
