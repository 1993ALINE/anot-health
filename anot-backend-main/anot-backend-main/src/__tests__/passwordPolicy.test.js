const { validatePassword } = require('../utils/passwordPolicy')

describe('passwordPolicy', () => {
  it('rejects short passwords', () => {
    const result = validatePassword('abc')
    expect(result.valid).toBe(false)
  })

  it('accepts strong passwords', () => {
    const result = validatePassword('Password@2026!')
    expect(result.valid).toBe(true)
  })
})