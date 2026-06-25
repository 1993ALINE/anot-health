const { authenticator } = require('otplib')
const {
  verifyTotp,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  adminRequiresMfa,
  loginRequiresMfa,
} = require('../services/mfaService')

describe('MFA service', () => {
  test('verifyTotp accepts a valid TOTP code', () => {
    const secret = generateSecret()
    const token = authenticator.generate(secret)
    expect(verifyTotp(secret, token)).toBe(true)
  })

  test('verifyTotp rejects invalid codes', () => {
    const secret = generateSecret()
    expect(verifyTotp(secret, '000000')).toBe(false)
    expect(verifyTotp(secret, 'abc')).toBe(false)
    expect(verifyTotp(null, '123456')).toBe(false)
  })

  test('recovery codes hash consistently for verification', () => {
    const [code] = generateRecoveryCodes(1)
    const hash = hashRecoveryCode(code)
    expect(hashRecoveryCode(code)).toBe(hash)
    expect(hashRecoveryCode('WRONG')).not.toBe(hash)
  })
})

describe('MFA policy helpers', () => {
  test('adminRequiresMfa for admin without MFA enabled', () => {
    expect(adminRequiresMfa('admin', false)).toBe(true)
    expect(adminRequiresMfa('admin', true)).toBe(false)
    expect(adminRequiresMfa('clinician', false)).toBe(false)
  })

  test('loginRequiresMfa when MFA enabled on account', () => {
    expect(loginRequiresMfa({ mfa_enabled: true })).toBe(true)
    expect(loginRequiresMfa({ mfa_enabled: false })).toBe(false)
  })
})
