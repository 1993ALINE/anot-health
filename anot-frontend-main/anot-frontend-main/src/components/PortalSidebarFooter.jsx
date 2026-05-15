import PortalGuide from './PortalGuide'

export default function PortalSidebarFooter({
  userName = 'User',
  role = 'clinician',
  onLogout,
}) {
  return (
    <div className="sf-sidebar-footer sf-sidebar-rich__footer adm-sidebar-footer">
      <div className="adm-sidebar-footer__card">
        <div className="adm-sidebar-footer__identity">
          <p className="adm-sidebar-footer__eyebrow">Account</p>
          <p className="adm-sidebar-footer__who">{userName}</p>
        </div>

        <div className="adm-sidebar-footer__actions" role="group" aria-label="Account actions">
          <PortalGuide role={role} className="portal-guide-trigger--footer" />
          <button type="button" className="adm-sidebar-footer__btn adm-sidebar-footer__btn--signout" onClick={onLogout}>
            <span className="adm-sidebar-footer__btn-ico" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
