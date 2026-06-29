'use strict'

const { isLocked, lockoutMessage, getLockoutConfig } = require('../services/accountLockout')

describe('accountLockout', () => {
  test('isLocked returns true when locked_until is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(isLocked({ locked_until: future })).toBe(true)
  })

  test('isLocked returns false when lock expired', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(isLocked({ locked_until: past })).toBe(false)
  })

  test('lockoutMessage includes remaining minutes', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString()
    expect(lockoutMessage({ locked_until: future })).toMatch(/minute/i)
  })

  test('getLockoutConfig has sensible defaults', () => {
    const cfg = getLockoutConfig()
    expect(cfg.maxAttempts).toBeGreaterThan(0)
    expect(cfg.lockoutMinutes).toBeGreaterThan(0)
  })
})
