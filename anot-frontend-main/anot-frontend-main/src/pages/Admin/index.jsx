import { useState, useEffect, useCallback, lazy, Suspense, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI, usersAPI, adminAPI, settingsAPI, API_BASE } from '../../services/api'
import { setBranding, useBranding } from '../../services/branding'
import SystemProfileManager from '../../components/SystemProfileManager'
import AdminModulePermissionsModal from '../../components/AdminModulePermissionsModal'
import AdminAuditDashboard from './AdminAuditDashboard'
import { SfAccountMenu, useSidebar, Overlay, usePortalDrawerMode, portalSidebarAriaHidden, PortalSidebarBrand } from '../shared'
import { isSuperAdmin, ADMIN_GRANTABLE_MODULE_KEYS, ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN, ADMIN_PORTAL_MODULES, adminMayOpenTab, resolvedAdminModuleKeys } from '../../auth/roles'
import ErrorBoundary, { PortalCrashFallback } from '../../components/ErrorBoundary'
import { getCurrentUser } from '../../utils/getCurrentUser'
import { useSessionTimeout } from '../../utils/useSessionTimeout'
import './admin.css'
import '../portal-sidebar-indigo.css'
import '../portalErrorBoundary.css'

const PayrollMiniChart = lazy(() =>
    import('./AdminMiniCharts').then((m) => ({ default: m.PayrollMiniChart }))
)

function initials(n) {
    if (!n) return '?'
    return n.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase()
}

function fmtAdminDate(raw) {
  if (!raw) return '—'
  try {
    return new Date(raw).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    return '—'
  }
}

function displayEmail(email) {
  if (!email) return '—'
  if (email.includes('@dev.anot.local')) return '(dev account)'
  return email
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

/** Primary brand palette — align with CSS :root (--brand-primary / --brand-secondary) */
const BRAND = {
    root: '#4260E9',
    light: '#6D84F5',
    deep: '#2D49C7',
    secondary: '#7B61FF',
    secondaryLight: '#9D8DFF',
    muted: '#64748b',
}

const SEM = {
    success: '#047857',
    warn: '#d97706',
    danger: '#e11d48',
}

const ROLE_CFG = {
    clinician:    { label: 'Clinician',    bg: '#EEF2FF', color: BRAND.deep, icon: '🩺' },
    scribe:       { label: 'Scribe',       bg: '#F5F3FF', color: BRAND.secondary, icon: '📝' },
    qps:          { label: 'QPS',          bg: '#EDE9FE', color: '#5b21b6', icon: '✅' },
    admin:        { label: 'Admin',        bg: '#EEF2FF', color: BRAND.root, icon: '⚙️' },
    super_admin:  { label: 'Super Admin',  bg: '#FEF3C7', color: '#b45309', icon: '👑' },
    elevated:     { label: 'Administrator', bg: '#EEF2FF', color: BRAND.root, icon: '⚙️' },
}

const NAV = [
    { key: 'overview',    icon: '📊', label: 'Overview' },
    { key: 'clinicians',  icon: '🩺', label: 'Clinicians' },
    { key: 'scribes',     icon: '📝', label: 'Scribes' },
    { key: 'qps',         icon: '✅', label: 'QPS Staff' },
    { key: 'admins',      icon: '⚙️', label: 'Admins' },
    { key: 'assignments', icon: '🔗', label: 'Assignments' },
    { key: 'payroll',     icon: '💳', label: 'Payroll' },
    { key: 'audit',       icon: '🔍', label: 'Audit Logs' },
    { key: 'settings',    icon: '🛠', label: 'Settings' },
    { key: 'system-profile', icon: '👤', label: 'Profile Management' },
]

const MODULE_META = {
    overview:      { tagline: 'Fleet health, staffing, and assignments at a glance.' },
    clinicians:    { tagline: 'Providers on Anot — specialties, access, and credentials.' },
    scribes:       { tagline: 'Documentation specialists paired with your clinicians.' },
    qps:           { tagline: 'Quality scoring and note review oversight.' },
    admins:        { tagline: 'Elevated operators — Super Admins manage Admin access and modules.' },
    assignments:   { tagline: 'Who documents whom — keep pairs accurate and current.' },
    payroll:       { tagline: 'Compensation tied to completed notes and agreed rates.' },
    audit:         { tagline: 'Enterprise activity monitoring, security analytics, and immutable compliance exports.' },
    settings:      { tagline: 'Policies, defaults, and security posture.' },
    'system-profile': { tagline: 'Manage your profile identity and security settings.' },
}

const DEFAULT_SETTINGS_FORM = {
    system_name: 'Anot',
    system_email: '',
    phone: '',
    address: '',
    company_info: '',
    footer_text: '',
    support_contact: '',
    website_url: '',
    facebook_url: '',
    linkedin_url: '',
    instagram_url: '',
    x_url: '',
    logo_data_url: '',
    favicon_data_url: '',
    primary_color: '#4260E9',
    secondary_color: '#7B61FF',
    system_description: 'Clinical documentation platform',
    audit_retention_days: 365,
    deepgram_enabled: false,
    deepgram_api_key: '',
    deepgram_api_key_set: false,
    deepgram_clear_api_key: false,
    deepgram_model: 'nova-2',
    deepgram_language: 'en-US',
    deepgram_webhook_url: '',
    deepgram_auto_transcribe_on_upload: false,
    anthropic_api_key: '',
    anthropic_api_key_set: false,
    anthropic_clear_api_key: false,
    anthropic_enabled: true,
    anthropic_model: 'claude-haiku-4-5',
    ffmpeg_enabled: false,
    ffmpeg_target_format: 'mp3',
    ffmpeg_compression: 5,
    ffmpeg_max_upload_mb: 100,
    ffmpeg_preprocess_before_transcribe: true,
}

function ModuleHero({ tab, chips }) {
    const nav = NAV.find((n) => n.key === tab)
    const meta = MODULE_META[tab]
    if (!nav || !meta) return null
    return (
        <header className="adm-module-hero" aria-labelledby={`adm-hero-title-${tab}`}>
            <div className="adm-module-hero__main">
                <div className="adm-module-hero__icon-wrap" aria-hidden>
                    <span className="adm-module-hero__icon">{nav.icon}</span>
                </div>
                <div className="adm-module-hero__copy">
                    <h2 id={`adm-hero-title-${tab}`} className="adm-module-hero__title">{nav.label}</h2>
                    <p className="adm-module-hero__tagline">{meta.tagline}</p>
                </div>
            </div>
            {Array.isArray(chips) && chips.length > 0 && (
                <div className="adm-module-hero__chips">
                    {chips.map((c) => (
                        <div key={c.label} className="adm-module-hero__chip">
                            <span className="adm-module-hero__chip-k">{c.label}</span>
                            <span className="adm-module-hero__chip-v">{c.value}</span>
                        </div>
                    ))}
                </div>
            )}
        </header>
    )
}

// ─── SHARED UI (used by hoisted table/sidebar components) ───────────────────

function LoadingBox({ variant }) {
    if (variant === 'table') {
        return (
            <div className="adm-loading-panel" aria-busy="true" aria-label="Loading">
                <div className="adm-skeleton adm-skeleton--head" />
                <div className="adm-skeleton-rows">
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                        <div key={i} className="adm-skeleton adm-skeleton--row" />
                    ))}
                </div>
            </div>
        )
    }
    return <div className="adm-loading">Loading…</div>
}

function AdminEmpty({ icon, title, hint, actionLabel, onAction }) {
    return (
        <div className="adm-empty-state">
            {icon && <div className="adm-empty-state__icon">{icon}</div>}
            <div className="adm-empty-state__title">{title}</div>
            {hint && <p className="adm-empty-state__hint">{hint}</p>}
            {actionLabel && onAction && (
                <button type="button" className="adm-btn-primary adm-empty-state__cta" onClick={onAction}>
                    {actionLabel}
                </button>
            )}
        </div>
    )
}

function buildDailyCountSeries(entries, getDate, days, filterFn = () => true) {
    const dayMs = 24 * 60 * 60 * 1000
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = today.getTime() - (days - 1) * dayMs
    const buckets = Array.from({ length: days }, () => 0)
    for (const item of entries) {
        if (!filterFn(item)) continue
        const raw = getDate(item)
        if (!raw) continue
        const d = new Date(raw)
        if (Number.isNaN(d.getTime())) continue
        d.setHours(0, 0, 0, 0)
        const idx = Math.floor((d.getTime() - start) / dayMs)
        if (idx >= 0 && idx < days) buckets[idx] += 1
    }
    return buckets
}

function OverviewStatCard({ item, loading }) {
    const points = item.points?.some((p) => p > 0) ? item.points : []
    const split = Math.floor(points.length / 2)
    const prevTotal = points.slice(0, split).reduce((a, v) => a + v, 0)
    const currTotal = points.slice(split).reduce((a, v) => a + v, 0)
    const rawTrend = points.length ? ((currTotal - prevTotal) / Math.max(prevTotal, 1)) * 100 : 0
    const pct = Math.round(Math.abs(rawTrend))
    const up = item.invertTrend ? rawTrend <= 0 : rawTrend >= 0
    const hasSeries = points.length > 0
    const hasCompare = hasSeries && (prevTotal > 0 || currTotal > 0)
    const sum14 = hasSeries ? points.reduce((a, v) => a + v, 0) : 0

    return (
        <div
            className={`adm-stat-card adm-stat-card--premium adm-stat-card--overview ${item.cardClass || ''}`}
            style={{ '--adm-card-accent': item.color }}
        >
            <div className="adm-stat-card__head">
                <div className="adm-stat-card__value-wrap">
                    <div className="adm-stat-card__label">{item.label}</div>
                    <div className="adm-stat-card__value" style={{ color: item.color }}>{loading ? '—' : item.value}</div>
                </div>
                <div className="adm-stat-card__icon-wrap" aria-hidden>
                    <span className="adm-stat-card__icon">{item.icon}</span>
                </div>
            </div>
            {hasCompare ? (
                <div className="adm-stat-card__compare" aria-label="Activity windows">
                    <div className="adm-stat-card__compare-cell">
                        <span className="adm-stat-card__compare-k">Recent</span>
                        <span className="adm-stat-card__compare-v">{currTotal}</span>
                    </div>
                    <div className="adm-stat-card__compare-div" aria-hidden />
                    <div className="adm-stat-card__compare-cell">
                        <span className="adm-stat-card__compare-k">Prior</span>
                        <span className="adm-stat-card__compare-v">{prevTotal}</span>
                    </div>
                </div>
            ) : null}
            <div className="adm-stat-card__meta">
                {hasCompare ? (
                    <span className={`adm-stat-trend ${up ? 'is-up' : 'is-down'}`}>
                        {up ? '↗' : '↘'} {pct}% {item.period || 'vs last week'}
                    </span>
                ) : (
                    <span className="adm-stat-trend adm-stat-trend--neutral">Awaiting trend data</span>
                )}
                <span className="adm-stat-card__hint">{item.hint || 'Live activity'}</span>
            </div>
            {sum14 > 0 ? (
                <div className="adm-stat-card__foot">
                    <span className="adm-stat-card__foot-k">14-day volume</span>
                    <span className="adm-stat-card__foot-v">{sum14}</span>
                </div>
            ) : null}
        </div>
    )
}

