import { getStoredUserRaw, purgeExpiredSession } from './sessionAuth'

/** Safe parse of cached session user from sessionStorage. */
export function getCurrentUser() {
  try {
    purgeExpiredSession()
    const raw = getStoredUserRaw()
    if (!raw) { return {} }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
