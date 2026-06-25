const { csrfProtection, csrfTokenRoute, clearCsrfCookie, TOKEN_COOKIE } = require('../middleware/csrf')

function mockReq(method, { cookies = {}, headers = {} } = {}) {
  return {
    method,
    cookies,
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
    clearedCookie: null,
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
    res.clearedCookie = { name, opts }
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
    const req = mockReq('GET', { cookies: { [TOKEN_COOKIE]: token } })
    const res = mockRes()
    csrfTokenRoute(req, res)
    expect(res.body).toEqual({ csrfToken: token })
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

  test('csrfProtection allows mutating request when header matches cookie', () => {
    const token = 'b'.repeat(64)
    const req = mockReq('POST', {
      cookies: { [TOKEN_COOKIE]: token },
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
    const req = mockReq('POST', {
      cookies: { [TOKEN_COOKIE]: token },
      headers: { 'x-csrf-token': 'd'.repeat(64) },
    })
    const res = mockRes()
    csrfProtection(req, res, jest.fn())
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/csrf/i)
  })

  test('clearCsrfCookie clears the csrf_token cookie', () => {
    const res = mockRes()
    clearCsrfCookie(res)
    expect(res.clearedCookie.name).toBe(TOKEN_COOKIE)
  })
})
