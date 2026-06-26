import { describe, expect, test } from 'vitest'
import { decodeJwtPayload, resolveMfaGateFromAuthResponse } from '../utils/jwtClaims'

function fakeJwt(payload) {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${body}.sig`
}

describe('jwtClaims', () => {
  test('decodeJwtPayload reads requireMfaEnrollment claim', () => {
    const token = fakeJwt({ requireMfaEnrollment: true, id: 23 })
    expect(decodeJwtPayload(token)).toMatchObject({ requireMfaEnrollment: true, id: 23 })
  })

  test('resolveMfaGateFromAuthResponse prefers enrollment JWT claim', () => {
    const token = fakeJwt({ requireMfaEnrollment: true })
    expect(resolveMfaGateFromAuthResponse({
      requireMfa: true,
      enrollmentRequired: false,
      temporaryToken: token,
    })).toBe('enrollment')
  })

  test('resolveMfaGateFromAuthResponse routes TOTP from requireMfa claim', () => {
    const token = fakeJwt({ requireMfa: true })
    expect(resolveMfaGateFromAuthResponse({
      requireMfa: true,
      enrollmentRequired: false,
      temporaryToken: token,
    })).toBe('totp')
  })

  test('resolveMfaGateFromAuthResponse falls back to enrollmentRequired flag', () => {
    expect(resolveMfaGateFromAuthResponse({
      requireMfa: true,
      enrollmentRequired: true,
      temporaryToken: 'not-a-jwt',
    })).toBe('enrollment')
  })
})
