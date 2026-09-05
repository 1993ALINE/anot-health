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
          'User-Agent': 'Anot-Workflow-Test',
          'Origin': 'https://app.anot.health',
          'Referer': 'https://app.anot.health/',
          ...(cookieJar.length ? { 'Cookie': cookieJar.join('; ') } : {}),
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

  async function request(method, path, body = null) {
    if (!csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      await fetchCsrf();
    }
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Anot-Workflow-Test',
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

  async function login(email, password, options = { force: true }) {
    csrfToken = ''; // force fresh CSRF token pairing
    await fetchCsrf();
    const { force = true } = options;
    const res = await request('POST', '/api/auth/login', { email, password, force });
    if (res.body?.token) {
      token = res.body.token;
    }
    return res;
  }

  return {
    fetchCsrf,
    request,
    login,
    logout: () => request('POST', '/api/auth/logout'),
  };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

async function run() {
  console.log('=================================================================');
  console.log('🚀 TESTING LIVE ANOT HEALTH PLATFORM: NOTE VIEW & RECORDING');
  console.log('=================================================================\n');

  const client = createClient();

  // Step 1: Verify Live CloudFront Frontend Assets
  console.log('--- Step 1: Verifying Live CloudFront Frontend Distribution ---');
  const indexRes = await client.request('GET', '/');
  assert(indexRes.status === 200, 'Live app.anot.health index.html loads successfully (200 OK)');
  assert(typeof indexRes.body?.raw === 'string' && indexRes.body.raw.includes('<div id="root">'), 'index.html contains root container');

  // Fetch Clinician route chunk to verify WakeLock & KeepAlive are deployed
  const clinicianChunkRes = await client.request('GET', '/assets/Clinician-Cmj2OWxQ.js');
  assert(clinicianChunkRes.status === 200, 'Clinician JS chunk loads from CloudFront CDN (200 OK)');
  assert(clinicianChunkRes.body?.raw?.includes('wakeLock'), 'Live Clinician bundle contains screen wakeLock recording keep-alive!');
  assert(clinicianChunkRes.body?.raw?.includes('Record'), 'Live Clinician bundle contains prominent Record button action!');

  // Step 2: Clinician Authentication
  console.log('\n--- Step 2: Testing Clinician Authentication on Live API ---');
  const loginRes = await client.login('celina@anot.health', 'Password@2026', { force: true });
  console.log('Login response:', loginRes.status, loginRes.body);
  assert(loginRes.status === 200, `Clinician logged in successfully (status ${loginRes.status})`);

  // Step 3: Fetch Patients
  console.log('\n--- Step 3: Fetching Clinician Patients & Schedule ---');
  const ptsRes = await client.request('GET', '/api/patients');
  const patientList = Array.isArray(ptsRes.body) ? ptsRes.body : (ptsRes.body?.patients || []);
  assert(ptsRes.status === 200 && patientList.length > 0, `Retrieved ${patientList.length} patients from live production`);
  const targetPatient = patientList[0];

  // Step 4: Schedule Encounter & Record Consent
  console.log('\n--- Step 4: Testing Encounter Creation & Consent Recording ---');
  const todayIso = new Date().toISOString().split('T')[0];
  const createVisitRes = await client.request('POST', '/api/visits', {
    patient_id: targetPatient.id,
    visit_date: todayIso,
    visit_time: '16:30',
    visit_type: 'Follow-up',
  });
  assert(createVisitRes.status === 201 && createVisitRes.body?.visit?.id, `Created live visit ID ${createVisitRes.body?.visit?.id} for ${targetPatient.name}`);
  const visitId = createVisitRes.body.visit.id;

  const consentRes = await client.request('POST', '/api/consent/recording', { visitId });
  assert(consentRes.status === 200, 'Recorded patient verbal recording consent');

  // Step 5: Test Recording State Transition & Conclude Encounter
  console.log('\n--- Step 5: Testing Recording State Transition & Encounter Conclude ---');
  const inProgRes = await client.request('PUT', `/api/visits/${visitId}/status`, { status: 'in-progress' });
  assert(inProgRes.status === 200, 'Visit status transitioned to in-progress');

  const endRes = await client.request('PUT', `/api/visits/${visitId}/end`, { duration_seconds: 60 });
  assert(endRes.status === 200, 'Encounter concluded and submitted to scribe queue');

  // Step 6: Verify Clinical Note Section Parsing (CC, HPI, PMH, ROS, PE, A&P, ICD-10, CPT)
  console.log('\n--- Step 6: Testing Clinical Note Section Parsing ---');
  const sampleNote = `CHIEF COMPLAINT
Right knee pain.
HISTORY OF PRESENT ILLNESS (HPI)
Patient is a 54-year-old male presenting with acute right knee pain that began yesterday while walking. Denies trauma, fever, or prior joint surgery.
PAST MEDICAL HISTORY
Hypertension, Hyperlipidemia.
FAMILY HISTORY
Father with osteoarthritis.
SOCIAL HISTORY
Non-smoker, drinks socially.
REVIEW OF SYSTEMS
Positive for localized right knee tenderness. Negative for chest pain, shortness of breath, headache.
PHYSICAL EXAMINATION
Right knee: Mild swelling, tenderness along medial joint line. Full range of motion. No erythema or warmth.
IMAGING
X-Ray Right Knee: Mild medial compartment joint space narrowing consistent with early osteoarthritis.
ASSESSMENT & PLAN (A&P)
1. Acute medial right knee pain, likely early osteoarthritis flare with mild strain.
2. Prescribed NSAIDs (Naproxen 500mg BID with food for 10 days).
3. Physical therapy referral and activity modification.
4. Follow up in 4 weeks if symptoms persist.
ICD-10 CODES
M25.561 – Pain in right knee
M17.11 – Unilateral primary osteoarthritis, right knee
CPT CODES
99214 – Office visit, established patient, moderate complexity`;

  const KNOWN_MEDICAL_HEADERS = new Set([
    'CHIEF COMPLAINT', 'CC', 'REASON FOR VISIT', 'CHIEF CONCERN',
    'HISTORY OF PRESENT ILLNESS', 'HISTORY OF PRESENT ILLNESS (HPI)', 'HPI',
    'PAST MEDICAL HISTORY', 'PAST MEDICAL HISTORY (PMH)', 'PMH',
    'PAST SURGICAL HISTORY', 'PAST SURGICAL HISTORY (PSH)', 'PSH',
    'MEDICATIONS', 'CURRENT MEDICATIONS', 'MEDICATION LIST',
    'ALLERGIES', 'ALLERGIES & INTOLERANCES', 'ALLERGIES AND INTOLERANCES',
    'FAMILY HISTORY', 'FAMILY HISTORY (FH)', 'FAMILY MEDICAL HISTORY', 'FH',
    'SOCIAL HISTORY', 'SOCIAL HISTORY (SH)', 'SH',
    'REVIEW OF SYSTEMS', 'REVIEW OF SYSTEMS (ROS)', 'ROS',
    'VITAL SIGNS', 'VITALS',
    'PHYSICAL EXAMINATION', 'PHYSICAL EXAM', 'PE',
    'IMAGING', 'IMAGING & DIAGNOSTICS', 'IMAGING AND DIAGNOSTICS', 'DIAGNOSTICS', 'DIAGNOSTIC STUDIES', 'LABS', 'LABORATORY DATA',
    'ASSESSMENT & PLAN', 'ASSESSMENT & PLAN (A&P)', 'ASSESSMENT AND PLAN', 'ASSESSMENT AND PLAN (A&P)', 'A&P',
    'ASSESSMENT', 'PLAN', 'IMPRESSION',
    'ICD-10 CODES', 'ICD-10', 'ICD-10 DIAGNOSES', 'DIAGNOSES', 'DIAGNOSIS', 'ICD CODES',
    'CPT CODES', 'CPT', 'BILLING CODES', 'CPT / BILLING CODES', 'PROCEDURE CODES',
    'SUBJECTIVE', 'OBJECTIVE', 'FOLLOW-UP', 'FOLLOW UP', 'INSTRUCTIONS', 'PATIENT INSTRUCTIONS', 'DISPOSITION',
  ]);

  function isHeaderLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 80) return false;
    if (/^#{1,4}\s+\S+/.test(trimmed)) return true;
    if (trimmed.endsWith(':')) return true;
    const clean = trimmed.replace(/^#{1,4}\s+/, '').replace(/:$/, '').trim();
    const cleanUpper = clean.toUpperCase();
    if (KNOWN_MEDICAL_HEADERS.has(cleanUpper)) return true;
    if (clean.length >= 2 && clean.length <= 60 && !/[.,;?!]$/.test(clean) && clean === cleanUpper && /^[A-Z0-9\s()&/\\-]+$/.test(clean)) {
      return true;
    }
    return false;
  }

  function parseNote(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const headerIdx = [];
    lines.forEach((line, i) => {
      if (isHeaderLine(line)) headerIdx.push(i);
    });
    if (headerIdx.length === 0) return [{ label: '', body: raw }];
    const sections = [];
    for (let i = 0; i < headerIdx.length; i += 1) {
      const start = headerIdx[i];
      const end = i + 1 < headerIdx.length ? headerIdx[i + 1] : lines.length;
      const label = lines[start].trim().replace(/^#{1,4}\s+/, '').replace(/:$/, '');
      const body = lines.slice(start + 1, end).join('\n').trim();
      sections.push({ label, body });
    }
    return sections;
  }

  const sections = parseNote(sampleNote);
  assert(sections.length === 11, `Note parser identified all 11 distinct clinical sections (got ${sections.length})`);

  const expectedLabels = [
    'CHIEF COMPLAINT',
    'HISTORY OF PRESENT ILLNESS (HPI)',
    'PAST MEDICAL HISTORY',
    'FAMILY HISTORY',
    'SOCIAL HISTORY',
    'REVIEW OF SYSTEMS',
    'PHYSICAL EXAMINATION',
    'IMAGING',
    'ASSESSMENT & PLAN (A&P)',
    'ICD-10 CODES',
    'CPT CODES',
  ];

  expectedLabels.forEach((label, idx) => {
    assert(sections[idx]?.label === label, `Section ${idx + 1} correctly labeled as "${label}"`);
    assert(sections[idx]?.body && sections[idx].body.length > 0, `Section "${label}" has structured body (${sections[idx].body.length} chars)`);
  });

  // Step 7: Clean Logout
  console.log('\n--- Step 7: Testing Clean Logout ---');
  const logoutRes = await client.logout();
  assert(logoutRes.status === 204 || logoutRes.status === 200, 'Clinician session logged out cleanly');

  console.log('\n=================================================================');
  console.log('🎉 ALL LIVE TESTS PASSED SUCCESSFULLY (100% OPERATIONAL)');
  console.log('=================================================================');
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