function getRoleSemantic(user, role) {
    if (role === 'clinician') {
        return {
            label: 'Care focus',
            value: user.specialty || 'General medicine',
            tone: 'teal',
        }
    }
    if (role === 'scribe') {
        return {
            label: 'Documentation lane',
            value: user.status === 'active' ? 'Live transcription queue' : 'Standby',
            tone: 'amber',
        }
    }
    if (role === 'qps') {
        return {
            label: 'Review scope',
            value: user.status === 'active' ? 'Grading and QA audits' : 'Paused review slot',
            tone: 'emerald',
        }
    }
    if (role === 'super_admin') {
        return {
            label: 'Control plane',
            value: user.status === 'active' ? 'Full system authority' : 'Suspended',
            tone: 'amber',
        }
    }
    return {
        label: 'Access tier',
        value: user.status === 'active' ? 'Full platform controls' : 'Restricted',
        tone: 'slate',
    }
}

function AdminSidebar({ tab, onSelectTab, currentUser, onRequestSignOut, badges, branding, sidebarOpen, navItems }) {
    const sidebarDrawerMode = usePortalDrawerMode()

    const navBadge = (itemKey) => {
        const c =
            itemKey === 'clinicians' ? badges.clinicians
            : itemKey === 'scribes' ? badges.scribes
            : itemKey === 'qps' ? badges.qps
            : itemKey === 'admins' ? badges.admins
            : itemKey === 'assignments' ? badges.assignments
            : itemKey === 'audit' ? badges.audit
            : 0
        if (!c) return null
        return <span className="sf-sidebar-rich__nav-badge sf-sidebar-rich__nav-badge--subtle">{c}</span>
    }
    return (
        <aside
            id="adm-admin-sidebar"
            className={`sf-sidebar sf-sidebar--rich adm-sidebar${sidebarOpen ? ' open' : ''}`}
            aria-hidden={portalSidebarAriaHidden(sidebarDrawerMode, sidebarOpen)}
        >
            <div className="sf-sidebar-top sf-sidebar-rich__top">
                <PortalSidebarBrand branding={branding} subtitle={isSuperAdmin(currentUser) ? 'Super Admin' : 'Admin Panel'} />
            </div>
            <p className="sf-sidebar-rich__nav-label">Platform</p>
            <nav className="sf-nav sf-sidebar-rich__nav" aria-label="Main">
                {navItems.map((item) => (
                    <div
                        key={item.key}
                        role="button"
                        tabIndex={0}
                        data-adm-nav={item.key}
                        className={`sf-nav-item sf-sidebar-rich__nav-item${tab === item.key ? ' active' : ''}`}
                        onClick={() => onSelectTab(item.key)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectTab(item.key)}
                    >
                        <span className="sf-sidebar-rich__nav-ico">{item.icon}</span>
                        <span className="sf-sidebar-rich__nav-text">{item.label}</span>
                        {navBadge(item.key)}
                    </div>
                ))}
            </nav>
            <div className="sf-sidebar-footer sf-sidebar-rich__footer adm-sidebar-footer">
                <div className="adm-sidebar-footer__card">
                    <p className="adm-sidebar-footer__eyebrow">Account</p>
                    <p className="adm-sidebar-footer__who">{currentUser.name || 'Administrator'}</p>
                    <button type="button" className="adm-sidebar-footer__btn" onClick={onRequestSignOut}>
                        <span className="adm-sidebar-footer__btn-ico" aria-hidden>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                <polyline points="16 17 21 12 16 7" />
                                <line x1="21" y1="12" x2="9" y2="12" />
                            </svg>
                        </span>
                        Sign out
                    </button>
                </div>
            </div>
        </aside>
    )
}

