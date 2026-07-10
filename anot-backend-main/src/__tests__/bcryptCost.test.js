'use strict'

const { getBcryptRounds } = require('../utils/bcryptCost')

describe('bcryptCost', () => {
  const prev = process.env.BCRYPT_ROUNDS

  afterEach(() => {
    if (prev == null) delete process.env.BCRYPT_ROUNDS
    else process.env.BCRYPT_ROUNDS = prev
  })

  test('defaults to 12 rounds', () => {
    delete process.env.BCRYPT_ROUNDS
    expect(getBcryptRounds()).toBe(12)
  })

  test('respects BCRYPT_ROUNDS within safe range', () => {
    process.env.BCRYPT_ROUNDS = '12'
    expect(getBcryptRounds()).toBe(12)
  })

  test('falls back when BCRYPT_ROUNDS is invalid', () => {
    process.env.BCRYPT_ROUNDS = 'not-a-number'
    expect(getBcryptRounds()).toBe(12)
  })
})
