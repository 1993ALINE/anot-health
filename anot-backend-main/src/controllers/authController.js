const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { getBcryptRounds } = require('../utils/bcryptCost')
const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const { validatePassword, generateSecurePassword } = require('../utils/passwordPolicy')
const { isSuperAdmin, ASSIGNABLE_ROLES, ELEVATED_CREATABLE_ROLES } = require('../utils/roles')
const { assertAdminMayUseStaffRole } = require('../utils/adminPortalAccess')
const { auditLog, reportAuditFailure } = require('../utils/auditLogger')
const cloudWatchAudit = require('../utils/logger')
const { ensureUserProfileSchema } = require('../utils/ensureUserProfileSchema')
const { sendHttpError } = require('../utils/errorMessages')
const { incrementTokenVersion } = require('../utils/tokenVersion')
const { loginRequiresMfa, issueAndSendCode, verifyMfaCode, maskDestination, isMfaFullyEnrolled, PHI_ROLES } = require('../services/mfaService')
const { setSessionCookie, clearSessionCookie } = require('../utils/sessionCookie')
const { isLocked, lockoutMessage, recordFailedLogin, resetFailedLogins } = require('../services/accountLockout')
const { invalidateUserAuthCache, extractBearerToken } = require('../middleware/auth')

const SESSION_INACTIVITY_MS = 15 * 60 * 1000 // 15 minutes of inactivity timeout

function roleToStaffModule(role) {
    const m = {
        admin: 'admins',
        clinician: 'clinicians',
        scribe: 'scribes',
        qps: 'qps',
        receptionist: 'receptionists',
    }
    return m[role] || 'admins'
}

// Current PHI awareness training revision. Bumping this re-prompts every user to
// re-acknowledge on their next login (see the login gate + acknowledge endpoint).
const PHI_TRAINING_VERSION = 1

// ─── GENERATE JWT TOKEN ───────────────────────────────────────────────────────

