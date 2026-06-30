const { checkMfaRequired, checkMfaEnrollmentRequired, checkPhiTrainingRequired } = require('../middleware/auth')

describe('auth scope gates', () => {
  test('checkMfaRequired blocks until MFA verified', () => {
    const blocked = checkMfaRequired({ requireMfa: true }, '/api/patients')
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('MFA_REQUIRED')

    expect(checkMfaRequired({ requireMfa: true }, '/api/auth/verify-mfa').ok).toBe(true)
    expect(checkMfaRequired({ requireMfa: true }, '/api/mfa/send-code').ok).toBe(true)
    expect(checkMfaRequired({ requireMfa: true }, '/send-code').ok).toBe(true)
  })

  test('checkMfaEnrollmentRequired blocks until MFA enrolled', () => {
    const blocked = checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/api/patients')
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('MFA_ENROLLMENT_REQUIRED')

    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/api/mfa/setup').ok).toBe(true)
    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/api/mfa/send-code').ok).toBe(true)
    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/api/mfa/verify-code').ok).toBe(true)
    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/setup').ok).toBe(true)
    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/send-code').ok).toBe(true)
    expect(checkMfaEnrollmentRequired({ requireMfaEnrollment: true }, '/verify-code').ok).toBe(true)
  })

  test('checkPhiTrainingRequired blocks until training acknowledged', () => {
    const blocked = checkPhiTrainingRequired({ requirePhiTraining: true })
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('PHI_TRAINING_REQUIRED')
  })
})
