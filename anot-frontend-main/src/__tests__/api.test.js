import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isAbortError, isLikelyNetworkFailure, getClientDeviceType } from '../services/api'

describe('api helpers', () => {
  it('detects AbortError', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
  })

  it('detects network failures', () => {
    expect(isLikelyNetworkFailure({ name: 'TypeError', message: 'Failed to fetch' })).toBe(true)
  })

  describe('getClientDeviceType', () => {
    const originalNavigator = globalThis.navigator
    const originalLocation = globalThis.location

    afterEach(() => {
      Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
      Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true })
    })

    it('detects mobile from iPhone userAgent', () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
          maxTouchPoints: 5,
        },
        configurable: true,
      })
      expect(getClientDeviceType()).toBe('mobile')
    })

    it('detects mobile on iPadOS (Macintosh userAgent with multi-touch)', () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
          maxTouchPoints: 5,
        },
        configurable: true,
      })
      expect(getClientDeviceType()).toBe('mobile')
    })

    it('detects desktop on standard PC without touch', () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          maxTouchPoints: 0,
        },
        configurable: true,
      })
      expect(getClientDeviceType()).toBe('desktop')
    })

    it('respects URL query param override', () => {
      Object.defineProperty(globalThis, 'location', {
        value: { search: '?device=mobile' },
        configurable: true,
      })
      expect(getClientDeviceType()).toBe('mobile')
    })
  })
})