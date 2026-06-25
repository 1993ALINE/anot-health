const {
  csrfProtection,
  csrfTokenRoute,
  clearCsrfCookie,
  csrfCookieOptions,
  isValidToken,
  getTokenCookieName,
  LEGACY_DEV_COOKIE,
} = require('../middleware/csrf')

function mockReq(method, { cookies = {}, headers = {}, url = '/api/patients' } = {}) {
  return {
    method,
    cookies,
    originalUrl: url,
    url,
    get(name) {
      return headers[name.toLowerCase()] || headers[name] || undefined
    },
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    cookieArgs: null,
    clearedCookies: [],
  }
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (data) => {
    res.body = data
    return res
  }
  res.cookie = (name, value, opts) => {
    res.cookieArgs = { name, value, opts }
    return res
  }
  res.clearCookie = (name, opts) => {
    res.clearedCookies.push({ name, opts })
    return res
  }
  res.setHeader = (k, v) => {
    res.headers[k] = v
    return res
  }
  return res
}

describe('csrf middleware (stateless double-submit)', () => {
  test('csrfTokenRoute reuses existing cookie token', () => {
    const token = 'a'.repeat(64)
    const cookieName = getTokenCookieName()
    const req = mockReq('GET', { cookies: { [cookieName]: token } })
    const res = mockRes()
    csrfTokenRoute(req, res)
    expect(res.body).toEqual({ csrfToken: token, cookieName })
    expect(res.cookieArgs.value).toBe(token)
    expect(res.cookieArgs.opts.maxAge).toBeGreaterThan(0)
  })

  test('csrfTokenRoute generates token when cookie missing', () => {
    const req = mockReq('GET')
    const res = mockRes()
    csrfTokenRoute(req, res)
    expect(res.body.csrfToken).toMatch(/^[a-f0-9]{64}$/)
    expect(res.cookieArgs.value).toBe(res.body.csrfToken)
  })

  test('csrfTokenRoute reuses legacy csrf_token cookie in production mode', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const token = 'f'.repeat(64)
    const req = mockReq('GET', { cookies: { [LEGACY_DEV_COOKIE]: token } })
    const res = mockRes()
    csrfTokenRoute(req, res)
    expect(res.body.csrfToken).toBe(token)
    expect(res.cookieArgs.name).toBe('__Host-csrf_token')
    process.env.NODE_ENV = prev
  })

  test('csrfProtection allows mutating request when header matches cookie', () => {
    const token = 'b'.repeat(64)
    const cookieName = getTokenCookieName()
    const req = mockReq('POST', {
      cookies: { [cookieName]: token },
      headers: { 'x-csrf-token': token },
    })
    const res = mockRes()
    const next = jest.fn()
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
  })

  test('csrfProtection rejects missing or mismatched token', () => {
    const token = 'c'.repeat(64)
    const cookieName = getTokenCookieName()
    const req = mockReq('POST', {
      cookies: { [cookieName]: token },
      headers: { 'x-csrf-token': 'd'.repeat(64) },
    })
    const res = mockRes()
    csrfProtection(req, res, jest.fn())
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  test('csrfProtection rejects POST without CSRF header', () => {
    const token = 'e'.repeat(64)
    const cookieName = getTokenCookieName()
    const req = mockReq('POST', { cookies: { [cookieName]: token } })
    const res = mockRes()
    csrfProtection(req, res, jest.fn())
    expect(res.statusCode).toBe(403)
  })

  test('csrfProtection skips webhook paths (HMAC auth)', () => {
    const req = mockReq('POST', { headers: {} })
    req.originalUrl = '/api/webhooks/deepgram'
    const res = mockRes()
    const next = jest.fn()
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  test('clearCsrfCookie clears production and legacy cookie names', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const res = mockRes()
    clearCsrfCookie(res)
    expect(res.clearedCookies.map((c) => c.name)).toEqual(['__Host-csrf_token', 'csrf_token'])
    process.env.NODE_ENV = prev
  })

  test('csrfCookieOptions uses strict SameSite and readable cookie (not httpOnly)', () => {
    const opts = csrfCookieOptions()
    expect(opts.sameSite).toBe('strict')
    expect(opts.httpOnly).toBe(false)
    expect(opts.path).toBe('/')
    expect(opts.maxAge).toBeGreaterThan(0)
  })

  test('isValidToken accepts 64-char hex only', () => {
    expect(isValidToken('a'.repeat(64))).toBe(true)
    expect(isValidToken('short')).toBe(false)
    expect(isValidToken(null)).toBe(false)
  })
})

describe('csrf integration (express stack)', () => {
  const express = require('express')
  const cookieParser = require('cookie-parser')

  let server
  let baseUrl

  beforeAll(async () => {
    const app = express()
    app.use(cookieParser())
    app.get('/api/csrf-token', csrfTokenRoute)
    app.use('/api', csrfProtection)
    app.post('/api/assignments', (req, res) => {
      res.status(201).json({ ok: true })
    })

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('POST without CSRF token returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clinician_id: 1, scribe_id: 2 }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/csrf/i)
  })

  test('POST with matching cookie + X-CSRF-Token header succeeds', async () => {
    const tokenRes = await fetch(`${baseUrl}/api/csrf-token`)
    expect(tokenRes.status).toBe(200)
    const { csrfToken } = await tokenRes.json()
    expect(csrfToken).toMatch(/^[a-f0-9]{64}$/)
    const cookieName = getTokenCookieName()

    const res = await fetch(`${baseUrl}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${cookieName}=${csrfToken}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ clinician_id: 1, scribe_id: 2 }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('parallel safe GETs do not rotate CSRF cookie away from /csrf-token value', async () => {
    const tokenRes = await fetch(`${baseUrl}/api/csrf-token`)
    const { csrfToken } = await tokenRes.json()
    const cookieName = getTokenCookieName()

    await Promise.all([
      fetch(`${baseUrl}/api/assignments`, {
        headers: { Cookie: `${cookieName}=${csrfToken}` },
      }),
      fetch(`${baseUrl}/api/assignments`, {
        headers: { Cookie: `${cookieName}=${csrfToken}` },
      }),
    ])

    const res = await fetch(`${baseUrl}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${cookieName}=${csrfToken}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ clinician_id: 1, scribe_id: 2 }),
    })
    expect(res.status).toBe(201)
  })
})
