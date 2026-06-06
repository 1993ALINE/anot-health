/** Safe parse of cached session user from localStorage. */
export function getCurrentUser() {
  try {
    const raw = localStorage.getItem('user')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    localStorage.removeItem('user')
    return {}
  }
}
