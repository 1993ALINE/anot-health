/**
 * Canonical role identifiers and hierarchy helpers.
 * super_admin > admin > other staff roles.
 */

const ELEVATED_ROLES = new Set(['admin', 'super_admin'])

/** Roles a regular Admin may create. */
const ASSIGNABLE_ROLES = ['clinician', 'scribe', 'qps']

/** Only Super Admin may create these (never super_admin — that role is bootstrap-only). */
const ELEVATED_CREATABLE_ROLES = ['admin']

const isSuperAdmin = (role) => role === 'super_admin'

const isAdminPortal = (role) => role === 'admin' || role === 'super_admin'

const isElevatedAccount = (role) => ELEVATED_ROLES.has(role)

/** Keys Super Admin may grant to Admin accounts (must match userController + frontend). */
const GRANTABLE_ADMIN_MODULE_KEYS = [
    'overview',
    'clinicians',
    'scribes',
    'qps',
    'admins',
    'assignments',
    'payroll',
    'performance',
    'audit',
    'settings',
    'system-profile',
]
const GRANTABLE_ADMIN_MODULE_SET = new Set(GRANTABLE_ADMIN_MODULE_KEYS)

/** Same semantics as frontend `resolvedAdminModuleKeys` for role=admin (null = all except Admins tab). */
function resolvedAdminPortalKeysForAdmin(adminModules) {
    if (adminModules == null) {
        return GRANTABLE_ADMIN_MODULE_KEYS.filter((k) => k !== 'admins')
    }
    if (!Array.isArray(adminModules)) return GRANTABLE_ADMIN_MODULE_KEYS.filter((k) => k !== 'admins')
    return adminModules.filter((k) => GRANTABLE_ADMIN_MODULE_SET.has(k))
}

/** Map a staff account role to the admin-portal module that gates management of that cohort. */
function staffRoleToAdminModuleKey(role) {
    if (role === 'clinician') return 'clinicians'
    if (role === 'scribe') return 'scribes'
    if (role === 'qps') return 'qps'
    if (role === 'admin' || role === 'super_admin') return 'admins'
    return null
}

/**
 * Regular admin may manage non-elevated users, their own row, and (with `admins` module) other Admin accounts.
 * `adminModuleKeys` is the caller's resolved Set from `loadAdminPortalModuleKeys` (omit for non-request checks).
 */
function actorMayManageUser(actorRole, targetUser, actorId, adminModuleKeys) {
    if (!targetUser) return false
    if (isSuperAdmin(actorRole)) return true
    if (actorRole !== 'admin') return false
    if (actorId != null && String(targetUser.id) === String(actorId)) return true
    if (isElevatedAccount(targetUser.role)) {
        if (targetUser.role === 'super_admin') return false
        if (targetUser.role === 'admin') {
            return !!(adminModuleKeys && adminModuleKeys.has && adminModuleKeys.has('admins'))
        }
        return false
    }
    return true
}

module.exports = {
    ASSIGNABLE_ROLES,
    ELEVATED_CREATABLE_ROLES,
    ELEVATED_ROLES,
    GRANTABLE_ADMIN_MODULE_KEYS,
    GRANTABLE_ADMIN_MODULE_SET,
    resolvedAdminPortalKeysForAdmin,
    staffRoleToAdminModuleKey,
    isSuperAdmin,
    isAdminPortal,
    isElevatedAccount,
    actorMayManageUser,
}
