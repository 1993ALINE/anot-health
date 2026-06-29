import { authAPI } from '../services/api'

/**
 * Secure sign-out: server logout, IndexedDB/in-memory PHI purge, hard reload.
 * Use instead of raw onClick handlers so shared workstations wipe PHI reliably.
 */
export default function LogoutButton({
  className = 'adm-sidebar-footer__btn adm-sidebar-footer__btn--signout',
  label = 'Sign out',
  redirectTo = '/login',
  onBeforeLogout,
  onError,
  ...rest
}) {
  const handleClick = async () => {
    try {
      await onBeforeLogout?.()
      await authAPI.logout({ reload: false })
      globalThis.location.replace(redirectTo)
    } catch (err) {
      onError?.(err)
      globalThis.location.replace(redirectTo)
    }
  }

  return (
    <button type="button" className={className} onClick={handleClick} {...rest}>
      <span className="adm-sidebar-footer__btn-ico" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </span>
      {label}
    </button>
  )
}
