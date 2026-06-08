const jwt = require('jsonwebtoken')
const pool = require('../config/db')

// ─── SESSION REVOCATION CACHE ──────────────────────────────────────────────────
// A valid JWT alone is not enough: an account may have been deactivated, or its
// role changed, after the token was issued (tokens live up to JWT_EXPIRES_IN).
// We re-check the account against the DB, but cache the result briefly so we
// don't add a query to every single authenticated request.
const USER_CHECK_TTL_MS = 60 * 1000
const userCheckCache = new Map() // userId -> { status, role, found, expiresAt }

async function getUserAuthState(userId) {
    const key = Number(userId)
    const now = Date.now()
    const cached = userCheckCache.get(key)
    if (cached && cached.expiresAt > now) return cached

    const { rows } = await pool.query('SELECT status, role FROM users WHERE id = $1', [key])
    const row = rows[0]
    const state = {
        found:  !!row,
        status: row ? row.status : null,
        role:   row ? row.role : null,
        expiresAt: now + USER_CHECK_TTL_MS,
    }
    userCheckCache.set(key, state)
    return state
}

/**
 * Drop the cached auth state for a user so a deactivation / role change takes
 * effect immediately instead of after the 60s TTL. Safe to call with a number
 * or string id. Exported for callers like the admin user controller.
 */
function invalidateUserAuthCache(userId) {
    userCheckCache.delete(Number(userId))
}

// This middleware protects routes that require login
const protect = async (req, res, next) => {
    try {
        // Get token from request header
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Not authorized. No token provided.' })
        }

        // Extract the token
        const token = authHeader.split(' ')[1]

        // Verify the token
        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        // Revocation check: confirm the account is still active and its role
        // still matches the token (cached for 60s to limit DB load).
        let state
        try {
            state = await getUserAuthState(decoded.id)
        } catch (dbErr) {
            // A transient DB error must not lock every authenticated user out —
            // the downstream controller will surface a real outage as a 500.
            console.error('Auth status check failed:', dbErr.message)
            req.user = decoded
            return next()
        }

        if (!state.found || state.status !== 'active') {
            return res.status(401).json({ error: 'Account has been deactivated' })
        }
        if (state.role !== decoded.role) {
            return res.status(401).json({ error: 'Session expired. Please log in again.' })
        }

        // Attach user info to the request
        req.user = decoded

        next()
    } catch (err) {
        return res.status(401).json({ error: 'Not authorized. Invalid token.' })
    }
}

// Role-based access control
// Usage: restrict('admin') or restrict('admin', 'clinician')
const restrict = (...roles) => {
    return (req, res, next) => {
        if (!req.user?.role) {
            return res.status(401).json({ error: 'Not authorized.' })
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: `Access denied. This route is for: ${roles.join(', ')} only.`,
            })
        }
        next()
    }
}

module.exports = { protect, restrict, invalidateUserAuthCache }
