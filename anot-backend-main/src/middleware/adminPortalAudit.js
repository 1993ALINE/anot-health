const { auditLog, reportAuditFailure } = require('../utils/auditLogger')

const lastLogged = new Map()
const THROTTLE_MS = 90_000

/**
 * Throttled audit when an admin successfully opens a portal-backed GET route.
 * Does not block the response (runs after next()).
 */
function logAdminPortalModuleAccess(moduleKey) {
    const key = String(moduleKey || 'portal').slice(0, 64)
    return (req, res, next) => {
        next()
        if (req.method !== 'GET') return
        if (!req.user?.id) return
        const uid = req.user.id
        const mapKey = `${uid}:${key}`
        const now = Date.now()
        if ((lastLogged.get(mapKey) || 0) > now - THROTTLE_MS) return
        lastLogged.set(mapKey, now)
        setImmediate(() => {
            auditLog(
                req.user,
                'ADMIN_PORTAL_ACCESS',
                'portal',
                key,
                `Viewed admin module: ${key}`,
                { req, module_key: key, action_category: 'module_access', status: 'success' }
            ).catch(reportAuditFailure)
        })
    }
}

module.exports = { logAdminPortalModuleAccess }
