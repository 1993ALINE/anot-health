import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.1'],
  },
}

export default function () {
  const url = 'https://app.anot.health'
  
  let res = http.get(`${url}/api/health`)
  check(res, { 'health 200': (r) => r.status === 200 })
  
  res = http.post(`${url}/api/auth/login`, {
    email: 'test@example.com',
    password: 'wrong',
  })
  check(res, { 'login 401/400': (r) => r.status === 401 || r.status === 400 })
  
  sleep(1)
}
