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

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null
    return authHeader.split(' ')[1]
}

/**
 * Verify JWT and return decoded payload
 */
function verifyJwtToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET)
}

/**
 * Validate user auth state against token claims
 */
function validateUserAuthState(state, decoded) {
    if (!state.found || state.status !== 'active') {
        return { ok: false, status: 401, error: 'Account has been deactivated' }
    }
    if (state.role !== decoded.role) {
        return { ok: false, status: 401, error: 'Session expired. Please log in again.' }
    }
    return { ok: true }
}

/**
 * Check forced password change scope
 */
function checkPasswordChangeRequired(user, reqPath) {
    if (user.require_password_change === true && !reqPath.includes('/change-password')) {
        return {
            ok: false,
            status: 403,
            error: 'Password change required before accessing other features',
            code: 'FORCE_PASSWORD_CHANGE',
        }
    }
    return { ok: true }
}

/**
 * Check PHI training acknowledgment scope
 */
function checkPhiTrainingRequired(user) {
    if (user.requirePhiTraining === true) {
        return {
            ok: false,
            status: 403,
            error: 'PHI training acknowledgment required before accessing other features',
            code: 'PHI_TRAINING_REQUIRED',
        }
    }
    return { ok: true }
}

/**
 * Send auth failure response
 */
function sendAuthFailure(res, result) {
    const body = { error: result.error }
    if (result.code) body.code = result.code
    return res.status(result.status).json(body)
}

// This middleware protects routes that require login
const protect = async (req, res, next) => {
    try {
        const token = extractBearerToken(req.headers.authorization)
        if (!token) {
            return res.status(401).json({ error: 'Not authorized. No token provided.' })
        }

        const decoded = verifyJwtToken(token)

        let state
        try {
            state = await getUserAuthState(decoded.id)
        } catch (dbErr) {
            console.error('Auth status check failed:', dbErr.message)
            return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' })
        }

        const authCheck = validateUserAuthState(state, decoded)
        if (!authCheck.ok) return sendAuthFailure(res, authCheck)

        req.user = decoded

        const pwCheck = checkPasswordChangeRequired(req.user, req.path)
        if (!pwCheck.ok) return sendAuthFailure(res, pwCheck)

        const phiCheck = checkPhiTrainingRequired(req.user)
        if (!phiCheck.ok) return sendAuthFailure(res, phiCheck)

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
