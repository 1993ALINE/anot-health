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
    { email: 'atiqurrahmanaline@gmail.com', pass: '#1Augmedix2026', role: 'super_admin' },
    { email: 'amcknight2025@gmail.com', pass: 'Password@2026', role: 'clinician' },
    { email: 'sahib@anot.health', pass: 'Password@2026', role: 'scribe' },
    { email: 'farhan@docva.health', pass: 'Password@2026', role: 'qps' },
    { email: 'ashikur@anot.health', pass: 'Password@2026', role: 'admin' },
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
