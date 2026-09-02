import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCsrfToken, clearCsrfToken, getCsrfHeaders, getCsrfToken } from '../utils/csrf'

describe('csrf utils', () => {
  beforeEach(() => {
    clearCsrfToken()
    vi.restoreAllMocks()
    document.cookie = ''
  })

  afterEach(() => {
    document.cookie = ''
  })

  it('getCsrfHeaders returns X-CSRF-Token header', () => {
    const token = 'a'.repeat(64)
    expect(getCsrfHeaders(token)).toEqual({ 'X-CSRF-Token': token })
    expect(getCsrfHeaders(null)).toEqual({})
  })

  it('dedupes concurrent fetchCsrfToken calls to a single network request', async () => {
    const token = 'b'.repeat(64)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ csrfToken: token, cookieName: 'csrf_token' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const apiBase = 'http://127.0.0.1:5000/api'
    const [a, b, c] = await Promise.all([
      fetchCsrfToken(apiBase),
      fetchCsrfToken(apiBase),
      fetchCsrfToken(apiBase),
    ])

    expect(a).toBe(token)
    expect(b).toBe(token)
    expect(c).toBe(token)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: 'include' })
  })

  it('getCsrfToken falls back to legacy csrf_token cookie', () => {
    const legacy = 'b'.repeat(64)
    document.cookie = `csrf_token=${legacy}; path=/`
    expect(getCsrfToken()).toBe(legacy)
  })
})
