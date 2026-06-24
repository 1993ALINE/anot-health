/**
 * Single source for “which dashboard after login?” — driven only by the user’s role from the API.
 * Aliases (e.g. doctor → clinician) never require the user to pick a role on the login screen.
 */

const PATH_BY_ROLE = {
    clinician: '/clinician',
    scribe: '/scribe',
    qps: '/qps',
    admin: '/admin',
    super_admin: '/admin',
}

/** Synonyms that may appear in JWT/DB now or in the future */
const ALIAS_TO_CANONICAL = {
    doctor: 'clinician',
    physician: 'clinician',
    md: 'clinician',
}

export function normalizeCanonicalRole(role) {
    if ((role === null || role === undefined) || role === '') {return null}
    const r = String(role).toLowerCase().trim()
    return ALIAS_TO_CANONICAL[r] || r
}

/** Returns React Router path (e.g. /clinician) or null if unknown. */
export function dashboardPathForRole(role) {
    const c = normalizeCanonicalRole(role)
    if (!c || !PATH_BY_ROLE[c]) {return null}
    return PATH_BY_ROLE[c]
}

/** True if this role maps to any known portal (can sign in and land on a dashboard). */
export function isKnownPortalRole(role) {
    return dashboardPathForRole(role) !== null
}

/**
 * Protected routes: `allowedRole` is the route’s canonical role (e.g. "admin").
 * Super Admin uses the same /admin app as Admin.
 */
export function roleMatchesPortal(userRole, portalCanonicalRole) {
    const u = normalizeCanonicalRole(userRole)
    const p = portalCanonicalRole
    if (p === 'admin') {return u === 'admin' || u === 'super_admin'}
    return u === p
}

export const CANONICAL_ROLES = Object.keys(PATH_BY_ROLE)
