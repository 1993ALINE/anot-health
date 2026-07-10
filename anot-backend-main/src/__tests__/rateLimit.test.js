const express = require('express')
const rateLimit = require('express-rate-limit')
const {
  shouldSkipApiRateLimit,
  getRateLimitConfig,
} = require('../middleware/rateLimit')

describe('rate limiting', () => {
  test('shouldSkipApiRateLimit bypasses admin health endpoint', () => {
    expect(shouldSkipApiRateLimit({ path: '/admin/health' })).toBe(true)
    expect(shouldSkipApiRateLimit({ path: '/patients' })).toBe(false)
  })

  test('returns 429 when request limit exceeded', async () => {
    const app = express()
    app.use(rateLimit({
      windowMs: 60_000,
      max: 1,
      standardHeaders: false,
      legacyHeaders: false,
      message: { error: 'Too many requests. Please try again later.' },
    }))
    app.get('/t', (_req, res) => res.json({ ok: true }))

    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}`

    try {
      const first = await fetch(`${base}/t`)
      expect(first.status).toBe(200)
      const second = await fetch(`${base}/t`)
      expect(second.status).toBe(429)
      const body = await second.json()
      expect(body.error).toMatch(/too many/i)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('getRateLimitConfig returns positive windows', () => {
    const cfg = getRateLimitConfig()
    expect(cfg.api.max).toBeGreaterThan(0)
    expect(cfg.login.max).toBeGreaterThan(0)
  })
})
