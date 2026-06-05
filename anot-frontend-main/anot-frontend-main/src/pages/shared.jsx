import { useState, useEffect, useRef, useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_BRAND_LOGO_SRC } from '../services/branding'

/** Sidebar brand row: wordmark (tenant logo or `DEFAULT_BRAND_LOGO_SRC`) + portal subtitle. */
export function PortalSidebarBrand({ branding, subtitle }) {
    const b = branding || {}
    const name = b.system_name || 'Anot'
    const custom = b.logo_data_url && String(b.logo_data_url).trim()
    const src = custom || DEFAULT_BRAND_LOGO_SRC
    return (
        <div className="sf-sidebar-rich__brand">
            <img
                className="adm-sidebar-brand-img"
                src={src}
                alt=""
                width={148}
                height={40}
                decoding="async"
                aria-hidden
            />
            <div className="sf-sidebar-rich__titles">
                <div className="sf-logo">{name}</div>
                <div className="sf-logo-sub">{subtitle}</div>
            </div>
        </div>
    )
}

/** Normalizes note.transcription: JSON array of segments, or plain string → display blocks */
export function parseTranscriptionBlocks(raw) {
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed.map((x) => (x == null ? '' : String(x))).filter((s) => s.length > 0)
        return [String(parsed)]
    } catch {
        const s = String(raw)
        if (s.includes('\n\n')) return s.split('\n\n').filter(Boolean)
        return s ? [s] : []
    }
}

/* ── Responsive sidebar toggle ─────────────────────────── */
export function useSidebar() {
    const [open, setOpen] = useState(false)
    const toggle = () => setOpen(o => !o)
    const close  = () => setOpen(false)

    useEffect(() => {
        if (open) document.body.style.overflow = 'hidden'
        else      document.body.style.overflow = ''
        return () => { document.body.style.overflow = '' }
    }, [open])

    return { open, toggle, close }
}

/** True when portal sidebar is an off-canvas drawer (tablet / mobile). Matches Admin breakpoint. */
function subscribePortalDrawerMq(callback) {
    const mq = window.matchMedia('(max-width: 1024px)')
    mq.addEventListener('change', callback)
    return () => mq.removeEventListener('change', callback)
}

function getPortalDrawerMqSnapshot() {
    return window.matchMedia('(max-width: 1024px)').matches
}

export function usePortalDrawerMode() {
    return useSyncExternalStore(subscribePortalDrawerMq, getPortalDrawerMqSnapshot, () => true)
}

/**
 * Sticky header matching Admin `adm-topbar`: in-bar menu on drawer breakpoints, module title, brand line, account menu.
 * Pass `titleRow` to replace the default title stack (e.g. back button + headings).
 */