const generateToken = (user, extraClaims = {}) => {
    return jwt.sign(
        {
            id: user.id,
            userId: user.id,
            role: user.role,
            token_version: Number(user.token_version) || 0,
            session_id: user.active_session_id || extraClaims.session_id || null,
            ...extraClaims,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )
}

/** Short-lived token scoped to a single pre-session gate (password change, PHI training, MFA). */
const generateTemporaryToken = (user, claim, expiresIn = '1h') => {
    return jwt.sign(
        {
            id: user.id,
            userId: user.id,
            role: user.role,
            token_version: Number(user.token_version) || 0,
            [claim]: true,
        },
        process.env.JWT_SECRET,
        { expiresIn }
    )
}

/** Issue full session or the next mandatory gate after password verification. */
async function buildPostPasswordLoginResponse(user, req, res) {
    if (user.force_password_change) {
        clearSessionCookie(res)
        const temporaryToken = generateTemporaryToken(user, 'require_password_change')
        void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_PASSWORD_CHANGE_REQUIRED', 'auth', String(user.id), 'Login requires password change', { req, module_key: 'authentication', status: 'warning', action_category: 'authentication' }).catch(reportAuditFailure)
        cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')
        return {
            status: 200,
            body: {
                success: true,
                requirePasswordChange: true,
                force_password_change: true,
                temporaryToken,
                message: 'You must change your password before accessing the application',
            },
        }
    }

    if (needsPhiTraining(user)) {
        clearSessionCookie(res)
        const temporaryToken = generateTemporaryToken(user, 'requirePhiTraining')
        void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_PHI_TRAINING_REQUIRED', 'auth', String(user.id), 'Login requires PHI training acknowledgment', { req, module_key: 'authentication', status: 'warning', action_category: 'authorization' }).catch(reportAuditFailure)
        cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')
        return {
            status: 200,
            body: {
                success: true,
                requirePhiTraining: true,
                temporaryToken,
                message: 'You must acknowledge the PHI awareness training before accessing the application.',
            },
        }
    }

    const mfaStatus = loginRequiresMfa(user)
    console.log('[auth.buildPostPasswordLoginResponse] MFA gate', {
      MFA_DISABLED: process.env.MFA_DISABLED,
      mfaBypass: mfaStatus === false && PHI_ROLES.has(user.role),
      userId: user.id,
      role: user.role,
      mfa_enabled: user.mfa_enabled,
      mfa_method: user.mfa_method,
      mfaStatus,
    })

    if (mfaStatus === 'ENROLLMENT_REQUIRED') {
        clearSessionCookie(res)
        const temporaryToken = generateTemporaryToken(user, 'requireMfaEnrollment', '15m')
        void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_MFA_ENROLLMENT_REQUIRED', 'auth', String(user.id), 'Login requires MFA enrollment for PHI access', { req, module_key: 'authentication', status: 'warning', action_category: 'authentication' }).catch(reportAuditFailure)
        cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')
        return {
            status: 200,
            body: {
                success: true,
                userId: user.id,
                requireMfa: true,
                enrollmentRequired: true,
                temporaryToken,
                message: 'MFA setup required for PHI access',
            },
        }
    }

    if (mfaStatus === true) {
        clearSessionCookie(res)
        const temporaryToken = generateTemporaryToken(user, 'requireMfa', '10m')
        void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_MFA_REQUIRED', 'auth', String(user.id), 'Login requires MFA verification', { req, module_key: 'authentication', status: 'warning', action_category: 'authentication' }).catch(reportAuditFailure)
        cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')

        let mfaDelivery = { sent: false }
        try {
            mfaDelivery = await issueAndSendCode(pool, user, 'login')
        } catch (sendErr) {
            console.error('[auth.login] MFA code send failed:', sendErr.message)
        }

        const channel = user.mfa_method === 'sms' ? 'phone' : 'email'
        return {
            status: 200,
            body: {
                success: true,
                userId: user.id,
                requireMfa: true,
                mfaRequired: true,
                enrollmentRequired: false,
                temporaryToken,
                mfaMethod: user.mfa_method,
                mfaDestinationMasked: maskDestination(user.mfa_method, user.mfa_destination),
                codeSent: mfaDelivery.sent === true,
                message: mfaDelivery.sent
                    ? `Enter the 6-digit code sent to your ${channel}.`
                    : 'MFA is required but the verification code could not be sent. Use Resend code or contact your administrator.',
            },
        }
    }

    // ─── SINGLE CONCURRENT SESSION PER USER ──────────────────────────────
    const hasActiveSession = !!(
        user.active_session_id &&
        user.last_active_at &&
        (Date.now() - new Date(user.last_active_at).getTime() < SESSION_INACTIVITY_MS)
    )

    if (hasActiveSession && !req.body?.force) {
        void auditLog(
            { id: user.id, name: user.name, role: user.role },
            'LOGIN_CONCURRENT_BLOCKED',
            'auth',
            String(user.id),
            'Concurrent login attempt blocked — active session already exists for this user',
            { req, module_key: 'authentication', status: 'warning', action_category: 'authentication' }
        ).catch(reportAuditFailure)
        return {
            status: 409,
            body: {
                error: 'This account already has an active session on another device. Only one session is permitted per user.',
                code: 'CONCURRENT_SESSION_ACTIVE',
                canForce: true,
            },
        }
    }

    if (req.body?.force && hasActiveSession) {
        await incrementTokenVersion(user.id)
        user.token_version = (Number(user.token_version) || 0) + 1
        void auditLog(
            { id: user.id, name: user.name, role: user.role },
            'CONCURRENT_SESSION_TERMINATED',
            'auth',
            String(user.id),
            'Prior active session terminated by user force sign-in',
            { req, module_key: 'authentication', status: 'warning', action_category: 'authentication' }
        ).catch(reportAuditFailure)
    }

    const sessionId = crypto.randomUUID()
    await pool.query(
        'UPDATE users SET active_session_id = $1, last_active_at = NOW() WHERE id = $2',
        [sessionId, user.id]
    )
    user.active_session_id = sessionId
    invalidateUserAuthCache(user.id)

    const token = generateToken(user, { session_id: sessionId })
    setSessionCookie(res, token)
    void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_SUCCESS', 'auth', String(user.id), 'Signed in successfully', { req, module_key: 'authentication', status: 'success', action_category: 'authentication' }).catch(reportAuditFailure)
    cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')
    return {
        status: 200,
        body: {
            message: 'Login successful',
            user: toAuthUser(user),
            token,
        },
    }
}

/** Issue full session: HttpOnly cookie + user payload (with unique session_id). */
async function respondFullSession(res, user, extra = {}) {
    const sessionId = crypto.randomUUID()
    await pool.query(
        'UPDATE users SET active_session_id = $1, last_active_at = NOW() WHERE id = $2',
        [sessionId, user.id]
    )
    user.active_session_id = sessionId
    invalidateUserAuthCache(user.id)
    const token = generateToken(user, { session_id: sessionId })
    setSessionCookie(res, token)
    return res.status(200).json({
        message: extra.message || 'Login successful',
        user: toAuthUser(user),
        token,
        ...extra,
    })
}

// Shape of the user object returned to the client on a successful session start.
const toAuthUser = (user) => ({
    id:        user.id,
    name:      user.name,
    email:     user.email,
    role:      user.role,
    specialty: user.specialty,
    phone:     user.phone,
    npi:       user.npi,
    license:   user.license,
    status:    user.status,
    clinic_code: user.clinic_code || null,
    clinic_name: user.clinic_name || null,
    ui_mode:     user.ui_mode || 'standard',
    avatar_data_url: user.avatar_data_url || null,
    personal_info: user.personal_info || null,
    admin_modules: user.admin_modules ?? null,
})

/** True when the account must (re)acknowledge the current PHI training revision. */
const needsPhiTraining = (user) =>
    !user.phi_training_acknowledged || Number(user.phi_training_version) < PHI_TRAINING_VERSION

// ─── LOGIN ────────────────────────────────────────────────────────────────────

const login = async (req, res) => {
    try {
        console.log('[auth.login] MFA_DISABLED:', process.env.MFA_DISABLED, 'NODE_ENV:', process.env.NODE_ENV)
        await ensureUserProfileSchema()

        const { email, password, role } = req.body

        // Validate input (role optional — server uses the account's role from the database)
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' })
        }

        // Find user by email
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
        )

        const user = result.rows[0]

        const attemptedEmail = String(email).toLowerCase().trim()

        // Single generic message for every credential/role/status failure.
        // Distinct messages let an attacker enumerate accounts and roles.
        const INVALID = { error: 'Invalid email or password.' }

        if (!user) {
            void auditLog({ name: 'Sign-in', role: 'anonymous' }, 'LOGIN_FAILED', 'auth', null, 'Authentication failed', { req, module_key: 'authentication', status: 'failed', action_category: 'authentication', metadata: { stage: 'lookup' } }).catch(reportAuditFailure)
            cloudWatchAudit.logLogin(null, attemptedEmail, null, req.clientIp, 'failure')
            return res.status(401).json(INVALID)
        }
        if (user.status !== 'active') {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, module_key: 'authentication', status: 'failed', action_category: 'authentication', metadata: { stage: 'inactive' } }).catch(reportAuditFailure)
            cloudWatchAudit.logLogin(user.id, attemptedEmail, user.role, req.clientIp, 'failure')
            return res.status(401).json(INVALID)
        }
        if (role && user.role !== role) {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, module_key: 'authentication', status: 'failed', action_category: 'authentication', metadata: { stage: 'role_mismatch' } }).catch(reportAuditFailure)
            cloudWatchAudit.logLogin(user.id, attemptedEmail, user.role, req.clientIp, 'failure')
            await recordFailedLogin(user.id)
            return res.status(401).json(INVALID)
        }

        if (isLocked(user)) {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Account locked', { req, module_key: 'authentication', status: 'failed', action_category: 'authentication', metadata: { stage: 'locked' } }).catch(reportAuditFailure)
            return res.status(429).json({ error: lockoutMessage(user) })
        }

        const passwordMatch = await bcrypt.compare(password, user.password)

        if (!passwordMatch) {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, module_key: 'authentication', status: 'failed', action_category: 'authentication', metadata: { stage: 'password' } }).catch(reportAuditFailure)
            cloudWatchAudit.logLogin(user.id, attemptedEmail, user.role, req.clientIp, 'failure')
            const lockState = await recordFailedLogin(user.id)
            if (lockState?.locked_until && new Date(lockState.locked_until) > new Date()) {
                return res.status(429).json({ error: lockoutMessage({ locked_until: lockState.locked_until }) })
            }
            return res.status(401).json(INVALID)
        }

        await resetFailedLogins(user.id)

        // Pre-session gates: forced password change → PHI training → MFA → full session.
        const { status, body } = await buildPostPasswordLoginResponse(user, req, res)
        return res.status(status).json(body)
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.login', req })
    }
}

