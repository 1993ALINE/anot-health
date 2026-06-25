const {
  validatePassword,
  generateSecurePassword,
} = require('../utils/passwordPolicy')

describe('passwordPolicy', () => {
  test('validatePassword rejects short passwords', () => {
    const result = validatePassword('Ab1!')
    expect(result.valid).toBe(false)
  })

  test('validatePassword accepts strong passwords', () => {
    const result = validatePassword('Str0ng!Passw0rd2024')
    expect(result.valid).toBe(true)
  })

  test('generateSecurePassword meets minimum length', () => {
    const pw = generateSecurePassword()
    expect(pw.length).toBeGreaterThanOrEqual(12)
  })
})