export function PortalTopbar({
    drawerMode,
    sidebarOpen,
    onMenuClick,
    moduleTitle,
    brandName,
    user,
    avatarFallback = '?',
    onViewProfile,
    onSettings,
    onLogout,
    menuId = 'portal-account-menu',
    accountMenuVariant,
    endBeforeAccount = null,
    titleRow = null,
    navControlsId,
}) {
    return (
        <header className="sf-topbar adm-topbar">
            <div className="adm-topbar__start">
                {drawerMode ? (
                    <button
                        type="button"
                        className="adm-topbar__menu-btn"
                        aria-label={sidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
                        aria-expanded={sidebarOpen}
                        aria-controls={navControlsId || undefined}
                        onClick={onMenuClick}
                    >
                        <span className="adm-topbar__menu-line" aria-hidden />
                        <span className="adm-topbar__menu-line" aria-hidden />
                        <span className="adm-topbar__menu-line" aria-hidden />
                    </button>
                ) : null}
                {titleRow ? (
                    titleRow
                ) : (
                    <div className="adm-topbar__titles">
                        <div className="adm-topbar__module">{moduleTitle}</div>
                        <div className="adm-topbar__brand">{brandName}</div>
                    </div>
                )}
            </div>
            <div className="adm-topbar__end">
                {endBeforeAccount}
                <SfAccountMenu
                    user={user}
                    fallback={avatarFallback}
                    onViewProfile={onViewProfile}
                    onSettings={onSettings}
                    onLogout={onLogout}
                    menuId={menuId}
                    variant={accountMenuVariant}
                />
            </div>
        </header>
    )
}

/* ── Hamburger button ──────────────────────────────────── */
export function Hamburger({ onClick }) {
    return (
        <button className="sf-hamburger" onClick={onClick} aria-label="Open menu">
            <span /><span /><span />
        </button>
    )
}

/* ── Overlay ───────────────────────────────────────────── */
export function Overlay({ open, onClick, className = '' }) {
    return (
        <div
            className={`sf-overlay${open ? ' open' : ''}${className ? ` ${className}` : ''}`.trim()}
            onClick={onClick}
            aria-hidden={!open}
        />
    )
}

/** Data URL from `users.avatar_data_url` when present and valid. */
export function userProfileImageUrl(user) {
    const u = user?.avatar_data_url
    if (!u || typeof u !== 'string') return null
    if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/i.test(u.trim())) return null
    return u.trim()
}

/** Top bar / header: profile photo or initial letter. */
export function SfTopbarAvatar({ user, fallback = '?' }) {
    const name = (user?.name && String(user.name).trim()) || ''
    const letter = (name.charAt(0) || fallback).toUpperCase()
    const src = userProfileImageUrl(user)
    if (src) {
        return (
            <div className="sf-avatar sf-avatar--image" title={name || undefined}>
                <img src={src} alt="" className="sf-avatar__img" decoding="async" />
            </div>
        )
    }
    return (
        <div className="sf-avatar" title={name || undefined}>
            {letter}
        </div>
    )
}

/** Layered under app modals (e.g. 1200) but above all page chrome / cards. */
const SF_ACCOUNT_MENU_Z = 1180

/**
 * Header avatar that opens a premium-style account menu (dropdown).
 * Menu is portaled to document.body with position:fixed so parent overflow never clips it.
 */