// ─── ACKNOWLEDGE PHI TRAINING ─────────────────────────────────────────────────
// Completes the PHI-training gate from login. The client presents the short-lived
// temporaryToken issued at login; on success we record the acknowledgment and
// hand back a normal 8h session token so the user can proceed to their dashboard.

const acknowledgePhiTraining = async (req, res) => {
    try {
        await ensureUserProfileSchema()

        const { temporaryToken } = req.body || {}
        if (!temporaryToken) {
            return res.status(400).json({ error: 'Missing training token. Please sign in again.' })
        }

        let decoded
        try {
            decoded = jwt.verify(temporaryToken, process.env.JWT_SECRET)
        } catch (_) {
            return res.status(401).json({ error: 'Your session expired. Please sign in again.' })
        }

        // A forced password rotation must happen BEFORE PHI training can be
        // acknowledged — otherwise the short-lived require_password_change token
        // could be exchanged here for a full session, skipping the mandatory
        // password change entirely.
        if (decoded.require_password_change === true) {
            return res.status(403).json({
                error: 'You must change your password before acknowledging PHI training.',
                code: 'FORCE_PASSWORD_CHANGE',
            })
        }

        // Only the short-lived PHI-training token issued at login may complete
        // this step.
        if (decoded.requirePhiTraining !== true) {
            return res.status(403).json({ error: 'This token cannot be used to acknowledge training.' })
        }

        const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id])
        const user = result.rows[0]
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: 'Account is unavailable. Please contact your administrator.' })
        }

        const updated = await pool.query(
            `UPDATE users
             SET phi_training_acknowledged = true,
                 phi_training_acknowledged_at = NOW(),
                 phi_training_version = $1
             WHERE id = $2
             RETURNING *`,
            [PHI_TRAINING_VERSION, user.id]
        )
        const fresh = updated.rows[0]

        void auditLog(
            { id: fresh.id, name: fresh.name, role: fresh.role },
            'PHI_TRAINING_ACKNOWLEDGED',
            'user',
            String(fresh.id),
            'User acknowledged PHI awareness training',
            { req, module_key: 'authentication', status: 'success', action_category: 'authorization', metadata: { phi_training_version: PHI_TRAINING_VERSION } }
        ).catch(reportAuditFailure)

        const mfaStatus = loginRequiresMfa(fresh)
        console.log('[auth.phiTraining] MFA gate', {
            MFA_DISABLED: process.env.MFA_DISABLED,
            mfaBypass: mfaStatus === false && PHI_ROLES.has(fresh.role),
            userId: fresh.id,
            role: fresh.role,
            mfa_enabled: fresh.mfa_enabled,
            mfa_method: fresh.mfa_method,
            mfaStatus,
        })

        if (mfaStatus === 'ENROLLMENT_REQUIRED') {
            const temporaryToken = generateTemporaryToken(fresh, 'requireMfaEnrollment', '15m')
            return res.status(200).json({
                message: 'PHI training acknowledged.',
                userId: fresh.id,
                requireMfa: true,
                enrollmentRequired: true,
                temporaryToken,
            })
        }

        if (mfaStatus === true) {
            const temporaryToken = generateTemporaryToken(fresh, 'requireMfa', '10m')
            let mfaDelivery = { sent: false }
            try {
                mfaDelivery = await issueAndSendCode(pool, fresh, 'login')
            } catch (sendErr) {
                console.error('[auth.phiTraining] MFA code send failed:', sendErr.message)
            }
            const channel = fresh.mfa_method === 'sms' ? 'phone' : 'email'
            return res.status(200).json({
                message: 'PHI training acknowledged.',
                userId: fresh.id,
                requireMfa: true,
                mfaRequired: true,
                enrollmentRequired: false,
                temporaryToken,
                mfaMethod: fresh.mfa_method,
                mfaDestinationMasked: maskDestination(fresh.mfa_method, fresh.mfa_destination),
                codeSent: mfaDelivery.sent === true,
                infoMessage: mfaDelivery.sent
                    ? `Enter the 6-digit code sent to your ${channel}.`
                    : 'MFA is required but the verification code could not be sent. Use Resend code or contact your administrator.',
            })
        }

        const token = generateToken(fresh)
        setSessionCookie(res, token)

        res.status(200).json({
            message: 'PHI training acknowledged.',
            user: toAuthUser(fresh),
        })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.phiTraining', req })
    }
}

