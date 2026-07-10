const {
  shouldSkipApiRateLimit,
  getRateLimitConfig,
  createLoginLimiter,
  createApiLimiter,
} = require('../middleware/rateLimit')

describe('rateLimit helpers', () => {
  test('parsePositiveInt fallback via getRateLimitConfig', () => {
    const prev = process.env.RATE_LIMIT_API_MAX
    process.env.RATE_LIMIT_API_MAX = 'not-a-number'
    const cfg = getRateLimitConfig()
    expect(cfg.api.max).toBeGreaterThan(0)
    if (prev == null) delete process.env.RATE_LIMIT_API_MAX
    else process.env.RATE_LIMIT_API_MAX = prev
  })

  test('shouldSkipApiRateLimit skips webhook routes', () => {
    expect(shouldSkipApiRateLimit({ path: '/webhooks/deepgram' })).toBe(true)
  })

  test('createLoginLimiter and createApiLimiter return middleware functions', () => {
    expect(typeof createLoginLimiter(null)).toBe('function')
    expect(typeof createApiLimiter(null)).toBe('function')
  })
})
