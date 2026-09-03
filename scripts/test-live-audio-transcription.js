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
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d || '{}') });
          } catch (e) {
            resolve({ status: res.statusCode, body: { raw: d } });
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
  const loginRes = await doc.login('celina@anot.health', 'Password@2026');
  console.log('Doctor logged in:', loginRes.status, loginRes.body?.user?.name);

  const patRes = await doc.request('POST', '/api/patients', {
    name: 'Audio Test Patient',
    mrn: 'TEST-AUDIO-' + Math.floor(Math.random() * 90000 + 10000),
    dob: '1985-05-20'
  });
  const patientId = patRes.body?.patient?.id;
  console.log('Created Patient:', patientId);

  const visitRes = await doc.request('POST', '/api/visits', {
    patient_id: patientId,
    visit_type: 'Follow-up',
    visit_date: new Date().toISOString().split('T')[0],
    visit_time: '11:00'
  });
  const visitId = visitRes.body?.visit?.id;
  console.log('Created Visit:', visitId);

  console.log('Recording patient verbal consent...');
  const consentRes = await doc.request('POST', '/api/consent/recording', { visitId });
  console.log('Consent result:', consentRes.status, consentRes.body);

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const wav = createWavBuffer(2, 16000);

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([header, wav, footer]);

  console.log(`Uploading 2s audio to visit ${visitId}...`);
  const uploadRes = await doc.request('POST', `/api/audio/${visitId}`, multipartBody, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  });
  console.log('Upload Result:', uploadRes.status, uploadRes.body);

  console.log('Waiting for transcription pipeline to execute...');
  for (let i = 1; i <= 8; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const noteRes = await doc.request('GET', `/api/notes/visit/${visitId}`);
    const note = noteRes.body?.note;
    console.log(`[Poll ${i}] Status: ${note?.status} | Transcription: ${note?.transcription ? note.transcription.substring(0, 40) + '...' : '(none)'} | AI Draft: ${note?.ai_draft ? note.ai_draft.substring(0, 40) + '...' : '(none)'}`);
    if (note?.transcription || note?.ai_draft) {
      console.log('\n✅ Note detail successfully populated!');
      console.log('Full Note:', JSON.stringify(note, null, 2));
      break;
    }
  }
})();