// ─── REGISTER (Admin only) ────────────────────────────────────────────────────

const register = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { name, email, role, specialty, phone, npi, license } = req.body
        let { password } = req.body

        // Validate required fields (password is optional — generated if omitted)
        if (!name || !email || !role) {
            return res.status(400).json({ error: 'Name, email, and role are required.' })
        }

        // When the admin does not supply a password, generate a secure temporary
        // one and force the user to rotate it on first login. It is returned ONCE
        // in the response so the admin can hand it over via a secure channel.
        let temporaryPassword = null
        if (!password) {
            password = generateSecurePassword()
            temporaryPassword = password
        }

        if (role === 'super_admin') {
            return res.status(403).json({ error: 'The Super Admin role cannot be created through the system.' })
        }

        const allRegister = [...ASSIGNABLE_ROLES, ...ELEVATED_CREATABLE_ROLES]
        if (!allRegister.includes(role)) {
            return res.status(400).json({ error: 'Invalid role.' })
        }
        if (ELEVATED_CREATABLE_ROLES.includes(role) && !isSuperAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Only a Super Admin may create Admin accounts.' })
        }

        try {
            assertAdminMayUseStaffRole(req, role)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        // Enforce HIPAA password complexity policy
        const pwCheck = validatePassword(password)
        if (!pwCheck.valid) {
            return res.status(400).json({ error: pwCheck.message })
        }

        // Check if email already exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
        )
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'A user with this email already exists.' })
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, getBcryptRounds())

        // Insert new user. A generated temp password forces a rotation on first
        // login; an admin-chosen password does not.
        const result = await pool.query(
            `INSERT INTO users (name, email, password, role, specialty, phone, npi, license, status, force_password_change, phi_training_acknowledged, phi_training_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, false, $10)
                 RETURNING id, name, email, role, specialty, phone, status, avatar_data_url, personal_info, admin_modules, created_at`,
            [
                name.trim(),
                email.toLowerCase().trim(),
                hashedPassword,
                role,
                specialty || null,
                phone || null,
                npi || null,
                license || null,
                !!temporaryPassword,
                PHI_TRAINING_VERSION,
            ]
        )

        void auditLog(req.user, 'USER_REGISTERED', 'user', String(result.rows[0].id), `Registered ${role}: ${name.trim()}`, { req, module_key: roleToStaffModule(role), action_category: 'create', status: 'success', metadata: { created_role: role, generated_password: !!temporaryPassword } }).catch(reportAuditFailure)

        res.status(201).json({
            message: `${role} registered successfully.`,
            user: result.rows[0],
            // Returned only when the server generated the credential, so the admin
            // can relay it once. Never the bcrypt hash.
            temporaryPassword: temporaryPassword || null,
        })
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'users_one_super_admin') {
            return res.status(409).json({ error: 'Only one Super Admin account is allowed in the system.' })
        }
        sendHttpError(res, 500, err, { context: 'auth.register', req })
    }
}

