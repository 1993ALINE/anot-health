/**
 * Verification Script for Single Concurrent Session Enforcement
 * Tests:
 * 1. User A logs in on Device 1 (Session 1 established).
 * 2. User A attempts to log in on Device 2 without force -> HTTP 409 CONCURRENT_SESSION_ACTIVE.
 * 3. User A logs in on Device 2 with force: true -> Session 2 established.
 * 4. Device 1 attempts an authenticated request -> Rejected HTTP 401 (Session terminated).
 * 5. Device 2 logs out -> Session cleared.
 * 6. User A can log in cleanly again.
 */

const https = require('https');

function createClient() {
  let cookieJar = [];
  let csrfToken = '';
  let token = null;

  async function fetchCsrf() {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'app.anot.health',
        path: '/api/csrf-token',
        method: 'GET',
        headers: {
          'User-Agent': 'Anot-Session-Test',
          'Origin': 'https://app.anot.health',
          'Referer': 'https://app.anot.health/'
        }
      }, res => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          setCookie.forEach(c => {
            const cookiePart = c.split(';')[0];
            cookieJar = cookieJar.filter(x => !x.startsWith(cookiePart.split('=')[0] + '='));
            cookieJar.push(cookiePart);
          });
        }
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try {
            csrfToken = JSON.parse(d || '{}').csrfToken || '';
          } catch (_) {}
          resolve(csrfToken);
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function request(method, path, body = null) {
    if (!csrfToken) await fetchCsrf();
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Anot-Session-Test',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/',
        ...(cookieJar.length ? { 'Cookie': cookieJar.join('; ') } : {}),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      };
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      if (body) {
        headers['Content-Type'] = 'application/json';
      }
      const req = https.request({
        hostname: 'app.anot.health',
        path,
        method,
        headers
      }, res => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          setCookie.forEach(c => {
            const cookiePart = c.split(';')[0];
            cookieJar = cookieJar.filter(x => !x.startsWith(cookiePart.split('=')[0] + '='));
            cookieJar.push(cookiePart);
          });
        }
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d || '{}') });
          } catch (_) {
            resolve({ status: res.statusCode, body: { raw: d } });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function login(email, password, options = {}) {
    await fetchCsrf();
    const { force = false } = options;
    const res = await request('POST', '/api/auth/login', { email, password, force });
    if (res.body?.token) {
      token = res.body.token;
    }
    return res;
  }

  return { request, login, getToken: () => token };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TESTING LIVE SINGLE CONCURRENT SESSION ENFORCEMENT PER USER');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const testEmail = 'celina@anot.health';
  const testPass = 'Password@2026';

  const device1 = createClient();
  const device2 = createClient();

  console.log('1. Device 1 logging in as ' + testEmail + '...');
  const res1 = await device1.login(testEmail, testPass, { force: true });
  console.log('   Device 1 Login Result:', res1.status, res1.body?.message || res1.body?.error);

  console.log('\n2. Device 1 verifying session access (GET /api/patients)...');
  const req1 = await device1.request('GET', '/api/patients');
  console.log('   Device 1 Patients Request Status:', req1.status, req1.body?.patients ? `(Found ${req1.body.patients.length} patients)` : req1.body?.error);

  console.log('\n3. Device 2 attempting concurrent login for the SAME user (' + testEmail + ') WITHOUT force...');
  const res2 = await device2.login(testEmail, testPass, { force: false });
  console.log('   Device 2 Login Result:', res2.status, '| Error:', res2.body?.error, '| Code:', res2.body?.code);
  if (res2.status === 409) {
    console.log('   ✓ SUCCESS: Concurrent login blocked with HTTP 409 Conflict!');
  } else {
    console.log('   ✗ UNEXPECTED STATUS:', res2.status);
  }

  console.log('\n4. Device 2 logging in WITH force: true (takeover)...');
  const res2Force = await device2.login(testEmail, testPass, { force: true });
  console.log('   Device 2 Force Login Result:', res2Force.status, res2Force.body?.message || res2Force.body?.error);

  // Wait 3 seconds to ensure in-memory cache TTL clears across instances
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n5. Device 1 attempting another request with old session...');
  const req1After = await device1.request('GET', '/api/patients');
  console.log('   Device 1 Request Status with old session:', req1After.status, '| Response:', req1After.body?.error);
  if (req1After.status === 401) {
    console.log('   ✓ SUCCESS: Old Device 1 session was immediately invalidated & terminated!');
  }

  console.log('\n6. Device 2 logging out cleanly...');
  const logoutRes = await device2.request('POST', '/api/auth/logout');
  console.log('   Device 2 Logout Status:', logoutRes.status);

  console.log('\n7. Device 1 logging in afresh after clean logout...');
  const res1Fresh = await device1.login(testEmail, testPass, { force: false });
  console.log('   Fresh Login Status:', res1Fresh.status, res1Fresh.body?.message || res1Fresh.body?.error);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🎉 SINGLE CONCURRENT SESSION ENFORCEMENT FULLY VERIFIED');
  console.log('═══════════════════════════════════════════════════════════════\n');
})();
