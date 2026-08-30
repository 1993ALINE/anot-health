const https = require('https');

let cookies = [];
let csrfToken = null;
let adminToken = null;

console.log('Creating production test clinician...\n');

// Step 1: Get CSRF token
function getCsrfToken() {
  return new Promise((resolve, reject) => {
    console.log('Step 1: Fetching CSRF token...');
    
    const options = {
      hostname: 'app.anot.health',
      port: 443,
      path: '/api/csrf-token',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        setCookies.forEach(cookie => {
          cookies.push(cookie.split(';')[0]);
        });
      }
      
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const response = JSON.parse(body);
          csrfToken = response.csrfToken;
          console.log(`✅ CSRF token obtained\n`);
          resolve();
        } else {
          reject(new Error(`CSRF fetch failed: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

// Step 2: Login as admin
function adminLogin() {
  return new Promise((resolve, reject) => {
    console.log('Step 2: Logging in as admin...');
    
    const data = JSON.stringify({
      email: 'atiqurrahmanaline@gmail.com',
      password: '#1Knowtex2026'
    });
    
    const options = {
      hostname: 'app.anot.health',
      port: 443,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      
      // Capture new cookies from login
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        setCookies.forEach(cookie => {
          const cookieValue = cookie.split(';')[0];
          const cookieName = cookieValue.split('=')[0];
          
          // Remove existing cookie with same name
          cookies = cookies.filter(c => !c.startsWith(cookieName + '='));
          
          // Add new cookie
          cookies.push(cookieValue);
        });
      }
      
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const response = JSON.parse(body);
          adminToken = response.token || response.accessToken || 'cookie-based';
          console.log(`✅ Admin logged in`);
          console.log(`   Response:`, JSON.stringify(response, null, 2));
          console.log(`   Cookies:`, cookies.length);
          console.log();
          resolve();
        } else {
          reject(new Error(`Admin login failed: ${res.statusCode} - ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Step 3: Create clinician
function createClinician() {
  return new Promise((resolve, reject) => {
    console.log('Step 3: Creating production test clinician...');
    
    const data = JSON.stringify({
      email: 'load-test-production@anot.health',
      firstName: 'Load',
      lastName: 'Test',
      role: 'clinician',
      password: 'LoadTestProd@2026',
      specialty: 'Internal Medicine'
    });
    
    const options = {
      hostname: 'app.anot.health',
      port: 443,
      path: '/api/admin/users',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Authorization': `Bearer ${adminToken}`,
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          const response = JSON.parse(body);
          console.log(`✅ Clinician created successfully!`);
          console.log(`   Email: load-test-production@anot.health`);
          console.log(`   Password: LoadTestProd@2026`);
          console.log(`   ID: ${response.userId || response.id || 'N/A'}\n`);
          resolve();
        } else {
          console.log(`⚠️ Create clinician response: ${res.statusCode} - ${body}\n`);
          reject(new Error(`Create clinician failed: ${res.statusCode} - ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Step 4: Verify clinician login
function verifyClinician() {
  return new Promise((resolve, reject) => {
    console.log('Step 4: Verifying clinician login...');
    
    const data = JSON.stringify({
      email: 'load-test-production@anot.health',
      password: 'LoadTestProd@2026'
    });
    
    const options = {
      hostname: 'app.anot.health',
      port: 443,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies.join('; '),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/'
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ Clinician login verified!\n`);
          console.log(`\n✅ PRODUCTION CLINICIAN READY FOR LOAD TEST\n`);
          console.log(`Update api-load-test.js with these credentials:`);
          console.log(`  email: 'load-test-production@anot.health'`);
          console.log(`  password: 'LoadTestProd@2026'\n`);
          resolve();
        } else {
          reject(new Error(`Clinician login verification failed: ${res.statusCode} - ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Run the process
async function run() {
  try {
    await getCsrfToken();
    await adminLogin();
    await createClinician();
    await verifyClinician();
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  }
}

run();
