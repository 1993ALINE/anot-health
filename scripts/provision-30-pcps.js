/**
 * provision-30-pcps.js
 * Ensures 30 Primary Care Physician (PCP) accounts are registered and initialized with active session tokens.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const HOSTNAME = 'app.anot.health';
const PASSWORD = 'Password@2026';
const SESSIONS_CACHE_FILE = path.join(__dirname, '.pcp-sessions.json');

function createClient() {
  let cookieJar = [];
  let csrfToken = '';
  let token = null;

  async function request(method, reqPath, body = null) {
    if (!csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      await fetchCsrf();
    }
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Anot-Workflow-Test',
        'Origin': `https://${HOSTNAME}`,
        'Referer': `https://${HOSTNAME}/`,
        ...(cookieJar.length ? { 'Cookie': cookieJar.join('; ') } : {}),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {})
      };
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      if (body) {
        headers['Content-Type'] = 'application/json';
      }
      const req = https.request({ hostname: HOSTNAME, path: reqPath, method, headers }, res => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          setCookie.forEach(c => {
            const cookiePart = c.split(';')[0];
            cookieJar = cookieJar.filter(x => !x.startsWith(cookiePart.split('=')[0] + '='));
            cookieJar.push(cookiePart);
          });
        }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d || '{}') });
          } catch (e) {
            resolve({ status: res.statusCode, body: { raw: d } });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function fetchCsrf() {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: HOSTNAME,
        path: '/api/csrf-token',
        method: 'GET',
        headers: {
          'User-Agent': 'Anot-Workflow-Test',
          'Origin': `https://${HOSTNAME}`,
          'Referer': `https://${HOSTNAME}/`
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
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const p = JSON.parse(d || '{}');
            csrfToken = p.csrfToken;
            resolve(csrfToken);
          } catch (_) {
            resolve('');
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function login(email, password) {
    await fetchCsrf();
    const res = await request('POST', '/api/auth/login', { email, password, force: true });
    if (res.body?.token) token = res.body.token;
    if (res.body?.requirePhiTraining && res.body?.temporaryToken) {
      const phiRes = await request('POST', '/api/auth/acknowledge-phi-training', {
        temporaryToken: res.body.temporaryToken
      });
      if (phiRes.body?.token) token = phiRes.body.token;
      return phiRes;
    }
    return res;
  }

  return { request, login, getToken: () => token, getCookies: () => cookieJar };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function provisionAllPCPs() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PROVISIONING & AUTHENTICATING 30 PRIMARY CARE PHYSICIANS (PCPS)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const admin = createClient();
  const adminLogin = await admin.login('ashikur@anot.health', PASSWORD);
  if (adminLogin.status !== 200) {
    throw new Error(`Admin login failed: status ${adminLogin.status}`);
  }
  console.log('✓ Admin authenticated successfully.');

  const usersRes = await admin.request('GET', '/api/users');
  const existingUsers = usersRes.body?.users || [];
  const existingEmailSet = new Set(existingUsers.map(u => u.email.toLowerCase()));

  const pcpCredentials = [];

  for (let i = 1; i <= 30; i++) {
    const numStr = String(i).padStart(2, '0');
    const email = `dr.pcp${numStr}@anot.health`;
    const name = `Dr. Primary Care Physician ${numStr}`;

    if (!existingEmailSet.has(email.toLowerCase())) {
      console.log(`[Registering ${i}/30] Creating ${name} (${email})...`);
      const regRes = await admin.request('POST', '/api/auth/register', {
        name,
        email,
        role: 'clinician',
        password: PASSWORD,
        specialty: 'Primary Care'
      });
      if (regRes.status !== 201) {
        console.error(`  ↳ Failed to register ${email}:`, regRes.status, regRes.body);
      } else {
        console.log(`  ✓ Registered successfully (ID ${regRes.body?.user?.id})`);
      }
      await delay(150); // slight pacing
    } else {
      console.log(`[Found ${i}/30] ${name} (${email}) already registered.`);
    }

    pcpCredentials.push({ index: i, name, email, password: PASSWORD });
  }

  console.log('\n--- Authenticating all 30 PCPs & Obtaining Sessions ---');
  const sessions = [];

  for (const cred of pcpCredentials) {
    process.stdout.write(`Authenticating PCP #${cred.index} (${cred.email})... `);
    const client = createClient();
    const loginRes = await client.login(cred.email, cred.password);
    const token = client.getToken();
    if (loginRes.status === 200 && token) {
      console.log(`OK (User ID: ${loginRes.body?.user?.id || 'active'})`);
      sessions.push({
        index: cred.index,
        id: loginRes.body?.user?.id,
        name: cred.name,
        email: cred.email,
        token,
        cookies: client.getCookies()
      });
    } else {
      console.error(`FAILED (Status: ${loginRes.status})`, loginRes.body);
    }
    await delay(100);
  }

  console.log(`\nSuccessfully authenticated ${sessions.length}/30 PCPs.`);
  fs.writeFileSync(SESSIONS_CACHE_FILE, JSON.stringify(sessions, null, 2));
  console.log(`Session cache saved to ${SESSIONS_CACHE_FILE}`);
  return sessions;
}

if (require.main === module) {
  provisionAllPCPs().catch(err => {
    console.error('Fatal error in provision script:', err);
    process.exit(1);
  });
}

module.exports = { provisionAllPCPs, createClient };
