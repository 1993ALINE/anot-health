const { getPublicErrorMessage, isProduction } = require('../utils/errorMessages')

describe('errorMessages (production safety)', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  test('returns generic messages in production', () => {
    process.env.NODE_ENV = 'production'
    expect(isProduction()).toBe(true)
    expect(getPublicErrorMessage(500, new Error('database connection leaked secret'))).toBe('Something went wrong')
    expect(getPublicErrorMessage(401, new Error('bad password for user@example.com'))).toBe('Authentication failed')
  })

  test('returns detailed messages in development', () => {
    process.env.NODE_ENV = 'development'
    const err = new Error('Specific validation failure')
    expect(getPublicErrorMessage(400, err)).toBe('Specific validation failure')
  })
})