// ─── GET CURRENT USER (from token) ───────────────────────────────────────────

const getMe = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const result = await pool.query(
            'SELECT id, name, email, role, specialty, phone, npi, license, status, clinic_code, clinic_name, ui_mode, avatar_data_url, personal_info, admin_modules, created_at FROM users WHERE id = $1',
            [req.user.id]
        )

        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found.' })
        }

        res.status(200).json({ user: result.rows[0] })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.getMe', req })
    }
}

// ─── UPDATE CURRENT USER PROFILE ──────────────────────────────────────────────
const updateMe = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { name, email, phone, avatar_data_url, personal_info } = req.body
        const cleanName = String(name || '').trim()
        const cleanEmail = String(email || '').toLowerCase().trim()
        const cleanPhone = String(phone || '').trim()
        const cleanInfo = String(personal_info || '').trim().slice(0, 2000)
        const cleanAvatar = String(avatar_data_url || '').trim()

        if (!cleanName || !cleanEmail) {
            return res.status(400).json({ error: 'Name and email are required.' })
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({ error: 'Enter a valid email address.' })
        }
        if (cleanAvatar && !/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/i.test(cleanAvatar)) {
            return res.status(400).json({ error: 'Invalid avatar image format.' })
        }
        if (cleanAvatar.length > 1_700_000) {
            return res.status(400).json({ error: 'Avatar image is too large.' })
        }

        const dup = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [cleanEmail, req.user.id])
        if (dup.rows.length > 0) {
            return res.status(409).json({ error: 'This email is already used by another account.' })
        }

        const result = await pool.query(
            `UPDATE users
             SET name = $1,
                 email = $2,
                 phone = $3,
                 avatar_data_url = $4,
                 personal_info = $5
             WHERE id = $6
             RETURNING id, name, email, role, specialty, phone, npi, license, status, clinic_code, clinic_name, ui_mode, avatar_data_url, personal_info, admin_modules, created_at`,
            [cleanName, cleanEmail, cleanPhone || null, cleanAvatar || null, cleanInfo || null, req.user.id]
        )
        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found.' })
        }
        res.status(200).json({ message: 'Profile updated successfully.', user: result.rows[0] })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.updateMe', req })
    }
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

