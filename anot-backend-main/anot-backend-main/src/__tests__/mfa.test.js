const { authenticator } = require('otplib')
const {
  verifyTotp,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  adminRequiresMfa,
  loginRequiresMfa,
  buildOtpauthUrl,
  generateQrCodeDataUrl,
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

  test('generateQrCodeDataUrl returns a PNG data URL', async () => {
    const secret = generateSecret()
    const otpauthUrl = buildOtpauthUrl('clinician@dev.anot.local', secret)
    const qrCode = await generateQrCodeDataUrl(otpauthUrl)
    expect(qrCode).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  })
})

describe('MFA policy helpers', () => {
  test('adminRequiresMfa for PHI roles without MFA enabled', () => {
    expect(adminRequiresMfa('admin', false)).toBe(true)
    expect(adminRequiresMfa('admin', true)).toBe(false)
    expect(adminRequiresMfa('clinician', false)).toBe(true)
    expect(adminRequiresMfa('receptionist', false)).toBe(false)
  })

  test('loginRequiresMfa for PHI roles', () => {
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: true, mfa_secret_encrypted: 'enc' })).toBe(true)
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: false })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'clinician', mfa_enabled: true })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'scribe', mfa_enabled: false })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'admin', mfa_enabled: false })).toBe('ENROLLMENT_REQUIRED')
    expect(loginRequiresMfa({ role: 'receptionist', mfa_enabled: false })).toBe(false)
    expect(loginRequiresMfa({ role: 'receptionist', mfa_enabled: true })).toBe(false)
  })
})
