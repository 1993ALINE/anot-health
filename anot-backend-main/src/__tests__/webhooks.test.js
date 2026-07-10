process.env.DEEPGRAM_WEBHOOK_SECRET = 'test-webhook-secret-for-unit-tests'

const {
  signDeepgramVisitToken,
  verifyDeepgramVisitToken,
  appendDeepgramVisitQuery,
} = require('../utils/webhookSignature')

describe('webhook HMAC validation', () => {
  test('verifyDeepgramVisitToken accepts a freshly signed token', () => {
    const visitId = 42
    const ts = Date.now()
    const sig = signDeepgramVisitToken(visitId, ts)
    expect(verifyDeepgramVisitToken(visitId, sig, ts)).toBe(true)
  })

  test('verifyDeepgramVisitToken rejects tampered or expired signature', () => {
    const visitId = 7
    const ts = Date.now()
    const sig = signDeepgramVisitToken(visitId, ts)
    expect(verifyDeepgramVisitToken(visitId, `${sig}x`, ts)).toBe(false)
    // Default max age is 4 hours — 5 hours old should be rejected
    expect(verifyDeepgramVisitToken(visitId, sig, ts - 5 * 60 * 60 * 1000)).toBe(false)
  })
})

describe('appendDeepgramVisitQuery', () => {
  test('appends signed visit query parameters for webhook processing', () => {
    const url = appendDeepgramVisitQuery('https://example.com/webhook', 99)
    expect(url).toMatch(/^https:\/\/example.com\/webhook\?/)
    expect(url).toMatch(/visit_id=99/)
    expect(url).toMatch(/sig=/)
  })
})