const changePassword = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { currentPassword, newPassword, temporaryToken: bodyTemporaryToken } = req.body || {}

        // A forced first-login change is authorized by the short-lived token
        // issued at login (require_password_change claim), so the current
        // password is not required in that flow.
        let isTemporaryPasswordChange = req.user?.require_password_change === true
        let targetUserId = req.user?.id

        // Accept temporaryToken from body or Authorization Bearer header.
        // When the token is expired we still decode it (without verification)
        // so we can extract the userId and fall through to the DB
        // force_password_change check at line 663.
        const rawToken = bodyTemporaryToken || extractBearerToken(req.headers?.authorization)
        if (rawToken) {
            try {
                const decodedTemp = jwt.verify(rawToken, process.env.JWT_SECRET)
                if (decodedTemp && decodedTemp.require_password_change === true) {
                    isTemporaryPasswordChange = true
                    targetUserId = decodedTemp.id || decodedTemp.userId
                }
            } catch (verifyErr) {
                // If the token is merely expired (not forged), decode the payload
                // so we can still resolve the userId and honour the DB flag.
                if (verifyErr?.name === 'TokenExpiredError') {
                    try {
                        const decodedExpired = jwt.decode(rawToken)
                        if (decodedExpired && decodedExpired.require_password_change === true) {
                            const expiredId = decodedExpired.id || decodedExpired.userId
                            if (expiredId && !targetUserId) {
                                targetUserId = expiredId
                            }
                        }
                    } catch (_) {}
                }
            }
        }

        if (!targetUserId) {
            return res.status(401).json({ error: 'Session invalid. Please sign in again.' })
        }

        // Get user from database
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId])
        const user = result.rows[0]
        if (!user) {
            return res.status(401).json({ error: 'Session invalid. Please sign in again.' })
        }

        // If the account has force_password_change = true in DB, current password is not required
        if (user.force_password_change === true) {
            isTemporaryPasswordChange = true
        }

        if (!newPassword || (!isTemporaryPasswordChange && !currentPassword)) {
            return res.status(400).json({ error: 'Current and new password are required.' })
        }

        const pwCheck = validatePassword(newPassword)
        if (!pwCheck.valid) {
            return res.status(400).json({ error: pwCheck.message })
        }

        // Verify current password (skipped only for the forced temp-password flow)
        if (!isTemporaryPasswordChange) {
            const match = await bcrypt.compare(currentPassword, user.password)
            if (!match) {
                void auditLog(req.user, 'SELF_PASSWORD_CHANGE_FAILED', 'user', String(targetUserId), 'Current password incorrect', { req, module_key: 'authentication', status: 'failed', action_category: 'authorization' }).catch(reportAuditFailure)
                return res.status(401).json({ error: 'Current password is incorrect.' })
            }
        }

        const hashed = await bcrypt.hash(newPassword, getBcryptRounds())

        // Always clear the forced-change flag once a new password is set.
        await pool.query('UPDATE users SET password = $1, force_password_change = false WHERE id = $2', [hashed, targetUserId])

        await incrementTokenVersion(targetUserId)
        invalidateUserAuthCache(targetUserId)
        clearSessionCookie(res)

        void auditLog(req.user || { id: targetUserId, name: user.name, role: user.role }, 'SELF_PASSWORD_CHANGED', 'user', String(targetUserId), 'User changed their own password', { req, module_key: 'authentication', status: 'success', action_category: 'authorization', metadata: { self: true, forced: isTemporaryPasswordChange } }).catch(reportAuditFailure)

        res.status(200).json({ message: 'Password changed successfully.' })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.changePassword', req })
    }
}

