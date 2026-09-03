const https = require('https');

function createClient() {
  let cookieJar = [];
  let csrfToken = '';
  let token = null;

  async function request(method, path, body = null, customHeaders = {}) {
    if (!csrfToken) {
      await fetchCsrf();
    }
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Anot-Workflow-Test',
        'Origin': 'https://app.anot.health',
        'Referer': 'https://app.anot.health/',
        ...(cookieJar.length ? { 'Cookie': cookieJar.join('; ') } : {}),
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        ...customHeaders
      };
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      if (body && !customHeaders['Content-Type']) {
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
        let d = [];
        res.on('data', chunk => d.push(chunk));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(d);
          const rawStr = rawBuffer.toString('utf8');
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(rawStr), buffer: rawBuffer });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, body: { raw: rawStr }, buffer: rawBuffer });
          }
        });
      });
      req.on('error', reject);
      if (body) {
        if (Buffer.isBuffer(body)) req.write(body);
        else if (typeof body === 'string') req.write(body);
        else req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async function fetchCsrf() {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'app.anot.health',
        path: '/api/csrf-token',
        method: 'GET',
        headers: {
          'User-Agent': 'Anot-Workflow-Test',
          'Origin': 'https://app.anot.health',
          'Referer': 'https://app.anot.health/'
        }
      }, res => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          setCookie.forEach(c => {
            const cookiePart = c.split(';')[0];
            cookieJar.push(cookiePart);
          });
        }
        let d = '';
        res.on('data', chunk => d += chunk);
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

  async function login(email, password, options = { force: true }) {
    await fetchCsrf();
    const { force = true } = options;
    const res = await request('POST', '/api/auth/login', { email, password, force });
    if (res.body?.token) {
      token = res.body.token;
    }
    return res;
  }

  return { request, login, getToken: () => token };
}

function createWavBuffer(durationSec = 2, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5 * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  return buffer;
}

(async () => {
  const doc = createClient();
  await doc.login('celina@anot.health', 'Password@2026');

  // Create Patient & Visit
  const patRes = await doc.request('POST', '/api/patients', {
    name: 'Dual Recording Patient',
    mrn: 'DUAL-' + Math.floor(Math.random() * 90000 + 10000),
    dob: '1990-01-01'
  });
  const patientId = patRes.body?.patient?.id;

  const visitRes = await doc.request('POST', '/api/visits', {
    patient_id: patientId,
    visit_type: 'Follow-up',
    visit_date: new Date().toISOString().split('T')[0],
    visit_time: '14:00'
  });
  const visitId = visitRes.body?.visit?.id;
  console.log('Created visit:', visitId);

  // Consent
  await doc.request('POST', '/api/consent/recording', { visitId });

  // 1st Audio Recording Upload
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const wav1 = createWavBuffer(2, 16000);
  const header1 = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="rec1.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body1 = Buffer.concat([header1, wav1, footer]);

  console.log('Uploading 1st audio...');
  const up1 = await doc.request('POST', `/api/audio/${visitId}`, body1, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  });
  console.log('1st Upload Status:', up1.status, up1.body);

  // 2nd Audio Recording (Append)
  const wav2 = createWavBuffer(3, 16000);
  const header2 = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="rec2.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const body2 = Buffer.concat([header2, wav2, footer]);

  console.log('Uploading 2nd audio (Additional Recording)...');
  const up2 = await doc.request('POST', `/api/audio/${visitId}/append`, body2, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  });
  console.log('2nd Upload Status:', up2.status, up2.body);

  // Test Count
  const countRes = await doc.request('GET', `/api/audio/${visitId}/count`);
  console.log('Audio Count:', countRes.status, countRes.body);

  // Test Stream Index 0
  const stream0 = await doc.request('GET', `/api/audio/${visitId}?index=0`);
  console.log('Stream 0 Status:', stream0.status, 'Bytes:', stream0.buffer.length, 'Content-Type:', stream0.headers['content-type']);

  // Test Stream Index 1
  const stream1 = await doc.request('GET', `/api/audio/${visitId}?index=1`);
  console.log('Stream 1 Status:', stream1.status, 'Bytes:', stream1.buffer.length, 'Content-Type:', stream1.headers['content-type']);
})();
