/**
 * Authenticated API smoke load test (requires K6_EMAIL, K6_PASSWORD, K6_ROLE env vars)
 */
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = (__ENV.API_URL || 'https://api.anot.health').replace(/\/+$/, '') + '/api'

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: { http_req_failed: ['rate<0.05'] },
}

export function setup() {
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({
    email: __ENV.K6_EMAIL,
    password: __ENV.K6_PASSWORD,
    role: __ENV.K6_ROLE || 'clinician',
  }), { headers: { 'Content-Type': 'application/json' } })
  const token = res.json('token')
  return { token }
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` }
  const me = http.get(`${BASE}/auth/me`, { headers })
  check(me, { 'me 200': (r) => r.status === 200 })
  sleep(2)
}