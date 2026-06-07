const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const { isDisallowedPassword, DISALLOWED_MSG } = require('../utils/passwordPolicy')
const { isSuperAdmin, ASSIGNABLE_ROLES, ELEVATED_CREATABLE_ROLES } = require('../utils/roles')
const { assertAdminMayUseStaffRole } = require('../utils/adminPortalAccess')
const { auditLog } = require('../utils/auditLogger')
const { ensureUserProfileSchema } = require('../utils/ensureUserProfileSchema')

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

// ─── GENERATE JWT TOKEN ───────────────────────────────────────────────────────

const generateToken = (user) => {
    return jwt.sign(
        {
            id:        user.id,
            name:      user.name,
            email:     user.email,
            role:      user.role,
            specialty: user.specialty,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

const login = async (req, res) => {
    try {
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

        // Single generic message for every credential/role/status failure.
        // Distinct messages let an attacker enumerate accounts and roles.
        const INVALID = { error: 'Invalid email or password.' }

        if (!user) {
            void auditLog({ name: 'Sign-in', role: 'anonymous' }, 'LOGIN_FAILED', 'auth', null, 'Authentication failed', { req, status: 'failed', action_category: 'authentication', metadata: { stage: 'lookup' } }).catch(() => {})
            return res.status(401).json(INVALID)
        }
        if (user.status !== 'active') {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, status: 'failed', action_category: 'authentication', metadata: { stage: 'inactive' } }).catch(() => {})
            return res.status(401).json(INVALID)
        }
        if (role && user.role !== role) {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, status: 'failed', action_category: 'authentication', metadata: { stage: 'role_mismatch' } }).catch(() => {})
            return res.status(401).json(INVALID)
        }

        const passwordMatch = await bcrypt.compare(password, user.password)

        if (!passwordMatch) {
            void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_FAILED', 'auth', String(user.id), 'Authentication failed', { req, status: 'failed', action_category: 'authentication', metadata: { stage: 'password' } }).catch(() => {})
            return res.status(401).json(INVALID)
        }

        const token = generateToken(user)

        void auditLog({ id: user.id, name: user.name, role: user.role }, 'LOGIN_SUCCESS', 'auth', String(user.id), 'Signed in successfully', { req, status: 'success', action_category: 'authentication' }).catch(() => {})

        // Return user info and token
        res.status(200).json({
            message: 'Login successful',
            token,
            user: {
                id:        user.id,
                name:      user.name,
                email:     user.email,
                role:      user.role,
                specialty: user.specialty,
                phone:     user.phone,
                npi:       user.npi,
                license:   user.license,
                status:    user.status,
                avatar_data_url: user.avatar_data_url || null,
                personal_info: user.personal_info || null,
                admin_modules: user.admin_modules ?? null,
            },
        })
    } catch (err) {
        console.error('Login error:', err.message)
        res.status(500).json({ error: 'Server error during login.' })
    }
}

// ─── REGISTER (Admin only) ────────────────────────────────────────────────────

const register = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { name, email, password, role, specialty, phone, npi, license } = req.body

        // Validate required fields
        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: 'Name, email, password and role are required.' })
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

        // Validate password length
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' })
        }

        if (isDisallowedPassword(password)) {
            return res.status(400).json({ error: DISALLOWED_MSG })
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
        const hashedPassword = await bcrypt.hash(password, 10)

        // Insert new user
        const result = await pool.query(
            `INSERT INTO users (name, email, password, role, specialty, phone, npi, license, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
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
            ]
        )

        void auditLog(req.user, 'USER_REGISTERED', 'user', String(result.rows[0].id), `Registered ${role}: ${name.trim()}`, { req, module_key: roleToStaffModule(role), action_category: 'create', status: 'success', metadata: { created_role: role } }).catch(() => {})

        res.status(201).json({
            message: `${role} registered successfully.`,
            user: result.rows[0],
        })
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'users_one_super_admin') {
            return res.status(409).json({ error: 'Only one Super Admin account is allowed in the system.' })
        }
        console.error('Register error:', err.message)
        res.status(500).json({ error: 'Server error during registration.' })
    }
}

// ─── GET CURRENT USER (from token) ───────────────────────────────────────────

const getMe = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const result = await pool.query(
            'SELECT id, name, email, role, specialty, phone, npi, license, status, avatar_data_url, personal_info, admin_modules, created_at FROM users WHERE id = $1',
            [req.user.id]
        )

        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found.' })
        }

        res.status(200).json({ user: result.rows[0] })
    } catch (err) {
        console.error('Get me error:', err.message)
        res.status(500).json({ error: 'Server error.' })
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
             RETURNING id, name, email, role, specialty, phone, npi, license, status, avatar_data_url, personal_info, admin_modules, created_at`,
            [cleanName, cleanEmail, cleanPhone || null, cleanAvatar || null, cleanInfo || null, req.user.id]
        )
        if (!result.rows[0]) {
            return res.status(404).json({ error: 'User not found.' })
        }
        res.status(200).json({ message: 'Profile updated successfully.', user: result.rows[0] })
    } catch (err) {
        console.error('Update profile error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required.' })
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters.' })
        }

        if (isDisallowedPassword(newPassword)) {
            return res.status(400).json({ error: DISALLOWED_MSG })
        }

        // Get user from database
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])
        const user = result.rows[0]
        if (!user) {
            return res.status(401).json({ error: 'Session invalid. Please sign in again.' })
        }

        // Verify current password
        const match = await bcrypt.compare(currentPassword, user.password)
        if (!match) {
            void auditLog(req.user, 'SELF_PASSWORD_CHANGE_FAILED', 'user', String(req.user.id), 'Current password incorrect', { req, status: 'failed', action_category: 'authorization' }).catch(() => {})
            return res.status(401).json({ error: 'Current password is incorrect.' })
        }

        const hashed = await bcrypt.hash(newPassword, 10)

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id])

        void auditLog(req.user, 'SELF_PASSWORD_CHANGED', 'user', String(req.user.id), 'User changed their own password', { req, status: 'success', action_category: 'authorization', metadata: { self: true } }).catch(() => {})

        res.status(200).json({ message: 'Password changed successfully.' })
    } catch (err) {
        console.error('Change password error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

const logout = async (req, res) => {
    try {
        void auditLog(req.user, 'LOGOUT', 'auth', String(req.user.id), 'User signed out', { req, status: 'success', action_category: 'authentication' }).catch(() => {})
        res.status(204).send()
    } catch (err) {
        console.error('Logout error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

module.exports = { login, register, getMe, updateMe, changePassword, logout }