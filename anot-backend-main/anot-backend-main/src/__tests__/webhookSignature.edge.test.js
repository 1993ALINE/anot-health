process.env.DEEPGRAM_WEBHOOK_SECRET = 'test-webhook-secret-for-unit-tests'
process.env.NODE_ENV = 'development'

const { webhookSecret, verifyDeepgramVisitToken } = require('../utils/webhookSignature')

describe('webhookSignature edge cases', () => {
  test('webhookSecret returns dev placeholder outside production', () => {
    expect(webhookSecret()).toBe('test-webhook-secret-for-unit-tests')
  })

  test('verifyDeepgramVisitToken rejects non-integer visit id', () => {
    expect(verifyDeepgramVisitToken('abc', 'sig', Date.now())).toBe(false)
  })
})
