import { describe, it, expect } from 'vitest'
import { isAbortError, isLikelyNetworkFailure } from '../services/api'

describe('api helpers', () => {
  it('detects AbortError', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
  })

  it('detects network failures', () => {
    expect(isLikelyNetworkFailure({ name: 'TypeError', message: 'Failed to fetch' })).toBe(true)
  })
})