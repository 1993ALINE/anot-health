const jwt = require('jsonwebtoken')
const {
  extractBearerToken,
  extractAuthToken,
  verifyJwtToken,
  validateUserAuthState,
  checkPasswordChangeRequired,
  restrict,
} = require('../middleware/auth')

describe('auth helpers', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
  })

  test('extractBearerToken parses Authorization header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
  })

  test('extractBearerToken returns null when header missing', () => {
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken('Basic xyz')).toBeNull()
  })

  test('extractAuthToken prefers HttpOnly session cookie over Bearer', () => {
    const req = {
      cookies: { anot_session: 'cookie-jwt' },
      headers: { authorization: 'Bearer header-jwt' },
    }
    expect(extractAuthToken(req)).toBe('cookie-jwt')
  })

  test('extractAuthToken prefers temporary gate Bearer token over session cookie', () => {
    const gateToken = jwt.sign({ id: 2, role: 'clinician', require_password_change: true }, process.env.JWT_SECRET)
    const req = {
      cookies: { anot_session: 'cookie-jwt' },
      headers: { authorization: `Bearer ${gateToken}` },
    }
    expect(extractAuthToken(req)).toBe(gateToken)
  })

  test('extractAuthToken falls back to Bearer when no cookie', () => {
    expect(extractAuthToken({ cookies: {}, headers: { authorization: 'Bearer abc' } })).toBe('abc')
  })

  test('verifyJwtToken rejects expired tokens', () => {
    const token = jwt.sign({ id: 1, role: 'clinician' }, process.env.JWT_SECRET, { expiresIn: '-1s' })
    expect(() => verifyJwtToken(token)).toThrow()
  })

  test('checkPasswordChangeRequired blocks routes until password changed', () => {
    const user = { require_password_change: true }
    const blocked = checkPasswordChangeRequired(user, '/api/visits')
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('FORCE_PASSWORD_CHANGE')

    const allowed = checkPasswordChangeRequired(user, '/api/auth/change-password')
    expect(allowed.ok).toBe(true)
  })
})

describe('validateUserAuthState (session)', () => {
  test('rejects deactivated accounts', () => {
    const result = validateUserAuthState(
      { found: true, status: 'inactive', role: 'clinician', token_version: 0 },
      { role: 'clinician', token_version: 0 },
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects token_version mismatch (logout all sessions)', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'clinician', token_version: 2 },
      { role: 'clinician', token_version: 1 },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/session expired/i)
  })

  test('rejects role change after token issued', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'admin', token_version: 0 },
      { role: 'clinician', token_version: 0 },
    )
    expect(result.ok).toBe(false)
  })

  test('accepts temporary gate token when token_version matches DB', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'clinician', token_version: 3 },
      { role: 'clinician', token_version: 3, requireMfaEnrollment: true },
    )
    expect(result.ok).toBe(true)
  })

  test('rejects temporary gate token missing token_version after password change', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'clinician', token_version: 1 },
      { role: 'clinician', requireMfaEnrollment: true },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/session expired/i)
  })

  test('rejects session_id mismatch when account was logged in elsewhere', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'clinician', token_version: 1, active_session_id: 'sess-device-b' },
      { role: 'clinician', token_version: 1, session_id: 'sess-device-a' },
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('SESSION_TERMINATED')
    expect(result.error).toMatch(/logged into on another device/i)
  })

  test('accepts matching active_session_id', () => {
    const result = validateUserAuthState(
      { found: true, status: 'active', role: 'clinician', token_version: 1, active_session_id: 'sess-device-a' },
      { role: 'clinician', token_version: 1, session_id: 'sess-device-a' },
    )
    expect(result.ok).toBe(true)
  })
})

describe('restrict (role enforcement)', () => {
  test('allows user with permitted role', () => {
    const req = { user: { role: 'clinician' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    restrict('clinician')(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  test('denies user with wrong role', () => {
    const req = { user: { role: 'scribe' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    restrict('admin')(req, res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
