'use strict'

const { parseJwtExpiresInToMs, getSessionCookieName, PROD_COOKIE, LEGACY_DEV_COOKIE } = require('../utils/sessionCookie')

describe('sessionCookie', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  test('parseJwtExpiresInToMs parses common durations', () => {
    expect(parseJwtExpiresInToMs('1h')).toBe(3_600_000)
    expect(parseJwtExpiresInToMs('15m')).toBe(900_000)
    expect(parseJwtExpiresInToMs('8h')).toBe(28_800_000)
  })

  test('getSessionCookieName uses __Host- prefix in production', () => {
    process.env.NODE_ENV = 'production'
    expect(getSessionCookieName()).toBe(PROD_COOKIE)
    process.env.NODE_ENV = 'development'
    expect(getSessionCookieName()).toBe(LEGACY_DEV_COOKIE)
  })
})
