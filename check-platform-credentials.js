const https = require('https');

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const csrf = await req({ 
    hostname: 'app.anot.health', 
    path: '/api/csrf-token', 
    method: 'GET', 
    headers: { 'User-Agent': 'Node', 'Origin': 'https://app.anot.health', 'Referer': 'https://app.anot.health/' } 
  });
  const sc = csrf.headers['set-cookie'];
  const cookie = sc ? sc.map(c => c.split(';')[0]).join('; ') : '';
  const tokenVal = JSON.parse(csrf.body).csrfToken;

  const accounts = [
    { email: process.env.SUPER_ADMIN_EMAIL || 'atiqurrahmanaline@gmail.com', pass: process.env.SUPER_ADMIN_PASSWORD || '', role: 'super_admin' },
    { email: process.env.CLINICIAN_EMAIL || 'amcknight2025@gmail.com', pass: process.env.CLINICIAN_PASSWORD || process.env.DEFAULT_TEST_PASSWORD || '', role: 'clinician' },
    { email: process.env.SCRIBE_EMAIL || 'sahib@anot.health', pass: process.env.SCRIBE_PASSWORD || process.env.DEFAULT_TEST_PASSWORD || '', role: 'scribe' },
    { email: process.env.QPS_EMAIL || 'farhan@docva.health', pass: process.env.QPS_PASSWORD || process.env.DEFAULT_TEST_PASSWORD || '', role: 'qps' },
    { email: process.env.ADMIN_EMAIL || 'ashikur@anot.health', pass: process.env.ADMIN_PASSWORD || process.env.DEFAULT_TEST_PASSWORD || '', role: 'admin' },
  ];

  console.log('--- TESTING ALL ACTIVE ROLES & CREDENTIALS ---');
  for (const acc of accounts) {
    const loginRes = await req({
      hostname: 'app.anot.health',
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'User-Agent': 'Node',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/',
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'X-CSRF-Token': tokenVal
      }
    }, JSON.stringify({ email: acc.email, password: acc.pass, force: true }));

    let resBody;
    try { resBody = JSON.parse(loginRes.body); } catch { resBody = loginRes.body; }

    if (loginRes.status === 200) {
      console.log(`[PASS] ${acc.role.padEnd(12)} | ${acc.email.padEnd(30)} | ID: ${resBody.user?.id} | Name: "${resBody.user?.name}"`);
    } else {
      console.log(`[FAIL] ${acc.role.padEnd(12)} | ${acc.email.padEnd(30)} | Status: ${loginRes.status}`, resBody);
    }
  }
})();
