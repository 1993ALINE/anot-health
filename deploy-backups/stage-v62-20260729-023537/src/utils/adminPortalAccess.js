const {
    isSuperAdmin,
    staffRoleToAdminModuleKey,
} = require('./roles')

function forbidden(msg) {
    const e = new Error(msg || 'You do not have permission for this action.')
    e.statusCode = 403
    return e
}

/** Admin must have at least one of the listed portal modules (Super Admin bypass). */
function assertAdminHasAnyPortalModule(req, moduleKeys) {
    if (!req.user) throw forbidden('Not authorized.')
    if (isSuperAdmin(req.user.role)) return
    if (req.user.role !== 'admin') return
    const set = req.adminModuleKeys
    if (!set || set.size === 0) throw forbidden('You do not have permission for this admin area.')
    if (!moduleKeys.some((k) => set.has(k))) {
        throw forbidden('You do not have permission for this admin area.')
    }
}

/**

 * Non–Super Admin acting on another user's record must hold the module for that user's cohort.

 * Self-service on own row is always allowed for signed-in admins.

 */

function assertAdminCanAccessStaffUser(req, targetUser) {

    if (!targetUser) return

    if (isSuperAdmin(req.user.role)) return

    if (req.user.role !== 'admin') return

    if (String(targetUser.id) === String(req.user.id)) return

    const key = staffRoleToAdminModuleKey(targetUser.role)

    if (!key || !req.adminModuleKeys?.has(key)) {

        throw forbidden('You do not have permission for this user.')

    }

}



/** When an Admin assigns/changes role, they must be allowed to manage the new role's cohort. */

function assertAdminMayUseStaffRole(req, role) {

    if (isSuperAdmin(req.user.role)) return

    if (req.user.role !== 'admin') return

    const key = staffRoleToAdminModuleKey(role)

    if (key && !req.adminModuleKeys?.has(key)) {

        throw forbidden('You do not have permission to use that role.')

    }

}



module.exports = {

    assertAdminHasAnyPortalModule,

    assertAdminCanAccessStaffUser,

    assertAdminMayUseStaffRole,

    forbidden,

}