const { clearCsrfCookie } = require('../middleware/csrf')

const logout = async (req, res) => {
    try {
        await pool.query('UPDATE users SET active_session_id = NULL, last_active_at = NULL WHERE id = $1', [req.user.id]).catch(() => {})
        await incrementTokenVersion(req.user.id)
        invalidateUserAuthCache(req.user.id)
        void auditLog(req.user, 'LOGOUT', 'auth', String(req.user.id), 'User signed out', { req, module_key: 'authentication', status: 'success', action_category: 'authentication' }).catch(reportAuditFailure)
        const emailRow = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id])
        cloudWatchAudit.logLogout(req.user.id, emailRow.rows[0]?.email || null, req.clientIp)
        clearCsrfCookie(res)
        clearSessionCookie(res)
        res.status(204).send()
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.logout', req })
    }
}

// ─── VERIFY MFA AT LOGIN ──────────────────────────────────────────────────────
// Exchanges the short-lived requireMfa temporaryToken (issued after password
// verification) for a full session JWT after the one-time code succeeds.

const verifyMfaLogin = async (req, res) => {
    try {
        await ensureUserProfileSchema()

        const { temporaryToken, token, code, recoveryCode } = req.body || {}
        const submittedCode = code || token
        if (!temporaryToken || !submittedCode) {
            return res.status(400).json({ error: 'MFA token and verification code are required.' })
        }
        if (recoveryCode) {
            return res.status(400).json({ error: 'Recovery codes are no longer supported. Use your email or SMS code.' })
        }

        let decoded
        try {
            decoded = jwt.verify(temporaryToken, process.env.JWT_SECRET)
        } catch (_) {
            return res.status(401).json({ error: 'Your session expired. Please sign in again.' })
        }

        if (decoded.requireMfa !== true) {
            return res.status(403).json({ error: 'This token cannot be used for MFA verification.' })
        }

        const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id])
        const user = result.rows[0]
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: 'Account is unavailable. Please contact your administrator.' })
        }
        if (!isMfaFullyEnrolled(user)) {
            return res.status(403).json({ error: 'MFA is not enabled for this account.' })
        }

        const verifyResult = await verifyMfaCode(pool, user.id, 'login', submittedCode)
        if (!verifyResult.ok) {
            void auditLog(
                { id: user.id, name: user.name, role: user.role },
                'MFA_LOGIN_FAILED',
                'auth',
                String(user.id),
                'Invalid MFA code at login',
                { req, module_key: 'authentication', status: 'failed', action_category: 'authentication' }
            ).catch(reportAuditFailure)
            const status = verifyResult.locked ? 429 : 401
            return res.status(status).json({ error: verifyResult.error })
        }

        void auditLog(
            { id: user.id, name: user.name, role: user.role },
            'MFA_LOGIN_SUCCESS',
            'auth',
            String(user.id),
            'MFA verified at login',
            { req, module_key: 'authentication', status: 'success', action_category: 'authentication' }
        ).catch(reportAuditFailure)

        const sessionToken = generateToken(user)
        setSessionCookie(res, sessionToken)
        cloudWatchAudit.logLogin(user.id, user.email, user.role, req.clientIp, 'success')

        res.status(200).json({
            message: 'MFA verified. Login successful.',
            user: toAuthUser(user),
        })
    } catch (err) {
        sendHttpError(res, 500, err, { context: 'auth.verifyMfa', req })
    }
}

module.exports = { login, register, getMe, updateMe, changePassword, logout, acknowledgePhiTraining, verifyMfaLogin }