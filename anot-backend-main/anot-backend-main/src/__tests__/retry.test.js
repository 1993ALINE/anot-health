const { withRetry, isRetryableError } = require('../utils/retry')

describe('retry utility', () => {
  test('isRetryableError detects transient failures', () => {
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ status: 503 })).toBe(true)
    expect(isRetryableError(new Error('Connection timed out'))).toBe(true)
    expect(isRetryableError(new Error('Response body object should not be disturbed or locked'))).toBe(true)
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false)
  })

  test('withRetry succeeds after transient failure', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls += 1
      if (calls < 2) throw new Error('ETIMEDOUT')
      return 'ok'
    }, { maxAttempts: 3, baseDelayMs: 1, label: 'test' })
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  test('withRetry throws after max attempts', async () => {
    await expect(withRetry(async () => {
      throw new Error('ETIMEDOUT')
    }, { maxAttempts: 2, baseDelayMs: 1, label: 'test' })).rejects.toThrow('ETIMEDOUT')
  })
})
