const pool = require('../config/db')

const { isSuperAdmin, resolvedAdminPortalKeysForAdmin } = require('../utils/roles')



/**

 * Loads this user's admin_modules from DB and sets `req.adminModuleKeys` (Set) for role=admin.

 * Super Admin: `req.adminModuleKeys = null` (treated as unrestricted downstream).

 */

async function loadAdminPortalModuleKeys(req, res, next) {

    try {

        if (!req.user?.id) return next()

        if (isSuperAdmin(req.user.role)) {

            req.adminModuleKeys = null

            return next()

        }

        if (req.user.role !== 'admin') {

            req.adminModuleKeys = null

            return next()

        }

        const r = await pool.query('SELECT admin_modules FROM users WHERE id = $1', [req.user.id])

        const keys = resolvedAdminPortalKeysForAdmin(r.rows[0]?.admin_modules)

        req.adminModuleKeys = new Set(keys)

        next()

    } catch (err) {

        console.error('loadAdminPortalModuleKeys:', err.message)

        res.status(500).json({ error: 'Server error.' })

    }

}



/** Super Admin bypass. Admin must have at least one of `keys`. Other roles should not use this chain. */

function requireAdminPortalModules(...keys) {

    return (req, res, next) => {

        if (!req.user) return res.status(401).json({ error: 'Not authorized.' })

        if (isSuperAdmin(req.user.role)) return next()

        if (req.user.role !== 'admin') {

            return res.status(403).json({ error: 'Access denied.' })

        }

        const set = req.adminModuleKeys

        if (!set || set.size === 0) {

            return res.status(403).json({ error: 'You do not have permission for this admin area.' })

        }

        if (!keys.some((k) => set.has(k))) {

            return res.status(403).json({ error: 'You do not have permission for this admin area.' })

        }

        next()

    }

}



/**

 * Applies portal module check only when the user is a non–Super Admin `admin`.

 * Used on routes also accessed by clinicians/scribe/qps (e.g. GET /assignments).

 */

function requireAdminPortalModulesIfAdmin(...keys) {

    return (req, res, next) => {

        if (!req.user) return res.status(401).json({ error: 'Not authorized.' })

        if (req.user.role !== 'admin' || isSuperAdmin(req.user.role)) return next()

        return requireAdminPortalModules(...keys)(req, res, next)

    }

}



module.exports = {

    loadAdminPortalModuleKeys,

    requireAdminPortalModules,

    requireAdminPortalModulesIfAdmin,

}

