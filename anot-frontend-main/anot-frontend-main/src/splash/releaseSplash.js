/**
 * Dismiss the inline HTML boot splash (#anot-splash). Idempotent and safe
 * if the node is already gone.
 */
export function releaseSplash() {
  if (typeof document === 'undefined') {return}
  const splash = document.getElementById('anot-splash')
  if (!splash) {
    document.body.classList.add('anot-app-ready')
    return
  }
  if (splash.dataset.anotReleased === '1') {return}
  splash.dataset.anotReleased = '1'
  splash.classList.add('anot-splash--exit')
  splash.setAttribute('aria-busy', 'false')
  window.setTimeout(() => {
    splash.remove()
    document.body.classList.add('anot-app-ready')
  }, 420)
}

/** True when we should keep the boot splash until getMe / session bootstrap finishes. */
export function needsAuthSplashHold() {
  if (typeof window === 'undefined') {return false}
  const has = !!(localStorage.getItem('token') && localStorage.getItem('user'))
  if (!has) {return false}
  const p = window.location.pathname
  if (p === '/login' || p === '/') {return true}
  if (
    p.startsWith('/clinician') ||
    p.startsWith('/scribe') ||
    p.startsWith('/qps') ||
    p.startsWith('/admin')
  ) {
    return true
  }
  return false
}
