/**
 * Admin portal role helpers (client). Must stay aligned with backend `src/utils/roles.js`.
 */

/**
 * Canonical admin-portal modules (keys match sidebar `NAV` / API checks).
 * Order and labels match the Module permissions UI.
 */
// NOTE: 'performance' intentionally omitted — performance reports are a QPS
// capability and live in the QPS portal, not the Admin portal.
export const ADMIN_PORTAL_MODULES = [
    { key: 'overview', icon: '📊', label: 'Overview' },
    { key: 'clinicians', icon: '🩺', label: 'Clinicians' },
    { key: 'scribes', icon: '📝', label: 'Scribes' },
    { key: 'qps', icon: '✅', label: 'QPS Staff' },
    { key: 'admins', icon: '⚙️', label: 'Admins' },
    { key: 'assignments', icon: '🔗', label: 'Assignments' },
    { key: 'payroll', icon: '💳', label: 'Payroll' },
    { key: 'audit', icon: '🔍', label: 'Audit Logs' },
    { key: 'settings', icon: '🛠', label: 'Settings' },
    { key: 'system-profile', icon: '👤', label: 'Profile Management' },
]

export const ADMIN_GRANTABLE_MODULE_KEYS = ADMIN_PORTAL_MODULES.map((m) => m.key)

/** Default when `admin_modules` is null: all grantable modules except the Admins tab. */
export const ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN = ADMIN_GRANTABLE_MODULE_KEYS.filter((k) => k !== 'admins')

export function isSuperAdmin(user) {
    return user?.role === 'super_admin'
}

export function isAdminPortalUser(user) {
    const r = user?.role
    return r === 'admin' || r === 'super_admin'
}

/** Resolved module keys an Admin user may open; Super Admin always gets every module. */
export function resolvedAdminModuleKeys(user) {
    if (!user) {return []}
    if (isSuperAdmin(user)) {
        return [...ADMIN_GRANTABLE_MODULE_KEYS]
    }
    const raw = user.admin_modules
    if (raw === null || raw === undefined) {
        return [...ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN]
    }
    if (!Array.isArray(raw)) {
        return [...ADMIN_DEFAULT_MODULE_KEYS_FOR_ADMIN]
    }
    const set = new Set(ADMIN_GRANTABLE_MODULE_KEYS)
    return raw.filter((k) => set.has(k))
}

export function adminMayOpenTab(user, tabKey) {
    if (!user) {return false}
    if (isSuperAdmin(user)) {return true}
    return resolvedAdminModuleKeys(user).includes(tabKey)
}