function AdminUserTable({
    userList,
    role,
    loading,
    refreshing,
    highlightUserId,
    isSuperAdminViewer,
    onOpenModulePermissions,
    setEditUser,
    setResetUser,
    setResetPass,
    setResetError,
    setShowResetPass,
    toggleStatus,
    setAddRole,
    setShowAdd,
    setAddError,
    setNewUserPassword,
    setNewUser,
}) {
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState('all')
    const cfg = ROLE_CFG[role]
    const roleClass =
        role === 'clinician' ? 'clinicians'
        : role === 'scribe' ? 'scribes'
        : role === 'qps' ? 'qps'
        : role === 'admin' || role === 'elevated' ? 'admins'
        : 'generic'
    const matchesSearch = (u) => {
        if (!search) return true
        const q = search.toLowerCase()
        const name = (u.name || '').toLowerCase()
        const email = (u.email || '').toLowerCase()
        return name.includes(q) || email.includes(q)
    }
    const filtered = userList.filter((u) => matchesSearch(u) && (filter === 'all' || u.status === filter))
    const isSystemSuperRow = (u) => u.role === 'super_admin'
    return (
        <div>
            <div className="adm-toolbar">
                <input
                    className="adm-input adm-input--narrow"
                    placeholder={`Search ${cfg.label}s…`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <select className="adm-input adm-input--select-compact" value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                </select>
                <div className="adm-toolbar__actions" style={{ marginLeft: 'auto' }}>
                    <span className="adm-toolbar__meta">
                        {filtered.length} {cfg.label}{filtered.length !== 1 ? 's' : ''}
                        {refreshing ? ' · Syncing…' : ''}
                    </span>
                    <button type="button" className="adm-btn-primary" onClick={() => {
                        setAddRole(role === 'elevated' ? 'admin' : role)
                        setShowAdd(true)
                        setAddError('')
                        setNewUserPassword('')
                        setNewUser({ name: '', email: '', specialty: '', phone: '', npi: '', license: '' })
                    }}>
                        + Add {cfg.label}
                    </button>
                </div>
            </div>
            {loading ? (
                <LoadingBox variant="table" />
            ) : filtered.length === 0 ? (
                <AdminEmpty
                    icon={cfg.icon}
                    title={`No ${cfg.label}s yet`}
                    hint={`Add your first ${cfg.label.toLowerCase()} or adjust search and status filters.`}
                    actionLabel={`Add ${cfg.label}`}
                        onAction={() => {
                            setAddRole(role === 'elevated' ? 'admin' : role)
                            setShowAdd(true)
                            setAddError('')
                            setNewUserPassword('')
                            setNewUser({ name: '', email: '', specialty: '', phone: '', npi: '', license: '' })
                        }}
                />
            ) : (
                <div className={`adm-table-scroll adm-table-scroll--${roleClass}`}>
                <div className={`adm-table-wrap adm-table-wrap--cards adm-table-wrap--${roleClass}`}>
                    <div className="adm-table__head">
                        <div style={{ flex: 2 }}>Name</div>
                        <div style={{ flex: 2 }}>Email</div>
                        <div style={{ flex: 2 }}>{role === 'clinician' ? 'Specialty' : 'Operations'}</div>
                        <div style={{ flex: 1 }}>Phone</div>
                        <div style={{ flex: 1 }}>Status</div>
                        <div className="adm-th-actions">Actions</div>
                    </div>
                    {filtered.map((u) => {
                        const semantic = getRoleSemantic(u, u.role || role)
                        const isNew = highlightUserId != null && String(u.id) === String(highlightUserId)
                        return (
                        <div key={u.id} className={`adm-table__row adm-table__row--${roleClass}${isNew ? ' adm-table__row--new' : ''}`}>
                            <div className="adm-td" data-label="Name" style={{ flex: 2 }}>
                                <div className="adm-usercell">
                                    <div className={`adm-usercell__avatar adm-usercell__avatar--${roleClass}`} aria-hidden>{initials(u.name)}</div>
                                    <div className="adm-usercell__meta">
                                        <div style={{ fontWeight: 700, color: 'var(--text-main)' }}>{u.name}</div>
                                        <div className="adm-usercell__sub">
                                            {role === 'clinician' && (u.npi ? `NPI ${u.npi}` : 'Clinician profile')}
                                            {role === 'scribe' && 'Documentation specialist'}
                                            {role === 'qps' && 'Quality review specialist'}
                                            {(role === 'admin' || role === 'elevated') && (u.role === 'super_admin' ? 'Super Admin' : 'Platform administration')}
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="adm-td" data-label="Email" style={{ flex: 2, fontSize: 12, color: 'var(--text-muted)' }}>{displayEmail(u.email)}</div>
                            <div className="adm-td" data-label={semantic.label} style={{ flex: 2 }}>
                                {role === 'clinician' ? (
                                    <span className="adm-specialty-chip">{semantic.value}</span>
                                ) : (
                                    <span className={`adm-role-chip adm-role-chip--${semantic.tone}`}>{semantic.value}</span>
                                )}
                            </div>
                            <div className="adm-td" data-label="Phone" style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>
                                {u.phone || (
                                    <span className="adm-usercell__sub adm-usercell__sub--muted">Not set</span>
                                )}
                            </div>
                            <div className="adm-td" data-label="Status" style={{ flex: 1 }}>
                                <span
                                    className="adm-badge"
                                    style={{
                                        background: u.status === 'active' ? '#d1fae5' : '#eef2ff',
                                        color: u.status === 'active' ? '#065f46' : '#64748b',
                                    }}
                                >
                                    {u.status === 'active' ? '● Active' : '○ Inactive'}
                                </span>
                            </div>
                            <div className="adm-td adm-td--actions" data-label="Actions">
                                <button type="button" className="adm-btn-action" onClick={() => setEditUser({ ...u })}>
                                    Edit
                                </button>
                                {role === 'elevated' && u.role === 'admin' && isSuperAdminViewer && (
                                    <button
                                        type="button"
                                        className="adm-btn-action adm-btn-action--modules"
                                        title="Configure which admin portal sections this administrator can open"
                                        onClick={() => onOpenModulePermissions({ ...u })}
                                    >
                                        Module permissions
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="adm-btn-action"
                                    style={{ color: '#92400e' }}
                                    onClick={() => {
                                        setResetUser(u)
                                        setResetPass('')
                                        setResetError('')
                                        setShowResetPass(false)
                                    }}
                                >
                                    🔑 Reset
                                </button>
                                <button
                                    type="button"
                                    className="adm-btn-action"
                                    style={{
                                        color: u.status === 'active' ? '#b91c1c' : '#047857',
                                        opacity: isSystemSuperRow(u) ? 0.45 : 1,
                                    }}
                                    disabled={isSystemSuperRow(u)}
                                    title={isSystemSuperRow(u) ? 'The system Super Admin account cannot be activated or deactivated here.' : undefined}
                                    onClick={() => !isSystemSuperRow(u) && toggleStatus(u)}
                                >
                                    {u.status === 'active' ? 'Disable' : 'Enable'}
                                </button>
                            </div>
                        </div>
                        )
                    })}
                </div>
                </div>
            )}
        </div>
    )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function AdminWithErrorBoundary() {
    return (
        <ErrorBoundary portalName="Admin portal" fallback={<PortalCrashFallback />}>
            <Admin />
        </ErrorBoundary>
    )
}

function Admin() {
    const navigate = useNavigate()
    const [currentUser, setCurrentUser] = useState(() => getCurrentUser())
    useEffect(() => {
        authAPI.getMe().then(() => {
            setCurrentUser(getCurrentUser())
        }).catch(() => {})
    }, [])
    const branding = useBranding()
    const sidebar = useSidebar()
    const sessionTimeoutModal = useSessionTimeout(!!currentUser && Object.keys(currentUser).length > 0)

    const [tab, setTab]                 = useState('overview')
    const [users, setUsers]             = useState([])
    const [assignments, setAssignments] = useState([])
    const [payroll, setPayroll]         = useState([])
    const [auditLogs, setAuditLogs]     = useState([])
    const [auditTotalEvents, setAuditTotalEvents] = useState(0)
    const [auditDashMeta, setAuditDashMeta] = useState(null)
    const [loading, setLoading]         = useState(true)
    const [usersRefreshing, setUsersRefreshing] = useState(false)
    const [recentlyAddedUserId, setRecentlyAddedUserId] = useState(null)
    const [modulePermUser, setModulePermUser] = useState(null)
    const [modulePermSaving, setModulePermSaving] = useState(false)
    const [payrollLoading, setPayrollLoading]   = useState(false)
    const [toast, setToast]             = useState(null)

    const showToast = useCallback((msg, type = 'success') => {
        setToast({ msg, type })
        setTimeout(() => setToast(null), 3500)
    }, [])

    // Add user modal
    const [showAdd, setShowAdd]       = useState(false)
    const [addRole, setAddRole]       = useState('scribe')
    const [newUser, setNewUser]       = useState({ name: '', email: '', specialty: '', phone: '', npi: '', license: '' })
    const [newUserPassword, setNewUserPassword] = useState('')
    const [addError, setAddError]     = useState('')
    const [addLoading, setAddLoading] = useState(false)

    // Edit user modal
    const [editUser, setEditUser]       = useState(null)
    const [editLoading, setEditLoading] = useState(false)
    const [editError, setEditError] = useState('')

    // Reset password modal
    const [resetUser, setResetUser]           = useState(null)
    const [resetPass, setResetPass]           = useState('')
    const [showResetPass, setShowResetPass]   = useState(false)
    const [resetLoading, setResetLoading]     = useState(false)
    const [resetError, setResetError]         = useState('')
    const [confirmDialog, setConfirmDialog]   = useState(null)
    const [confirmLoading, setConfirmLoading] = useState(false)

    // Assignment
    const [assignClinicianId, setAssignClinicianId] = useState('')
    const [assignScribeId, setAssignScribeId]       = useState('')
    const [assignLoading, setAssignLoading]         = useState(false)
    const [assignmentsLoadError, setAssignmentsLoadError] = useState(null)
    const [settingsForm, setSettingsForm] = useState(DEFAULT_SETTINGS_FORM)
    const [settingsDirty, setSettingsDirty] = useState(false)
    const [settingsLoading, setSettingsLoading] = useState(false)
    const [settingsSaving, setSettingsSaving] = useState(false)
    const [settingsError, setSettingsError] = useState('')

    const toggleAdminModuleKey = useCallback((key) => {
        setEditUser((prev) => {
            if (!prev || prev.role !== 'admin') return prev
            const all = ADMIN_GRANTABLE_MODULE_KEYS
            const base = prev.admin_modules == null
                ? [...ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN]
                : [...prev.admin_modules]
            const set = new Set(base)
            if (set.has(key)) set.delete(key)
            else set.add(key)
            const next = all.filter((k) => set.has(k))
            const isDefault =
                next.length === ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN.length
                && ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN.every((k) => next.includes(k))
            return { ...prev, admin_modules: isDefault ? null : next }
        })
    }, [])

    const hydrateSettingsForm = useCallback((raw) => {
        const social = { ...(raw?.social_links || {}) }
        delete social.__admin_meta
        setSettingsForm({
            ...DEFAULT_SETTINGS_FORM,
            ...raw,
            website_url: social.website_url || '',
            facebook_url: social.facebook_url || '',
            linkedin_url: social.linkedin_url || '',
            instagram_url: social.instagram_url || '',
            x_url: social.x_url || '',
            deepgram_api_key: '',
            deepgram_clear_api_key: false,
            deepgram_api_key_set: raw?.deepgram_api_key_set,
            deepgram_enabled: raw?.deepgram_enabled ?? false,
            deepgram_model: raw?.deepgram_model ?? 'nova-2',
            deepgram_language: raw?.deepgram_language ?? 'en-US',
            anthropic_api_key: '',
            anthropic_clear_api_key: false,
            anthropic_api_key_set: raw?.anthropic_api_key_set,
            anthropic_enabled: raw?.anthropic_enabled ?? true,
            anthropic_model: raw?.anthropic_model ?? 'claude-haiku-4-5',
        })
        setSettingsDirty(false)
    }, [])

    const fetchAssignments = useCallback(async () => {
        const res = await fetch(`${API_BASE}/assignments`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to load assignments.')
        return data.assignments || []
    }, [])

    const loadAll = useCallback(async () => {
        try {
            setLoading(true)
            const keys = new Set(resolvedAdminModuleKeys(currentUser))
            const needUsers = ['overview', 'clinicians', 'scribes', 'qps', 'assignments', 'admins'].some((k) => keys.has(k))
            const needAssignments = keys.has('overview') || keys.has('assignments')

            const userP = needUsers ? usersAPI.getAll() : Promise.resolve({ users: [] })
            const assignP = needAssignments ? fetchAssignments() : Promise.resolve([])

            const [usersRes, assignRes] = await Promise.allSettled([userP, assignP])

            if (usersRes.status === 'fulfilled') {
                setUsers(usersRes.value.users || [])
            } else {
                setUsers([])
                if (needUsers) {
                    const msg = usersRes.reason instanceof Error ? usersRes.reason.message : String(usersRes.reason || '')
                    showToast(`Failed to load users: ${msg}`, 'error')
                }
            }

            if (assignRes.status === 'fulfilled') {
                setAssignments(assignRes.value || [])
                setAssignmentsLoadError(null)
            } else {
                setAssignments([])
                if (needAssignments) {
                    const msg = assignRes.reason instanceof Error ? assignRes.reason.message : String(assignRes.reason || 'Failed to load assignments.')
                    setAssignmentsLoadError(msg)
                    showToast(msg, 'error')
                } else {
                    setAssignmentsLoadError(null)
                }
            }
        } catch (err) {
            showToast(`Failed to load: ${err.message}`, 'error')
        } finally {
            setLoading(false)
        }
    }, [currentUser, showToast, fetchAssignments])

    const refreshUsers = useCallback(async (silent = false) => {
        const keys = new Set(resolvedAdminModuleKeys(currentUser))
        const needUsers = ['overview', 'clinicians', 'scribes', 'qps', 'assignments', 'admins'].some((k) => keys.has(k))
        if (!needUsers) {
            if (!silent) showToast('No permission to refresh the user directory.', 'error')
            return false
        }
        try {
            setUsersRefreshing(true)
            const data = await usersAPI.getAll()
            setUsers(data.users || [])
            if (!silent) showToast('User list updated')
            return true
        } catch (err) {
            showToast(`Failed to refresh users: ${err.message}`, 'error')
            return false
        } finally {
            setUsersRefreshing(false)
        }
    }, [showToast, currentUser])

    const loadPayroll = useCallback(async () => {
        if (!adminMayOpenTab(currentUser, 'payroll')) {
            setPayroll([])
            return
        }
        try {
            setPayrollLoading(true)
            const data = await adminAPI.getPayroll()
            setPayroll(data.payroll || [])
        } catch (err) { showToast(`Failed to load payroll: ${err.message}`, 'error') }
        finally { setPayrollLoading(false) }
    }, [currentUser, showToast])

    const loadAuditLogs = useCallback(async () => {
        if (!adminMayOpenTab(currentUser, 'audit')) {
            setAuditLogs([])
            setAuditTotalEvents(0)
            return
        }
        try {
            const data = await adminAPI.getAuditLogs({ page: 1, pageSize: 400 })
            setAuditLogs(data.logs || [])
            setAuditTotalEvents(Number(data.total) || (data.logs || []).length)
        } catch (err) { showToast(`Failed to load audit logs: ${err.message}`, 'error') }
    }, [currentUser, showToast])

    const loadSettings = useCallback(async () => {
        try {
            setSettingsLoading(true)
            const data = await settingsAPI.getInternal()
            hydrateSettingsForm(data.settings || {})
            setSettingsError('')
        } catch (err) {
            setSettingsError(err.message || 'Failed to load settings.')
        } finally {
            setSettingsLoading(false)
        }
    }, [hydrateSettingsForm])

    useEffect(() => {
        if (recentlyAddedUserId == null) return
        const timer = setTimeout(() => setRecentlyAddedUserId(null), 2600)
        return () => clearTimeout(timer)
    }, [recentlyAddedUserId])

    // ── Load data ─────────────────────────────────────
    useEffect(() => {
        queueMicrotask(() => { void loadAll() })
    }, [loadAll])

    useEffect(() => {
        queueMicrotask(() => {
            if (tab === 'overview') void loadAuditLogs()
            if (tab === 'payroll') void loadPayroll()
            if (tab === 'settings') void loadSettings()
        })
    }, [tab, currentUser, loadPayroll, loadAuditLogs, loadSettings])

    // Auto-refresh payroll and overview audit sample every 30 seconds
    useEffect(() => {
        if (!['overview', 'payroll'].includes(tab)) return
        const interval = setInterval(() => {
            if (tab === 'overview' && adminMayOpenTab(currentUser, 'audit')) void loadAuditLogs()
            if (tab === 'payroll' && adminMayOpenTab(currentUser, 'payroll')) void loadPayroll()
        }, 30000)
        return () => clearInterval(interval)
    }, [tab, currentUser, loadPayroll, loadAuditLogs])

    // Settings tab loads from GET /settings/internal; syncing branding here races refreshBranding and clears social/AI fields.
    useEffect(() => {
        if (!branding || tab === 'settings' || settingsDirty) return
        queueMicrotask(() => {
            hydrateSettingsForm(branding)
        })
    }, [branding, hydrateSettingsForm, tab, settingsDirty])

    const handleSettingInput = (key, value) => {
        setSettingsDirty(true)
        setSettingsForm((prev) => ({ ...prev, [key]: value }))
    }


    const fileToDataUrl = async (file) => {
        if (!file) return ''
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result || ''))
            reader.onerror = () => reject(new Error('Failed to read image file.'))
            reader.readAsDataURL(file)
        })
    }

    const onImagePick = async (event, key) => {
        try {
            const file = event.target.files?.[0]
            if (!file) return
            if (!file.type.startsWith('image/')) {
                showToast('Please select an image file.', 'error')
                return
            }
            const dataUrl = await fileToDataUrl(file)
            handleSettingInput(key, dataUrl)
        } catch (err) {
            showToast(err.message, 'error')
        } finally {
            event.target.value = ''
        }
    }

    const validateSettings = () => {
        if (!settingsForm.system_name.trim()) return 'System name is required.'
        if (settingsForm.system_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settingsForm.system_email)) {
            return 'Enter a valid system email.'
        }
        const urls = ['website_url', 'facebook_url', 'linkedin_url', 'instagram_url', 'x_url']
        for (const key of urls) {
            const value = settingsForm[key]?.trim()
            if (!value) continue
            if (!/^https?:\/\/.+/i.test(value)) return `Enter a valid URL for ${key.replace('_url', '').replace('_', ' ')}.`
        }
        if (settingsForm.deepgram_enabled && !settingsForm.deepgram_api_key_set && !settingsForm.deepgram_api_key?.trim()) {
            return 'Deepgram is enabled but no API key is saved. Enter a key or turn Deepgram off.'
        }
        if (settingsForm.anthropic_enabled && !settingsForm.anthropic_api_key_set && !settingsForm.anthropic_api_key?.trim()) {
            return 'AI note generation is enabled but no Anthropic API key is saved. Enter a key or turn it off.'
        }
        return ''
    }

    const saveSettings = async () => {
        const validationError = validateSettings()
        if (validationError) {
            showToast(validationError, 'error')
            return
        }
        try {
            setSettingsSaving(true)
            const payload = {
                system_name: settingsForm.system_name.trim(),
                system_email: settingsForm.system_email.trim(),
                phone: settingsForm.phone.trim(),
                address: settingsForm.address.trim(),
                company_info: settingsForm.company_info.trim(),
                footer_text: settingsForm.footer_text.trim(),
                support_contact: settingsForm.support_contact.trim(),
                logo_data_url: settingsForm.logo_data_url || '',
                favicon_data_url: settingsForm.favicon_data_url || '',
                primary_color: settingsForm.primary_color,
                secondary_color: settingsForm.secondary_color,
                system_description: settingsForm.system_description.trim(),
                social_links: {
                    website_url: settingsForm.website_url.trim(),
                    facebook_url: settingsForm.facebook_url.trim(),
                    linkedin_url: settingsForm.linkedin_url.trim(),
                    instagram_url: settingsForm.instagram_url.trim(),
                    x_url: settingsForm.x_url.trim(),
                },
                audit_retention_days: Math.max(30, Math.min(Number(settingsForm.audit_retention_days) || 365, 3650)),
                deepgram_enabled: !!settingsForm.deepgram_enabled,
                deepgram_model: settingsForm.deepgram_model?.trim() || 'nova-2',
                deepgram_language: settingsForm.deepgram_language?.trim() || 'en-US',
                deepgram_webhook_url: settingsForm.deepgram_webhook_url?.trim() || '',
                deepgram_auto_transcribe_on_upload: !!settingsForm.deepgram_auto_transcribe_on_upload,
                anthropic_enabled: !!settingsForm.anthropic_enabled,
                anthropic_model: settingsForm.anthropic_model || 'claude-haiku-4-5',
                ffmpeg_enabled: !!settingsForm.ffmpeg_enabled,
                ffmpeg_target_format: settingsForm.ffmpeg_target_format,
                ffmpeg_compression: Math.max(0, Math.min(9, Number(settingsForm.ffmpeg_compression) || 5)),
                ffmpeg_max_upload_mb: Math.max(1, Math.min(500, Number(settingsForm.ffmpeg_max_upload_mb) || 100)),
                ffmpeg_preprocess_before_transcribe: !!settingsForm.ffmpeg_preprocess_before_transcribe,
            }
            if (settingsForm.deepgram_api_key?.trim()) {
                payload.deepgram_api_key = settingsForm.deepgram_api_key.trim()
            }
            if (settingsForm.deepgram_clear_api_key) {
                payload.deepgram_clear_api_key = true
            }
            if (settingsForm.anthropic_api_key?.trim()) {
                payload.anthropic_api_key = settingsForm.anthropic_api_key.trim()
            }
            if (settingsForm.anthropic_clear_api_key) {
                payload.anthropic_clear_api_key = true
            }
            const data = await settingsAPI.update(payload)
            const saved = data.settings || payload
            hydrateSettingsForm(saved)
            setBranding(saved)
            await loadSettings()
            showToast('Settings saved successfully')
        } catch (err) {
            showToast(err.message || 'Failed to save settings.', 'error')
        } finally {
            setSettingsSaving(false)
        }
    }


    // ── Derived ───────────────────────────────────────
    const safe       = Array.isArray(users) ? users : []
    const clinicians = safe.filter(u => u.role === 'clinician')
    const scribes    = safe.filter(u => u.role === 'scribe')
    const qpsStaff      = safe.filter(u => u.role === 'qps')
    const adminsOnly = safe.filter((u) => u.role === 'admin')
    const superAdmins = safe.filter((u) => u.role === 'super_admin')
    const portalAdmins = [...adminsOnly, ...superAdmins].sort((a, b) => (a.name || '').localeCompare(b.name || ''))

    // ── Register user ─────────────────────────────────
    const registerUser = async () => {
        setAddError('')
        const cleanName = newUser.name.trim()
        const cleanEmail = newUser.email.toLowerCase().trim()
        const cleanPhone = (newUser.phone || '').trim()
        const cleanSpecialty = (newUser.specialty || '').trim()
        const cleanNpi = (newUser.npi || '').trim()
        const cleanLicense = (newUser.license || '').trim()

        if (!cleanName)  { setAddError('Name is required.'); return }
        if (!cleanEmail) { setAddError('Email is required.'); return }
        if (!cleanEmail.includes('@')) { setAddError('Enter a valid email.'); return }
        if (!newUserPassword || newUserPassword.length < 6) {
            setAddError('Initial password is required (at least 6 characters).')
            return
        }
        if (newUserPassword.toLowerCase().trim() === 'password*2026') {
            setAddError('Do not use the old example password. Choose a unique password for this user.')
            return
        }
        try {
            setAddLoading(true)
            const payload = {
                name: cleanName,
                email: cleanEmail,
                password: newUserPassword,
                role: addRole,
                phone: cleanPhone || undefined,
                specialty: addRole === 'clinician' ? (cleanSpecialty || undefined) : undefined,
                npi: addRole === 'clinician' ? (cleanNpi || undefined) : undefined,
                license: addRole === 'clinician' ? (cleanLicense || undefined) : undefined,
            }
            const data = await usersAPI.register(payload)
            // Optimistic upsert for instant feedback.
            setUsers((prev) => {
                const next = [data.user, ...prev.filter((u) => u.id !== data.user.id)]
                return next
            })
            setRecentlyAddedUserId(data.user.id)
            void refreshUsers(true)
            setNewUser({ name: '', email: '', specialty: '', phone: '', npi: '', license: '' })
            setNewUserPassword('')
            setShowAdd(false)
            showToast(`${data.user.name} registered successfully`)
        } catch (err) {
            if (err?.status === 403) {
                setAddError('You do not have permission to register users. Please sign in as an admin.')
            } else {
                setAddError(err.message || 'Registration failed. Please try again.')
            }
        }
        finally { setAddLoading(false) }
    }

    const requestRegisterUser = () => {
        if (!newUser.name.trim())  { setAddError('Name is required.'); return }
        if (!newUser.email.trim()) { setAddError('Email is required.'); return }
        if (!newUser.email.includes('@')) { setAddError('Enter a valid email.'); return }
        if (!newUserPassword || newUserPassword.length < 6) {
            setAddError('Initial password is required (at least 6 characters).')
            return
        }
        setConfirmDialog({
            title: 'Confirm account creation',
            message: `Create ${ROLE_CFG[addRole]?.label || 'user'} account for ${newUser.name.trim()}?`,
            confirmText: `Create ${ROLE_CFG[addRole]?.label || 'user'} account`,
            tone: 'primary',
            onConfirm: registerUser,
        })
    }

    // ── Edit user ─────────────────────────────────────
    const saveEdit = async () => {
        setEditError('')
        if (editUser?.role === 'super_admin') {
            if (!isSuperAdmin(currentUser) || String(editUser.id) !== String(currentUser?.id)) {
                setEditError('Only the Super Admin may update that account.')
                return
            }
        }
        try {
            setEditLoading(true)
            const payload = {
                name: editUser.name,
                email: editUser.email,
                role: editUser.role,
                specialty: editUser.specialty,
                phone: editUser.phone,
                npi: editUser.npi,
                license: editUser.license,
                rate_per_note: editUser.rate_per_note,
            }
            if (isSuperAdmin(currentUser) && editUser.role === 'admin') {
                const am = editUser.admin_modules
                if (am == null) {
                    payload.admin_modules = null
                } else if (Array.isArray(am)) {
                    const def = ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN
                    const isDefault =
                        am.length === def.length && def.every((k) => am.includes(k))
                    payload.admin_modules = isDefault ? null : am
                }
            }
            const data = await usersAPI.update(editUser.id, payload)
            setUsers(prev => prev.map(u => u.id === editUser.id ? data.user : u))
            void refreshUsers(true)
            setEditUser(null)
            showToast(`${data.user.name} updated successfully`)
        } catch (err) {
            setEditError(err.message || 'Failed to save changes.')
            showToast(err.message, 'error')
        }
        finally { setEditLoading(false) }
    }

    const saveModulePermissions = useCallback(async (draftModules) => {
        const u = modulePermUser
        if (!u) return
        setModulePermSaving(true)
        try {
            const admin_modules = (() => {
                if (!Array.isArray(draftModules)) return null
                if (draftModules.length === 0) return []
                const def = ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN
                const isDefault =
                    draftModules.length === def.length && def.every((k) => draftModules.includes(k))
                return isDefault ? null : draftModules
            })()
            const data = await usersAPI.patchAdminModules(u.id, admin_modules)
            setUsers((prev) => prev.map((x) => (String(x.id) === String(u.id) ? data.user : x)))
            if (String(currentUser?.id) === String(u.id)) {
                await authAPI.getMe()
                try {
                    setCurrentUser(getCurrentUser())
                } catch {
                    /* ignore */
                }
            }
            showToast('Module permissions updated successfully')
            setModulePermUser(null)
        } catch (err) {
            throw err
        } finally {
            setModulePermSaving(false)
        }
    }, [modulePermUser, currentUser, showToast])

    const requestSaveEdit = () => {
        setConfirmDialog({
            title: 'Confirm user update',
            message: `Save profile changes for ${editUser?.name || 'this user'}?`,
            confirmText: 'Save changes',
            tone: 'primary',
            onConfirm: saveEdit,
        })
    }

    // ── Toggle status ─────────────────────────────────
    const performToggleStatus = async (user) => {
        try {
            await usersAPI.toggleStatus(user.id)
            setUsers(prev => prev.map(u =>
                u.id === user.id ? { ...u, status: u.status === 'active' ? 'inactive' : 'active' } : u
            ))
            showToast(`${user.name} ${user.status === 'active' ? 'deactivated' : 'activated'}`)
        } catch (err) { showToast(err.message, 'error') }
    }

    const toggleStatus = (user) => {
        const isActive = user.status === 'active'
        setConfirmDialog({
            title: `${isActive ? 'Disable' : 'Enable'} user`,
            message: `${isActive ? 'Disable' : 'Enable'} ${user.name}'s account now?`,
            confirmText: isActive ? 'Disable user' : 'Enable user',
            tone: isActive ? 'danger' : 'primary',
            onConfirm: () => performToggleStatus(user),
        })
    }

    // ── Reset password ────────────────────────────────
    const resetPassword = async () => {
        setResetError('')
        if (!resetPass || resetPass.length < 6) { setResetError('Password must be at least 6 characters.'); return }
        try {
            setResetLoading(true)
            await usersAPI.resetPassword(resetUser.id, resetPass)
            showToast(`Password reset for ${resetUser.name}`)
            setResetUser(null); setResetPass(''); setShowResetPass(false)
        } catch (err) { setResetError(err.message) }
        finally { setResetLoading(false) }
    }

    const requestResetPassword = () => {
        setConfirmDialog({
            title: 'Confirm password reset',
            message: `Reset password for ${resetUser?.name || 'this user'}?`,
            confirmText: 'Reset password',
            tone: 'danger',
            onConfirm: resetPassword,
        })
    }

    const runConfirmAction = async () => {
        if (!confirmDialog?.onConfirm) return
        try {
            setConfirmLoading(true)
            await confirmDialog.onConfirm()
            setConfirmDialog(null)
        } finally {
            setConfirmLoading(false)
        }
    }

    const requestSignOut = () => {
        setConfirmDialog({
            title: 'Confirm sign out',
            message: 'Sign out of the admin panel now?',
            confirmText: 'Sign out',
            tone: 'danger',
            onConfirm: async () => {
                authAPI.logout()
                navigate('/login', { replace: true })
            },
        })
    }

    // ── Assignments ───────────────────────────────────
    const addAssignment = async () => {
        if (!assignClinicianId || !assignScribeId) { showToast('Select both a clinician and a scribe.', 'error'); return }
        try {
            setAssignLoading(true)
            const res = await fetch(`${API_BASE}/assignments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ clinician_id: assignClinicianId, scribe_id: assignScribeId }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setAssignments(prev => [...prev, data.assignment])
            setAssignClinicianId(''); setAssignScribeId('')
            showToast('Scribe assigned successfully')
        } catch (err) { showToast(err.message, 'error') }
        finally { setAssignLoading(false) }
    }

    const removeAssignment = async (id) => {
        try {
            const res = await fetch(`${API_BASE}/assignments/${id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'Failed to remove assignment.')
            setAssignments(prev => prev.filter(a => a.id !== id))
            showToast('Assignment removed')
        } catch (err) { showToast(err.message, 'error') }
    }

    const requestRemoveAssignment = (assignment) => {
        setConfirmDialog({
            title: 'Confirm assignment removal',
            message: `Remove assignment between ${assignment.clinician_name} and ${assignment.scribe_name}?`,
            confirmText: 'Remove assignment',
            tone: 'danger',
            onConfirm: () => removeAssignment(assignment.id),
        })
    }

    // ─── RENDER ───────────────────────────────────────
    const payrollTotalDue = payroll.reduce((a, p) => a + parseFloat(p.total_amount || 0), 0)
    const payrollNotes = payroll.reduce((a, p) => a + parseInt(p.notes_completed || 0), 0)
    const activeUsersCount = safe.filter((u) => u.status === 'active').length
    const inactiveUsersCount = safe.filter((u) => u.status === 'inactive').length

    const roleActivity = (role) => buildDailyCountSeries(
        auditLogs,
        (log) => log.created_at,
        14,
        (log) => log.user_role === role
    )
    const assignmentActivity = buildDailyCountSeries(assignments, (a) => a.assigned_at, 14)
    const totalUserActivity = buildDailyCountSeries(
        auditLogs,
        (log) => log.created_at,
        14,
        (log) => log.action === 'USER_REGISTERED'
    )
    const activationActivity = buildDailyCountSeries(
        auditLogs,
        (log) => log.created_at,
        14,
        (log) => log.action === 'USER_ACTIVATED'
    )
    const deactivationActivity = buildDailyCountSeries(
        auditLogs,
        (log) => log.created_at,
        14,
        (log) => log.action === 'USER_DEACTIVATED'
    )
    const adminOpsActivity = buildDailyCountSeries(
        auditLogs,
        (log) => log.created_at,
        14,
        (log) => log.user_role === 'admin' || log.user_role === 'super_admin'
    )

    const overviewStats = [
        {
            label: 'Clinicians',
            value: clinicians.length,
            color: BRAND.deep,
            icon: '🩺',
            period: 'vs previous week',
            hint: 'Provider activity',
            cardClass: 'tone-teal',
            points: roleActivity('clinician'),
        },
        {
            label: 'Scribes',
            value: scribes.length,
            color: BRAND.secondary,
            icon: '📝',
            period: 'vs previous week',
            hint: 'Documentation flow',
            cardClass: 'tone-emerald',
            points: roleActivity('scribe'),
        },
        {
            label: 'QPS Staff',
            value: qpsStaff.length,
            color: BRAND.root,
            icon: '✅',
            period: 'vs previous week',
            hint: 'Review throughput',
            cardClass: 'tone-blue',
            points: roleActivity('qps'),
        },
        {
            label: 'Super Admins',
            value: superAdmins.length,
            color: BRAND.secondaryLight,
            icon: '👑',
            period: 'vs previous week',
            hint: 'Highest privilege tier',
            cardClass: 'tone-violet',
            points: roleActivity('super_admin'),
        },
        {
            label: 'Admins',
            value: adminsOnly.length,
            color: BRAND.muted,
            icon: '⚙️',
            period: 'vs previous week',
            hint: 'Scoped by module policy',
            cardClass: 'tone-slate',
            points: adminOpsActivity,
        },
        {
            label: 'Total Users',
            value: safe.length,
            color: BRAND.light,
            icon: '👥',
            period: 'new registrations',
            hint: 'Directory footprint',
            cardClass: 'tone-amber',
            points: totalUserActivity,
        },
        {
            label: 'Active',
            value: activeUsersCount,
            color: SEM.success,
            icon: '🟢',
            period: 'activation events',
            hint: 'Enabled accounts',
            cardClass: 'tone-green',
            points: activationActivity,
        },
        {
            label: 'Inactive',
            value: inactiveUsersCount,
            color: SEM.danger,
            icon: '🔴',
            period: 'deactivation events',
            hint: 'Needs follow-up',
            cardClass: 'tone-rose',
            invertTrend: true,
            points: deactivationActivity,
        },
        {
            label: 'Assignments',
            value: assignments.length,
            color: BRAND.deep,
            icon: '🔗',
            period: 'new pairings',
            hint: 'Routing updates',
            cardClass: 'tone-indigo',
            points: assignmentActivity,
        },
    ]

    const heroChips = (() => {
        switch (tab) {
            case 'overview':
                return [
                    { label: 'Directory', value: String(safe.length) },
                    { label: 'Active', value: String(activeUsersCount) },
                    { label: 'Assignments', value: String(assignments.length) },
                ]
            case 'clinicians':
                return [
                    { label: 'Active', value: String(clinicians.filter((u) => u.status === 'active').length) },
                    { label: 'Total', value: String(clinicians.length) },
                ]
            case 'scribes':
                return [
                    { label: 'Active', value: String(scribes.filter((u) => u.status === 'active').length) },
                    { label: 'Total', value: String(scribes.length) },
                ]
            case 'qps':
                return [
                    { label: 'Active', value: String(qpsStaff.filter((u) => u.status === 'active').length) },
                    { label: 'Total', value: String(qpsStaff.length) },
                ]
            case 'admins':
                return [
                    { label: 'Super Admins', value: String(superAdmins.filter((u) => u.status === 'active').length) },
                    { label: 'Admins', value: String(adminsOnly.filter((u) => u.status === 'active').length) },
                ]
            case 'assignments':
                return [
                    { label: 'Pairs', value: String(assignments.length) },
                    { label: 'Active clinicians', value: String(clinicians.filter((c) => c.status === 'active').length) },
                    { label: 'Active scribes', value: String(scribes.filter((s) => s.status === 'active').length) },
                ]
            case 'payroll':
                return [
                    { label: 'Staff', value: String(payroll.length) },
                    { label: 'Notes', value: String(payrollNotes) },
                    { label: 'Total due', value: `$${payrollTotalDue.toFixed(2)}` },
                ]
            case 'audit':
                return [
                    { label: 'Directory total', value: auditDashMeta?.total != null ? String(auditDashMeta.total) : String(auditTotalEvents) },
                    { label: 'Page', value: auditDashMeta?.page != null ? String(auditDashMeta.page) : '—' },
                    { label: 'Alerts', value: auditDashMeta?.alerts != null ? String(auditDashMeta.alerts) : '—' },
                ]
            case 'settings':
                return [
                    { label: 'Environment', value: 'Production' },
                    { label: 'Auth', value: 'JWT · RBAC' },
                ]
            default:
                return []
        }
    })()

    const sidebarBadges = {
        clinicians: clinicians.length,
        scribes: scribes.length,
        qps: qpsStaff.length,
        admins: (isSuperAdmin(currentUser) || adminMayOpenTab(currentUser, 'admins')) ? portalAdmins.length : 0,
        assignments: assignments.length,
        audit: auditDashMeta?.total ?? auditTotalEvents,
    }

    const userTableProps = {
        loading,
        refreshing: usersRefreshing,
        highlightUserId: recentlyAddedUserId,
        isSuperAdminViewer: isSuperAdmin(currentUser),
        onOpenModulePermissions: setModulePermUser,
        setEditUser,
        setResetUser,
        setResetPass,
        setResetError,
        setShowResetPass,
        toggleStatus,
        setAddRole,
        setShowAdd,
        setAddError,
        setNewUserPassword,
        setNewUser,
    }

    const navItems = useMemo(() => {
        const keys = new Set(resolvedAdminModuleKeys(currentUser))
        return NAV.filter((n) => keys.has(n.key))
    }, [currentUser])

    useEffect(() => {
        if (!navItems.some((n) => n.key === tab)) {
            setTab(navItems[0]?.key || 'overview')
        }
    }, [navItems, tab])

    const handleSelectTab = (key) => {
        if (tab === 'settings' && key !== 'settings' && settingsDirty) {
            setConfirmDialog({
                tone: 'primary',
                title: 'You have unsaved changes',
                message: 'Leave without saving?',
                confirmText: 'Leave',
                cancelText: 'Stay',
                onConfirm: () => {
                    hydrateSettingsForm(branding)
                    setSettingsDirty(false)
                    setTab(key)
                    sidebar.close()
                },
            })
            return
        }
        setTab(key)
        sidebar.close()
    }

    return (
        <div className="sf-page sf-portal adm-shell" data-adm-tab={tab}>
            {sessionTimeoutModal}
            <AdminSidebar
                tab={tab}
                onSelectTab={handleSelectTab}
                currentUser={currentUser}
                onRequestSignOut={requestSignOut}
                badges={sidebarBadges}
                branding={branding}
                sidebarOpen={sidebar.open}
                navItems={navItems}
            />
            <div className="sf-main sf-portal__main">
                <Overlay open={sidebar.open} onClick={sidebar.close} className="adm-shell-overlay" />

                {/* Topbar */}
                <header className="sf-topbar adm-topbar">
                    <div className="adm-topbar__start">
                        <button
                            type="button"
                            className="adm-topbar__menu-btn"
                            onClick={sidebar.toggle}
                            aria-label={sidebar.open ? 'Close navigation menu' : 'Open navigation menu'}
                            aria-expanded={sidebar.open}
                            aria-controls="adm-admin-sidebar"
                        >
                            <span className="adm-topbar__menu-line" aria-hidden />
                            <span className="adm-topbar__menu-line" aria-hidden />
                            <span className="adm-topbar__menu-line" aria-hidden />
                        </button>
                        <div className="adm-topbar__titles">
                            <div className="adm-topbar__module">{navItems.find((n) => n.key === tab)?.label || 'Admin'}</div>
                            <div className="adm-topbar__brand">{branding.system_name || 'Anot'}</div>
                        </div>
                    </div>
                    <div className="adm-topbar__end">
                        <SfAccountMenu
                            menuId="adm-account-menu"
                            user={currentUser}
                            fallback="A"
                            onViewProfile={() => handleSelectTab('system-profile')}
                            onLogout={requestSignOut}
                        />
                    </div>
                </header>

                {/* Toast */}
                {toast && (
                    <div className={`adm-toast ${toast.type === 'error' ? 'adm-toast--error' : 'adm-toast--success'}`}>
                        {toast.type === 'error' ? '⚠ ' : '✓ '}{toast.msg}
                    </div>
                )}

                <div className={`sf-body adm adm-module adm-module--${tab}`}>
                    <ModuleHero tab={tab} chips={heroChips} />

                    {/* ── OVERVIEW ──────────────────────────────── */}
                    {tab === 'overview' && (
                        <>
                            <div className="adm-stats-grid adm-stats-grid--premium">
                                {overviewStats.map((item) => (
                                    <OverviewStatCard key={item.label} item={item} loading={loading} />
                                ))}
                            </div>
                            {assignmentsLoadError && (
                                <div className="adm-alert adm-alert--danger">
                                    <span style={{ fontSize: 13 }}>Could not load assignments: {assignmentsLoadError}</span>
                                    <button type="button" className="adm-alert__retry" onClick={() => loadAll()}>
                                        Retry
                                    </button>
                                </div>
                            )}
                            <div className="adm-overview-grid">
                                <div className="adm-spotlight-card">
                                    <div className="adm-spotlight-card__title">Clinicians</div>
                                    {clinicians.length === 0 ? (
                                        <div className="adm-spotlight-card__empty">No clinicians yet.</div>
                                    ) : (
                                        clinicians.slice(0, 6).map((u, i) => (
                                            <div key={i} className="adm-spotlight-card__row">
                                                <div style={{ flex: 1 }}>
                                                    <div className="adm-spotlight-card__name">{u.name}</div>
                                                    <div className="adm-spotlight-card__sub">{u.specialty || 'Clinician'}</div>
                                                </div>
                                                <span
                                                    className="adm-badge"
                                                    style={{
                                                        background: u.status === 'active' ? 'rgba(209,250,229,0.25)' : 'rgba(238,242,255,0.2)',
                                                        color: '#fff',
                                                        fontSize: 9,
                                                    }}
                                                >
                                                    {u.status}
                                                </span>
                                            </div>
                                        ))
                                    )}
                                </div>
                                <div className="adm-spotlight-card">
                                    <div className="adm-spotlight-card__title">Scribes</div>
                                    {scribes.length === 0 ? (
                                        <div className="adm-spotlight-card__empty">No scribes yet.</div>
                                    ) : (
                                        scribes.map((u, i) => (
                                            <div key={i} className="adm-spotlight-card__row">
                                                <div style={{ flex: 1 }}>
                                                    <div className="adm-spotlight-card__name">{u.name}</div>
                                                    <div className="adm-spotlight-card__sub">{displayEmail(u.email)}</div>
                                                </div>
                                                <span
                                                    className="adm-badge"
                                                    style={{
                                                        background: u.status === 'active' ? 'rgba(209,250,229,0.25)' : 'rgba(238,242,255,0.2)',
                                                        color: '#fff',
                                                        fontSize: 9,
                                                    }}
                                                >
                                                    {u.status}
                                                </span>
                                            </div>
                                        ))
                                    )}
                                </div>
                                <div className="adm-spotlight-card">
                                    <div className="adm-spotlight-card__title">Assignments</div>
                                    {assignments.length === 0 ? (
                                        <div className="adm-spotlight-card__empty">
                                            No assignments.{' '}
                                            <span className="adm-spotlight-card__link" role="button" tabIndex={0} onClick={() => setTab('assignments')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setTab('assignments')}>
                                                Assign now →
                                            </span>
                                        </div>
                                    ) : (
                                        assignments.slice(0, 6).map((a, i) => (
                                            <div key={i} className="adm-spotlight-card__row">
                                                <div style={{ flex: 1 }}>
                                                    <div className="adm-spotlight-card__name">{a.clinician_name}</div>
                                                    <div className="adm-spotlight-card__sub">→ {a.scribe_name}</div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {/* ── ROLE TABS ─────────────────────────────── */}
                    {tab === 'clinicians' && <AdminUserTable {...userTableProps} userList={clinicians} role="clinician" />}
                    {tab === 'scribes'    && <AdminUserTable {...userTableProps} userList={scribes}    role="scribe" />}
                    {tab === 'qps'        && <AdminUserTable {...userTableProps} userList={qpsStaff}   role="qps" />}
                    {tab === 'admins' && (isSuperAdmin(currentUser) || adminMayOpenTab(currentUser, 'admins')) && (
                        <AdminUserTable {...userTableProps} userList={portalAdmins} role="elevated" />
                    )}

                    {/* ── ASSIGNMENTS ───────────────────────────── */}
                    {tab === 'assignments' && (
                        <>
                            {assignmentsLoadError && (
                                <div className="adm-alert adm-alert--danger">
                                    <span style={{ fontSize: 13 }}>Could not load assignments: {assignmentsLoadError}</span>
                                    <button type="button" className="adm-alert__retry" onClick={() => loadAll()}>
                                        Retry
                                    </button>
                                </div>
                            )}
                            <div className="adm-form-card adm-form-card--dashed">
                                <div className="adm-form-card__title">Assign scribe to clinician</div>
                                <div className="adm-form-grid adm-form-grid--assign">
                                    <div className="adm-form-group">
                                        <label className="adm-form-label">Clinician</label>
                                        <select className="adm-input" value={assignClinicianId} onChange={(e) => setAssignClinicianId(e.target.value)}>
                                            <option value="">Select clinician...</option>
                                            {clinicians.filter((c) => c.status === 'active').map((c) => (
                                                <option key={c.id} value={c.id}>{c.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="adm-form-group">
                                        <label className="adm-form-label">Scribe</label>
                                        <select className="adm-input" value={assignScribeId} onChange={(e) => setAssignScribeId(e.target.value)}>
                                            <option value="">Select scribe...</option>
                                            {scribes.filter((sc) => sc.status === 'active').map((sc) => (
                                                <option key={sc.id} value={sc.id}>{sc.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <button type="button" className="adm-btn-primary" style={{ height: 42 }} onClick={addAssignment} disabled={assignLoading}>
                                        {assignLoading ? 'Assigning…' : '+ Assign'}
                                    </button>
                                </div>
                            </div>
                            <div className="adm-section-label">Current assignments ({assignments.length})</div>
                            {assignments.length === 0 ? (
                                <AdminEmpty
                                    icon="🔗"
                                    title="No assignments yet"
                                    hint="Pair active clinicians with scribes so documentation routing stays clear."
                                    actionLabel="Create assignment"
                                    onAction={() => {
                                        const form = document.querySelector('.adm-form-card--dashed')
                                        form?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                    }}
                                />
                            ) : (
                                <div className="adm-table-scroll">
                                <div className="adm-table-wrap adm-table-wrap--cards">
                                    <div className="adm-table__head">
                                        <div style={{ flex: 2 }}>Clinician</div>
                                        <div style={{ flex: 2 }}>Scribe</div>
                                        <div style={{ flex: 1 }}>Date</div>
                                        <div style={{ flex: 1 }}>Action</div>
                                    </div>
                                    {assignments.map((a) => (
                                        <div key={a.id} className="adm-table__row">
                                            <div className="adm-td" data-label="Clinician" style={{ flex: 2 }}>
                                                <div style={{ fontWeight: 600 }}>{a.clinician_name}</div>
                                            </div>
                                            <div className="adm-td" data-label="Scribe" style={{ flex: 2 }}>
                                                <div style={{ fontWeight: 600 }}>{a.scribe_name}</div>
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.scribe_email}</div>
                                            </div>
                                            <div className="adm-td" data-label="Date" style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>{fmtAdminDate(a.assigned_at)}</div>
                                            <div className="adm-td" data-label="Action" style={{ flex: 1 }}>
                                                <button type="button" className="adm-btn-action" style={{ color: '#b91c1c' }} onClick={() => requestRemoveAssignment(a)}>
                                                    Remove
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                </div>
                            )}
                        </>
                    )}

                    {/* ── PAYROLL ───────────────────────────────── */}
                    {tab === 'payroll' && (
                        <>
                            <div className="adm-stats-grid adm-stats-grid--payroll">
                                {[
                                    {
                                        label: 'Total Staff',
                                        value: payroll.length,
                                        icon: '📝',
                                        hint: 'Eligible this period',
                                        tone: 'teal',
                                    },
                                    {
                                        label: 'Active Contributors',
                                        value: payroll.filter((p) => p.status === 'active').length,
                                        icon: '✅',
                                        hint: 'Currently billing',
                                        tone: 'green',
                                    },
                                    {
                                        label: 'Notes Processed',
                                        value: payroll.reduce((a, p) => a + parseInt(p.notes_completed || 0), 0),
                                        icon: '📄',
                                        hint: 'Across all staff',
                                        tone: 'blue',
                                    },
                                    {
                                        label: 'Total Due',
                                        value: `$${payroll.reduce((a, p) => a + parseFloat(p.total_amount || 0), 0).toFixed(2)}`,
                                        icon: '💰',
                                        hint: 'Current payout window',
                                        tone: 'gold',
                                    },
                                ].map((item) => (
                                    <div key={item.label} className={`adm-pay-card adm-pay-card--${item.tone}`}>
                                        <div className="adm-pay-card__head">
                                            <div className="adm-pay-card__k">{item.label}</div>
                                            <div className="adm-pay-card__icon" aria-hidden>{item.icon}</div>
                                        </div>
                                        <div className="adm-pay-card__v">{item.value}</div>
                                        <div className="adm-pay-card__hint">{item.hint}</div>
                                        <div className="adm-pay-card__meter">
                                            <span />
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="adm-payroll-summary">
                                <div className="adm-payroll-summary__chip">
                                    <span className="adm-payroll-summary__k">Average per staff</span>
                                    <span className="adm-payroll-summary__v">
                                        ${payroll.length ? (payroll.reduce((a, p) => a + parseFloat(p.total_amount || 0), 0) / payroll.length).toFixed(2) : '0.00'}
                                    </span>
                                </div>
                                <div className="adm-payroll-summary__chip">
                                    <span className="adm-payroll-summary__k">Average notes</span>
                                    <span className="adm-payroll-summary__v">
                                        {payroll.length ? Math.round(payroll.reduce((a, p) => a + parseInt(p.notes_completed || 0), 0) / payroll.length) : 0}
                                    </span>
                                </div>
                                <div className="adm-payroll-summary__chip">
                                    <span className="adm-payroll-summary__k">Highest payout</span>
                                    <span className="adm-payroll-summary__v">
                                        ${payroll.length ? Math.max(...payroll.map((p) => parseFloat(p.total_amount || 0))).toFixed(2) : '0.00'}
                                    </span>
                                </div>
                            </div>
                            <div className="adm-section-head">
                                <div className="adm-section-label adm-section-label--inline">Staff payroll</div>
                                <button type="button" className="adm-btn-primary" onClick={loadPayroll}>Refresh</button>
                            </div>
                            {payrollLoading ? (
                                <LoadingBox variant="table" />
                            ) : payroll.length === 0 ? (
                                <AdminEmpty
                                    icon="💳"
                                    title="No payroll data yet"
                                    hint="Completed notes and per-user rates roll up into payouts here as activity grows."
                                    actionLabel="Refresh"
                                    onAction={loadPayroll}
                                />
                            ) : (
                                <>
                                <Suspense fallback={<div className="adm-chart-strip adm-chart-strip--loading" aria-hidden />}>
                                    <PayrollMiniChart payroll={payroll} />
                                </Suspense>
                                <div className="adm-table-scroll adm-table-scroll--wide">
                                <div className="adm-table-wrap adm-table-wrap--cards">
                                    <div className="adm-table__head">
                                        <div style={{ flex: 2 }}>Name</div>
                                        <div style={{ flex: 1 }}>Role</div>
                                        <div style={{ flex: 1 }}>Status</div>
                                        <div style={{ flex: 1 }}>Notes</div>
                                        <div style={{ flex: 1 }}>Rate/note</div>
                                        <div style={{ flex: 1 }}>Total due</div>
                                    </div>
                                            {payroll.map((p, i) => (
                                                <div key={i} className="adm-table__row">
                                                    <div className="adm-td" data-label="Name" style={{ flex: 2 }}>
                                                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{displayEmail(p.email)}</div>
                                                    </div>
                                                    <div className="adm-td" data-label="Role" style={{ flex: 1 }}>
                                                        <span
                                                            className="adm-badge"
                                                            style={{
                                                                ...(ROLE_CFG[p.role] && {
                                                                    background: ROLE_CFG[p.role].bg,
                                                                    color: ROLE_CFG[p.role].color,
                                                                }),
                                                            }}
                                                        >
                                                            {ROLE_CFG[p.role]?.icon} {p.role}
                                                        </span>
                                                    </div>
                                                    <div className="adm-td" data-label="Status" style={{ flex: 1 }}>
                                                        <span
                                                            className="adm-badge"
                                                            style={{
                                                                background: p.status === 'active' ? '#d1fae5' : '#eef2ff',
                                                                color: p.status === 'active' ? '#065f46' : '#64748b',
                                                            }}
                                                        >
                                                            {p.status}
                                                        </span>
                                                    </div>
                                                    <div className="adm-td" data-label="Notes" style={{ flex: 1, fontWeight: 700 }}>{p.notes_completed}</div>
                                                    <div className="adm-td" data-label="Rate / note" style={{ flex: 1, fontSize: 13 }}>${parseFloat(p.rate_per_note || 0).toFixed(2)}</div>
                                                    <div className="adm-td" data-label="Total due" style={{ flex: 1, fontWeight: 700, color: '#059669' }}>${parseFloat(p.total_amount || 0).toFixed(2)}</div>
                                                </div>
                                            ))}
                                            <div className="adm-table__row adm-table__row--footer">
                                                    <div className="adm-td" data-label="Summary" style={{ flex: 2, color: 'var(--text-main)' }}>Total</div>
                                                    <div className="adm-td adm-td--skip" style={{ flex: 1 }} aria-hidden />
                                                    <div className="adm-td adm-td--skip" style={{ flex: 1 }} aria-hidden />
                                                    <div className="adm-td" data-label="Notes" style={{ flex: 1 }}>{payroll.reduce((a, p) => a + parseInt(p.notes_completed || 0), 0)}</div>
                                                    <div className="adm-td adm-td--skip" style={{ flex: 1 }} aria-hidden />
                                                    <div className="adm-td" data-label="Total due" style={{ flex: 1, color: '#059669' }}>
                                                        ${payroll.reduce((a, p) => a + parseFloat(p.total_amount || 0), 0).toFixed(2)}
                                                    </div>
                                                </div>
                                </div>
                                </div>
                                </>
                            )}
                        </>
                    )}

                    {/* ── AUDIT LOGS ────────────────────────────── */}
                    {tab === 'audit' && (
                        <div className="adm-module--audit">
                            <AdminAuditDashboard showToast={showToast} currentUser={currentUser} onMeta={setAuditDashMeta} />
                        </div>
                    )}

                    {/* ── SETTINGS ──────────────────────────────── */}
                    {tab === 'settings' && (
                        <>
                            {settingsLoading ? (
                                <LoadingBox />
                            ) : (
                                <div className="adm-settings-layout">
                                    <div className="adm-form-card">
                                        <div className="adm-form-card__title">Branding & identity</div>
                                        <div className="adm-form-grid">
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">System name *</label>
                                                <input className="adm-input" value={settingsForm.system_name} onChange={(e) => handleSettingInput('system_name', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">System description</label>
                                                <input className="adm-input" value={settingsForm.system_description} onChange={(e) => handleSettingInput('system_description', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Primary color</label>
                                                <input className="adm-input" type="color" value={settingsForm.primary_color} onChange={(e) => handleSettingInput('primary_color', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Secondary color</label>
                                                <input className="adm-input" type="color" value={settingsForm.secondary_color} onChange={(e) => handleSettingInput('secondary_color', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Brand logo</label>
                                                <input className="adm-input" type="file" accept="image/*" onChange={(e) => onImagePick(e, 'logo_data_url')} />
                                                {settingsForm.logo_data_url && <img className="adm-settings-preview" src={settingsForm.logo_data_url} alt="Brand logo preview" />}
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Favicon</label>
                                                <input className="adm-input" type="file" accept="image/*" onChange={(e) => onImagePick(e, 'favicon_data_url')} />
                                                {settingsForm.favicon_data_url && <img className="adm-settings-preview adm-settings-preview--icon" src={settingsForm.favicon_data_url} alt="Favicon preview" />}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="adm-form-card">
                                        <div className="adm-form-card__title">Contact & company</div>
                                        <div className="adm-form-grid">
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Email</label>
                                                <input className="adm-input" value={settingsForm.system_email} onChange={(e) => handleSettingInput('system_email', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Phone</label>
                                                <input className="adm-input" value={settingsForm.phone} onChange={(e) => handleSettingInput('phone', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Address</label>
                                                <input className="adm-input" value={settingsForm.address} onChange={(e) => handleSettingInput('address', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Support contact</label>
                                                <input className="adm-input" value={settingsForm.support_contact} onChange={(e) => handleSettingInput('support_contact', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">Company information</label>
                                                <textarea className="adm-input adm-textarea" value={settingsForm.company_info} onChange={(e) => handleSettingInput('company_info', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">Footer text</label>
                                                <input className="adm-input" value={settingsForm.footer_text} onChange={(e) => handleSettingInput('footer_text', e.target.value)} />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="adm-form-card">
                                        <div className="adm-form-card__title">Social media links</div>
                                        <div className="adm-form-grid">
                                            {[
                                                ['Website URL', 'website_url'],
                                                ['Facebook URL', 'facebook_url'],
                                                ['LinkedIn URL', 'linkedin_url'],
                                                ['Instagram URL', 'instagram_url'],
                                                ['X/Twitter URL', 'x_url'],
                                            ].map(([label, key]) => (
                                                <div key={key} className="adm-form-group">
                                                    <label className="adm-form-label">{label}</label>
                                                    <input className="adm-input" placeholder="https://..." value={settingsForm[key]} onChange={(e) => handleSettingInput(key, e.target.value)} />
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="adm-form-card">
                                        <div className="adm-form-card__title">AI &amp; media services</div>
                                        <p className="adm-settings-note" style={{ marginBottom: 16 }}>
                                            Deepgram, Anthropic, and FFmpeg run only on the server. Store a strong <code>SETTINGS_ENCRYPTION_KEY</code> in production for API key encryption at rest.
                                        </p>
                                        <div className="adm-form-card__title" style={{ fontSize: 15, marginTop: 8 }}>Deepgram (transcription)</div>
                                        <div className="adm-form-grid">
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.deepgram_enabled} onChange={(e) => handleSettingInput('deepgram_enabled', e.target.checked)} /> Enable Deepgram when API key is configured
                                                </label>
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">API key {settingsForm.deepgram_api_key_set ? <span style={{ color: '#059669' }}>(saved)</span> : null}</label>
                                                <input className="adm-input" type="password" autoComplete="new-password" placeholder={settingsForm.deepgram_api_key_set ? 'Leave blank to keep existing key' : 'Enter Deepgram API key'}
                                                    value={settingsForm.deepgram_api_key} onChange={(e) => handleSettingInput('deepgram_api_key', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.deepgram_clear_api_key} onChange={(e) => handleSettingInput('deepgram_clear_api_key', e.target.checked)} /> Remove stored API key on save
                                                </label>
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Model</label>
                                                <input className="adm-input" value={settingsForm.deepgram_model} onChange={(e) => handleSettingInput('deepgram_model', e.target.value)} placeholder="nova-2" />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Language</label>
                                                <input className="adm-input" value={settingsForm.deepgram_language} onChange={(e) => handleSettingInput('deepgram_language', e.target.value)} placeholder="en-US" />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">Webhook callback URL (optional)</label>
                                                <input className="adm-input" value={settingsForm.deepgram_webhook_url} onChange={(e) => handleSettingInput('deepgram_webhook_url', e.target.value)} placeholder="https://your-api.example.com/api/webhooks/deepgram" />
                                                <p className="adm-settings-note" style={{ marginTop: 8 }}>
                                                    When set, single-recording visits use Deepgram async callback; append <code>?visit_id=…&amp;sig=…</code> is automatic. Verify with <code>DEEPGRAM_WEBHOOK_SECRET</code> (or <code>JWT_SECRET</code>). Multi-file visits stay synchronous.
                                                </p>
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.deepgram_auto_transcribe_on_upload} onChange={(e) => handleSettingInput('deepgram_auto_transcribe_on_upload', e.target.checked)} /> Auto-transcribe when primary recording is uploaded
                                                </label>
                                            </div>
                                        </div>
                                        <div className="adm-form-card__title" style={{ fontSize: 15, marginTop: 20 }}>Anthropic (AI note generation)</div>
                                        <div className="adm-form-grid">
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.anthropic_enabled} onChange={(e) => handleSettingInput('anthropic_enabled', e.target.checked)} /> Enable AI note generation
                                                </label>
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">Anthropic API key {settingsForm.anthropic_api_key_set ? <span style={{ color: '#059669' }}>(saved)</span> : null}</label>
                                                <input className="adm-input" type="password" autoComplete="new-password" placeholder={settingsForm.anthropic_api_key_set ? 'Leave blank to keep existing key' : 'sk-ant-...'}
                                                    value={settingsForm.anthropic_api_key} onChange={(e) => handleSettingInput('anthropic_api_key', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.anthropic_clear_api_key} onChange={(e) => handleSettingInput('anthropic_clear_api_key', e.target.checked)} /> Remove stored API key on save
                                                </label>
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Model</label>
                                                <select className="adm-input" value={settingsForm.anthropic_model} onChange={(e) => handleSettingInput('anthropic_model', e.target.value)}>
                                                    <option value="claude-haiku-4-5">claude-haiku-4-5 (Fast, recommended)</option>
                                                    <option value="claude-sonnet-4-5">claude-sonnet-4-5 (Balanced)</option>
                                                    <option value="claude-opus-4-5">claude-opus-4-5 (Most capable)</option>
                                                </select>
                                            </div>
                                        </div>
                                        <div className="adm-form-card__title" style={{ fontSize: 15, marginTop: 20 }}>FFmpeg (audio preprocessing)</div>
                                        <div className="adm-form-grid">
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.ffmpeg_enabled} onChange={(e) => handleSettingInput('ffmpeg_enabled', e.target.checked)} /> Enable preprocessing pipeline (requires ffmpeg on server PATH)
                                                </label>
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Target format</label>
                                                <select className="adm-input" value={settingsForm.ffmpeg_target_format} onChange={(e) => handleSettingInput('ffmpeg_target_format', e.target.value)}>
                                                    <option value="wav">wav</option>
                                                    <option value="mp3">mp3</option>
                                                    <option value="ogg">ogg (Opus - smallest, fastest)</option>
                                                    <option value="webm">webm</option>
                                                    <option value="flac">flac</option>
                                                </select>
                                                <p className="adm-form-hint" style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
                                                    OGG Opus recommended — smallest file size, fastest upload, excellent voice quality.
                                                </p>
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Compression (0–9, mp3 VBR)</label>
                                                <input className="adm-input" type="number" min={0} max={9} value={settingsForm.ffmpeg_compression} onChange={(e) => handleSettingInput('ffmpeg_compression', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group">
                                                <label className="adm-form-label">Max upload (MB)</label>
                                                <input className="adm-input" type="number" min={1} max={500} value={settingsForm.ffmpeg_max_upload_mb} onChange={(e) => handleSettingInput('ffmpeg_max_upload_mb', e.target.value)} />
                                            </div>
                                            <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="adm-form-label">
                                                    <input type="checkbox" checked={!!settingsForm.ffmpeg_preprocess_before_transcribe} onChange={(e) => handleSettingInput('ffmpeg_preprocess_before_transcribe', e.target.checked)} /> Preprocess before sending to transcription API
                                                </label>
                                            </div>
                                        </div>
                                    </div>

                                    {settingsError && <div className="adm-err">⚠ {settingsError}</div>}
                                    <div className="adm-settings-actions">
                                        <button type="button" className="adm-btn-primary" onClick={saveSettings} disabled={settingsSaving}>
                                            {settingsSaving ? 'Saving settings…' : 'Save settings'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="adm-section-label">Security</div>
                            <div className="adm-form-card">
                                <div className="adm-form-card__title" style={{ marginBottom: 14 }}>Security features</div>
                                <div className="adm-security-tags">
                                    {['JWT authentication', 'Role-based access', 'bcrypt password hashing', 'Protected API routes', 'Audit logging'].map((f, i) => (
                                        <span key={i} className="adm-badge adm-badge--security">
                                            {f} ✓
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}

                    {tab === 'system-profile' && (
                        <>
                            <SystemProfileManager
                                showToast={showToast}
                                roleLabel={isSuperAdmin(currentUser) ? 'Super Admin' : 'Administrator'}
                                compact
                            />
                        </>
                    )}

                </div>
            </div>

            {/* ── ADD USER MODAL ────────────────────────────── */}
            {showAdd && (
                <div className="adm-modal-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}>
                    <div className="adm-modal">
                        <div className="adm-modal__title">{ROLE_CFG[addRole]?.icon} Register new {ROLE_CFG[addRole]?.label}</div>
                        <div className="adm-modal__scroll">
                            <div className="adm-form-group adm-form-group--modal-gap">
                                <label className="adm-form-label">Role</label>
                                <select
                                    className="adm-input"
                                    value={addRole}
                                    onChange={(e) => {
                                        const nextRole = e.target.value
                                        setAddRole(nextRole)
                                        if (nextRole !== 'clinician') {
                                            setNewUser((prev) => ({ ...prev, specialty: '', npi: '', license: '' }))
                                        }
                                    }}
                                >
                                    <option value="clinician">Clinician</option>
                                    <option value="scribe">Scribe</option>
                                    <option value="qps">QPS</option>
                                    {isSuperAdmin(currentUser) && (
                                        <option value="admin">Admin</option>
                                    )}
                                </select>
                            </div>
                            <div className="adm-form-grid">
                                {[
                                    ['Full Name *', 'name', 'text', 'Full name'],
                                    ['Email *', 'email', 'email', 'name@anot.ai'],
                                    ['Phone', 'phone', 'text', '+1 (555) 000-0000'],
                                    ...(addRole === 'clinician' ? [
                                        ['Specialty', 'specialty', 'text', 'e.g. Internal Medicine'],
                                        ['NPI Number', 'npi', 'text', 'NPI-0000000000'],
                                        ['License', 'license', 'text', 'MD-XX-00000'],
                                    ] : [['Specialty', 'specialty', 'text', 'Optional']]),
                                ].map(([l, k, type, ph]) => (
                                    <div key={k} className="adm-form-group">
                                        <label className="adm-form-label">{l}</label>
                                        <input className="adm-input" type={type} placeholder={ph}
                                               value={newUser[k] || ''} onChange={(e) => setNewUser({ ...newUser, [k]: e.target.value })} />
                                    </div>
                                ))}
                                <div className="adm-form-group">
                                    <label className="adm-form-label">Initial password *</label>
                                    <input className="adm-input" type="password" placeholder="Min. 6 characters — share securely with the user"
                                           value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} autoComplete="new-password" />
                                </div>
                            </div>
                            {addError && <div className="adm-err">⚠ {addError}</div>}
                        </div>
                        <div className="adm-modal__footer adm-modal__footer--adduser">
                            <button
                                type="button"
                                className="adm-btn-primary adm-btn-primary--adduser"
                                onClick={requestRegisterUser}
                                disabled={addLoading}
                            >
                                {addLoading ? 'Registering…' : `Create ${ROLE_CFG[addRole]?.label} account`}
                            </button>
                            <button
                                type="button"
                                className="adm-btn-ghost adm-btn-ghost--adduser"
                                onClick={() => { setShowAdd(false); setAddError(''); setNewUserPassword('') }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── EDIT USER MODAL ───────────────────────────── */}
            {editUser && (
                <div className="adm-modal-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && setEditUser(null)}>
                    <div className="adm-modal">
                        <div className="adm-modal__title">Edit — {editUser.name}</div>
                        <div className="adm-modal__scroll">
                            <div className="adm-form-grid">
                                {[['Full Name', 'name'],['Email', 'email'],['Phone', 'phone'],['Specialty', 'specialty'],
                                    ...(editUser.role === 'clinician' ? [['NPI', 'npi'],['License', 'license']] : []),
                                ].map(([l, k]) => (
                                    <div key={k} className="adm-form-group">
                                        <label className="adm-form-label">{l}</label>
                                        <input className="adm-input" value={editUser[k] || ''}
                                               onChange={(e) => setEditUser({ ...editUser, [k]: e.target.value })} />
                                    </div>
                                ))}
                                <div className="adm-form-group">
                                    <label className="adm-form-label">Role</label>
                                    {editUser.role === 'super_admin' ? (
                                        <div
                                            className="adm-input"
                                            style={{
                                                opacity: 0.95,
                                                cursor: 'not-allowed',
                                                background: 'var(--gray-bg)',
                                                fontWeight: 600,
                                                display: 'flex',
                                                alignItems: 'center',
                                            }}
                                        >
                                            Super Admin
                                            <span style={{ fontWeight: 500, color: 'var(--text-muted)', marginLeft: 8 }}>
                                                (fixed system role)
                                            </span>
                                        </div>
                                    ) : (
                                    <select
                                        className="adm-input"
                                        value={editUser.role}
                                        onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}
                                    >
                                        <option value="clinician">Clinician</option>
                                        <option value="scribe">Scribe</option>
                                        <option value="qps">QPS</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                    )}
                                </div>
                                {isSuperAdmin(currentUser) && editUser.role === 'admin' && (
                                    <div className="adm-form-group" style={{ gridColumn: '1 / -1' }}>
                                        <label className="adm-form-label">Admin portal modules</label>
                                        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                                            All checked (or default) grants every portal section listed below.
                                        </p>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                                            {ADMIN_PORTAL_MODULES.map(({ key: mk, icon, label }) => {
                                                const on =
                                                    editUser.admin_modules == null ||
                                                    (Array.isArray(editUser.admin_modules) && editUser.admin_modules.includes(mk))
                                                return (
                                                    <label
                                                        key={mk}
                                                        style={{
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: 6,
                                                            fontSize: 13,
                                                            fontWeight: 600,
                                                            color: 'var(--text-main)',
                                                            padding: '8px 12px',
                                                            borderRadius: 10,
                                                            border: '1px solid var(--border)',
                                                            background: on ? 'color-mix(in srgb, var(--brand-primary) 8%, #fff)' : 'var(--bg-card)',
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={on}
                                                            onChange={() => toggleAdminModuleKey(mk)}
                                                        />
                                                        <span aria-hidden style={{ fontSize: 15 }}>{icon}</span>
                                                        {label}
                                                    </label>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )}
                                <div className="adm-form-group">
                                    <label className="adm-form-label">Rate per note ($)</label>
                                    <input className="adm-input" type="number" step="0.50" min="0"
                                           value={editUser.rate_per_note || 2.50}
                                           onChange={(e) => setEditUser({ ...editUser, rate_per_note: e.target.value })} />
                                </div>
                            </div>
                            {editError && <div className="adm-err">⚠ {editError}</div>}
                        </div>
                        <div className="adm-modal__footer adm-modal__footer--action">
                            <button type="button" className="adm-btn-primary adm-btn-primary--modal-action" onClick={requestSaveEdit} disabled={editLoading}>
                                {editLoading ? 'Saving…' : 'Save changes'}
                            </button>
                            <button type="button" className="adm-btn-ghost adm-btn-ghost--modal-action" onClick={() => setEditUser(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── RESET PASSWORD MODAL ──────────────────────── */}
            {resetUser && (
                <div className="adm-modal-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && setResetUser(null)}>
                    <div className="adm-modal">
                        <div className="adm-modal__title">Reset password</div>
                        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
                            <strong style={{ color: 'var(--text-main)' }}>{resetUser.name}</strong> · {displayEmail(resetUser.email)} · {resetUser.role}
                        </div>
                        <div className="adm-form-group">
                            <label className="adm-form-label">New password</label>
                            <div className="adm-modal__pw-wrap">
                                <input className="adm-input" style={{ paddingRight: 44 }}
                                       type={showResetPass ? 'text' : 'password'}
                                       placeholder="Minimum 6 characters"
                                       value={resetPass}
                                       onChange={(e) => setResetPass(e.target.value)} />
                                <button type="button" className="adm-modal__eye" onClick={() => setShowResetPass((p) => !p)}
                                        aria-label={showResetPass ? 'Hide password' : 'Show password'}>
                                    {showResetPass ? '🙈' : '👁️'}
                                </button>
                            </div>
                        </div>
                        <div className="adm-modal__hint">Share the new password securely with the user.</div>
                        {resetError && <div className="adm-err">⚠ {resetError}</div>}
                        <div className="adm-modal__footer adm-modal__footer--action">
                            <button type="button" className="adm-btn-primary adm-btn-primary--modal-action" onClick={requestResetPassword} disabled={resetLoading}>
                                {resetLoading ? 'Resetting…' : 'Reset password'}
                            </button>
                            <button type="button" className="adm-btn-ghost adm-btn-ghost--modal-action" onClick={() => { setResetUser(null); setResetPass(''); setShowResetPass(false) }}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            <AdminModulePermissionsModal
                open={!!modulePermUser}
                user={modulePermUser}
                onClose={() => { if (!modulePermSaving) setModulePermUser(null) }}
                onSave={saveModulePermissions}
                saving={modulePermSaving}
            />

            {/* ── CONFIRM ACTION MODAL ───────────────────────── */}
            {confirmDialog && (
                <div className="adm-modal-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && !confirmLoading && setConfirmDialog(null)}>
                    <div className={`adm-modal adm-modal--confirm ${confirmDialog.tone === 'danger' ? 'adm-modal--confirm-danger' : 'adm-modal--confirm-primary'}`}>
                        <div className="adm-confirm-head">
                            <div className={`adm-confirm-head__icon ${confirmDialog.tone === 'danger' ? 'is-danger' : 'is-primary'}`} aria-hidden>
                                {confirmDialog.tone === 'danger' ? '⚠' : '✓'}
                            </div>
                            <div>
                                <div className="adm-modal__title adm-modal__title--confirm">{confirmDialog.title}</div>
                                <div className="adm-confirm-sub">This action requires your confirmation.</div>
                            </div>
                        </div>
                        <div className="adm-modal__hint adm-modal__hint--confirm">{confirmDialog.message}</div>
                        <div className="adm-modal__footer adm-modal__footer--action">
                            <button
                                type="button"
                                className={`adm-btn-primary adm-btn-primary--modal-action ${confirmDialog.tone === 'danger' ? 'adm-btn-primary--danger' : ''}`}
                                onClick={runConfirmAction}
                                disabled={confirmLoading}
                            >
                                {confirmLoading ? 'Please wait…' : (confirmDialog.confirmText || 'Confirm')}
                            </button>
                            <button
                                type="button"
                                className="adm-btn-ghost adm-btn-ghost--modal-action"
                                onClick={() => setConfirmDialog(null)}
                                disabled={confirmLoading}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    )
}
