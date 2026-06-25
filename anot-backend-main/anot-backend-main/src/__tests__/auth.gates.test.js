const { checkMfaRequired, checkPhiTrainingRequired } = require('../middleware/auth')

describe('auth scope gates', () => {
  test('checkMfaRequired blocks until MFA verified', () => {
    const blocked = checkMfaRequired({ requireMfa: true }, '/api/patients')
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('MFA_REQUIRED')

    const allowed = checkMfaRequired({ requireMfa: true }, '/api/auth/verify-mfa')
    expect(allowed.ok).toBe(true)
  })

  test('checkPhiTrainingRequired blocks until training acknowledged', () => {
    const blocked = checkPhiTrainingRequired({ requirePhiTraining: true })
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('PHI_TRAINING_REQUIRED')
  })
})
