const { csrfProtection } = require('../middleware/csrf')

describe('csrfProtection safe methods', () => {
  function mockReq(method, { cookies = {}, headers = {}, url = '/api/patients' } = {}) {
    return {
      method,
      cookies,
      originalUrl: url,
      get(name) {
        return headers[name.toLowerCase()] || headers[name] || undefined
      },
    }
  }

  function mockRes() {
    const res = { statusCode: 200, headers: {}, cookieArgs: null }
    res.status = (code) => { res.statusCode = code; return res }
    res.json = () => res
    res.cookie = (name, value, opts) => { res.cookieArgs = { name, value, opts }; return res }
    res.setHeader = (k, v) => { res.headers[k] = v; return res }
    return res
  }

  test('csrfProtection does not mint CSRF cookie on safe GET (use /csrf-token instead)', () => {
    const req = mockReq('GET')
    const res = mockRes()
    const next = jest.fn()
    csrfProtection(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.cookieArgs).toBeNull()
  })
})
