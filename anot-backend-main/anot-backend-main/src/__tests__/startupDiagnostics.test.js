'use strict'

const {
  runStartupDiagnostics,
  validateRequiredEnv,
  validateJwtSecret,
  validateDatabaseUrlFormat,
  hasDatabaseConfig,
  MIN_JWT_SECRET_LENGTH,
} = require('../startup/startupDiagnostics')

describe('startupDiagnostics', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('validateJwtSecret rejects missing and short secrets', () => {
    delete process.env.JWT_SECRET
    expect(validateJwtSecret().ok).toBe(false)

    process.env.JWT_SECRET = 'too-short'
    expect(validateJwtSecret().ok).toBe(false)

    process.env.JWT_SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH)
    expect(validateJwtSecret().ok).toBe(true)
  })

  it('validateDatabaseUrlFormat accepts postgres URLs', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@host.example.com:5432/anot'
    expect(validateDatabaseUrlFormat().ok).toBe(true)
  })

  it('validateDatabaseUrlFormat rejects invalid schemes', () => {
    process.env.DATABASE_URL = 'mysql://user:pass@host/anot'
    expect(validateDatabaseUrlFormat().ok).toBe(false)
  })

  it('hasDatabaseConfig accepts DATABASE_URL or DB_* style', () => {
    delete process.env.DATABASE_URL
    delete process.env.DB_HOST
    expect(hasDatabaseConfig()).toBe(false)

    process.env.DATABASE_URL = 'postgresql://u:p@h/db'
    expect(hasDatabaseConfig()).toBe(true)

    delete process.env.DATABASE_URL
    process.env.DB_HOST = '127.0.0.1'
    process.env.DB_NAME = 'anot_dev'
    process.env.DB_USER = 'anot_dev'
    expect(hasDatabaseConfig()).toBe(true)
  })

  it('validateRequiredEnv fails when JWT_SECRET missing', () => {
    delete process.env.JWT_SECRET
    process.env.DATABASE_URL = 'postgresql://u:p@h/db'
    expect(validateRequiredEnv().ok).toBe(false)
  })

  it('runStartupDiagnostics passes with valid local env', async () => {
    process.env.NODE_ENV = 'development'
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/anot_dev'
    await expect(runStartupDiagnostics()).resolves.toBeUndefined()
  })

  it('runStartupDiagnostics fails when USE_SSM=true loads nothing in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.USE_SSM = 'true'
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/anot'
    await expect(
      runStartupDiagnostics({ secretsResult: { loaded: [], source: 'ssm' } }),
    ).rejects.toThrow(/no parameters were loaded/)
  })
})
