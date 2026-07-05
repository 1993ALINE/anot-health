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

  it('validateDatabaseUrlFormat accepts unparsable DATABASE_URL when DB_* creds exist', () => {
    process.env.DATABASE_URL = 'postgresql://user:bad pass@host/anot'
    process.env.DB_HOST = 'prod.rds.amazonaws.com'
    process.env.DB_NAME = 'anot'
    process.env.DB_USER = 'anot_app'
    process.env.DB_PASSWORD = 'secret-with-special-chars!'
    expect(validateDatabaseUrlFormat().ok).toBe(true)
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
    process.env.USE_SSM = 'false'
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/anot_dev'
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_USER = 'mfa@example.com'
    process.env.SMTP_PASS = 'secret'
    await expect(runStartupDiagnostics()).resolves.toBeUndefined()
  })

  it('runStartupDiagnostics fails in production when no MFA delivery channel is configured', async () => {
    process.env.NODE_ENV = 'production'
    process.env.USE_SSM = 'false'
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/anot'
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(32)
    delete process.env.MFA_DISABLED
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.SENDGRID_API_KEY
    delete process.env.TWILIO_ACCOUNT_SID
    delete process.env.TWILIO_AUTH_TOKEN
    delete process.env.TWILIO_PHONE_NUMBER
    await expect(runStartupDiagnostics()).rejects.toThrow(/No MFA delivery channel/)
  })

  it('runStartupDiagnostics fails when USE_SSM=true loads nothing in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.USE_SSM = 'true'
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/anot'
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(32)
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_USER = 'mfa@example.com'
    process.env.SMTP_PASS = 'secret'
    await expect(
      runStartupDiagnostics({ secretsResult: { loaded: [], source: 'ssm' } }),
    ).rejects.toThrow(/no parameters were loaded/)
  })
})