export function SfAccountMenu({
    user,
    fallback = '?',
    onViewProfile,
    onSettings,
    onProfilePreview,
    onChangePhoto,
    onLogout,
    menuId = 'sf-account-menu',
    variant,
}) {
    const [open, setOpen] = useState(false)
    const [panelPos, setPanelPos] = useState(null)
    const triggerRef = useRef(null)
    const panelRef = useRef(null)
    const openedAtRef = useRef(0)
    const ignoreOutsideRef = useRef(false)

    const close = useCallback(() => {
        setPanelPos(null)
        setOpen(false)
        requestAnimationFrame(() => triggerRef.current?.focus())
    }, [])

    const updatePanelPosition = useCallback(() => {
        const tr = triggerRef.current
        const panel = panelRef.current
        if (!tr) return

        const rect = tr.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        const gap = 10
        const width = Math.min(300, vw - 24)
        let right = vw - rect.right
        if (rect.right - width < 12) {
            right = vw - width - 12
        }
        right = Math.max(12, right)
        const maxH = Math.min(420, vh - 24)

        let top = rect.bottom + gap
        if (panel) {
            const ph = panel.getBoundingClientRect().height
            if (top + ph > vh - 12) {
                const above = rect.top - gap - ph
                top = above >= 12 ? above : Math.max(12, vh - ph - 12)
            }
        }
        setPanelPos({ top, right, width, maxH })
    }, [])

    useLayoutEffect(() => {
        if (!open) return
        let raf2
        const raf1 = requestAnimationFrame(() => {
            updatePanelPosition()
            raf2 = requestAnimationFrame(() => updatePanelPosition())
        })
        const onScroll = () => {
            if (Date.now() - openedAtRef.current < 450) return
            updatePanelPosition()
        }
        window.addEventListener('resize', updatePanelPosition)
        document.addEventListener('scroll', onScroll, true)
        return () => {
            cancelAnimationFrame(raf1)
            if (raf2) cancelAnimationFrame(raf2)
            window.removeEventListener('resize', updatePanelPosition)
            document.removeEventListener('scroll', onScroll, true)
        }
    }, [open, updatePanelPosition])

    useEffect(() => {
        if (!open) return
        const onDoc = (e) => {
            if (ignoreOutsideRef.current) {
                ignoreOutsideRef.current = false
                return
            }
            if (Date.now() - openedAtRef.current < 300) return
            if (
                !triggerRef.current?.contains(e.target) &&
                !panelRef.current?.contains(e.target)
            ) {
                close()
            }
        }
        const timer = window.setTimeout(() => {
            document.addEventListener('pointerdown', onDoc, true)
        }, 0)
        return () => {
            window.clearTimeout(timer)
            document.removeEventListener('pointerdown', onDoc, true)
        }
    }, [open, close])

    useEffect(() => {
        if (!open) return
        const onKey = (e) => {
            if (e.key === 'Escape') close()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [open, close])

    const name = (user?.name && String(user.name).trim()) || 'Account'
    const email = (user?.email && String(user.email).trim()) || ''
    const role = user?.role ? String(user.role).replace(/_/g, ' ') : ''

    const run = (fn) => {
        if (typeof fn === 'function') {
            fn()
            close()
        }
    }

    const panelStyle =
        open && panelPos
            ? {
                  position: 'fixed',
                  zIndex: SF_ACCOUNT_MENU_Z,
                  top: panelPos.top,
                  right: panelPos.right,
                  width: panelPos.width,
                  maxHeight: panelPos.maxH,
              }
            : open
              ? { position: 'fixed', zIndex: SF_ACCOUNT_MENU_Z, visibility: 'hidden', top: -9999, left: -9999 }
              : undefined

    const panelContent = (
        <div
            ref={panelRef}
            id={`${menuId}-panel`}
            className={`sf-account-menu__panel sf-account-menu__panel--portal${variant === 'clinician' ? ' sf-account-menu__panel--clinician' : ''}${open ? ' sf-account-menu__panel--open' : ''}`}
            role="menu"
            aria-hidden={!open}
            style={panelStyle}
        >
            <div className="sf-account-menu__head" role="presentation">
                <div className="sf-account-menu__head-name">{name}</div>
                {email ? <div className="sf-account-menu__head-email">{email}</div> : null}
                {role ? <div className="sf-account-menu__head-role">{role}</div> : null}
            </div>
            <div className="sf-account-menu__items">
                {typeof onViewProfile === 'function' ? (
                    <button type="button" className="sf-account-menu__item" role="menuitem" onClick={() => run(onViewProfile)}>
                        <span className="sf-account-menu__ico" aria-hidden>👤</span>
                        <span>{variant === 'clinician' ? 'Profile' : 'View profile'}</span>
                    </button>
                ) : null}
                {typeof onSettings === 'function' ? (
                    <button type="button" className="sf-account-menu__item" role="menuitem" onClick={() => run(onSettings)}>
                        <span className="sf-account-menu__ico" aria-hidden>⚙️</span>
                        <span>Settings</span>
                    </button>
                ) : null}
                {typeof onProfilePreview === 'function' ? (
                    <button type="button" className="sf-account-menu__item" role="menuitem" onClick={() => run(onProfilePreview)}>
                        <span className="sf-account-menu__ico" aria-hidden>📋</span>
                        <span>Profile preview</span>
                    </button>
                ) : null}
                {typeof onChangePhoto === 'function' ? (
                    <button type="button" className="sf-account-menu__item" role="menuitem" onClick={() => run(onChangePhoto)}>
                        <span className="sf-account-menu__ico" aria-hidden>📷</span>
                        <span>Change photo</span>
                    </button>
                ) : null}
                {typeof onLogout === 'function' ? (
                    <>
                        <div className="sf-account-menu__sep" role="separator" />
                        <button type="button" className="sf-account-menu__item sf-account-menu__item--danger" role="menuitem" onClick={() => run(onLogout)}>
                            <span className="sf-account-menu__ico" aria-hidden>🚪</span>
                            <span>{variant === 'clinician' ? 'Sign Out' : 'Log out'}</span>
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    )

    return (
        <div className="sf-account-menu">
            <button
                type="button"
                ref={triggerRef}
                className="sf-account-menu__trigger"
                id={`${menuId}-trigger`}
                aria-expanded={open}
                aria-haspopup="true"
                aria-controls={open ? `${menuId}-panel` : undefined}
                onPointerDown={() => {
                    ignoreOutsideRef.current = true
                }}
                onClick={() =>
                    setOpen((wasOpen) => {
                        if (wasOpen) {
                            setPanelPos(null)
                            return false
                        }
                        openedAtRef.current = Date.now()
                        ignoreOutsideRef.current = true
                        return true
                    })
                }
            >
                <SfTopbarAvatar user={user} fallback={fallback} />
            </button>
            {open && typeof document !== 'undefined' ? createPortal(panelContent, document.body) : null}
        </div>
    )
}

const SF_CONFIRM_PORTAL_Z = 1250

/**
 * Premium confirmation modal (matches Admin `adm-modal--confirm`). Portaled to `document.body`
 * so it stacks above role shell / sidebars. Parent owns `dialog` state and `onConfirm` execution.
 *
 * `dialog` shape: { title, message, tone?: 'primary'|'danger', confirmText?, cancelText?, onConfirm?: () => void | Promise<void> }
 */
export function ConfirmDialog({ dialog, loading = false, onDismiss, onConfirm }) {
    useEffect(() => {
        if (!dialog) return
        const onKey = (e) => {
            if (e.key === 'Escape' && !loading) onDismiss()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [dialog, loading, onDismiss])

    if (!dialog) return null

    const tone = dialog.tone === 'danger' ? 'danger' : 'primary'
    const modal = (
        <div
            className="adm-modal-overlay"
            role="presentation"
            style={{ zIndex: SF_CONFIRM_PORTAL_Z }}
            onClick={(e) => e.target === e.currentTarget && !loading && onDismiss()}
        >
            <div
                className={`adm-modal adm-modal--confirm ${tone === 'danger' ? 'adm-modal--confirm-danger' : 'adm-modal--confirm-primary'}`}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="sf-confirm-title"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="adm-confirm-head">
                    <div className={`adm-confirm-head__icon ${tone === 'danger' ? 'is-danger' : 'is-primary'}`} aria-hidden>
                        {tone === 'danger' ? '⚠' : '✓'}
                    </div>
                    <div>
                        <div id="sf-confirm-title" className="adm-modal__title adm-modal__title--confirm">
                            {dialog.title}
                        </div>
                        <div className="adm-confirm-sub">This action requires your confirmation.</div>
                    </div>
                </div>
                <div className="adm-modal__hint adm-modal__hint--confirm">{dialog.message}</div>
                <div className="adm-modal__footer adm-modal__footer--action">
                    <button
                        type="button"
                        className={`adm-btn-primary adm-btn-primary--modal-action ${tone === 'danger' ? 'adm-btn-primary--danger' : ''}`}
                        onClick={onConfirm}
                        disabled={loading}
                    >
                        {loading ? 'Please wait…' : dialog.confirmText || 'Confirm'}
                    </button>
                    <button type="button" className="adm-btn-ghost adm-btn-ghost--modal-action" onClick={onDismiss} disabled={loading}>
                        {dialog.cancelText || 'Cancel'}
                    </button>
                </div>
            </div>
        </div>
    )

    return typeof document !== 'undefined' ? createPortal(modal, document.body) : null
}