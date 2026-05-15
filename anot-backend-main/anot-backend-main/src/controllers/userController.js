const pool = require('../config/db')
const bcrypt = require('bcryptjs')
const { isDisallowedPassword, DISALLOWED_MSG } = require('../utils/passwordPolicy')
const { auditLog } = require('../utils/auditLogger')
const {
    isSuperAdmin,
    isElevatedAccount,
    actorMayManageUser,
    GRANTABLE_ADMIN_MODULE_SET,
} = require('../utils/roles')
const {
    assertAdminHasAnyPortalModule,
    assertAdminCanAccessStaffUser,
    assertAdminMayUseStaffRole,
} = require('../utils/adminPortalAccess')
const { ensureUserProfileSchema } = require('../utils/ensureUserProfileSchema')
const { userSelectList, hasRatePerNoteColumn } = require('../utils/userColumns')

const VALID_ROLES = ['clinician', 'scribe', 'qps', 'admin', 'super_admin']

function normalizeAdminModulesPayload(raw) {
    if (raw === undefined) return undefined
    if (raw === null) return null
    if (!Array.isArray(raw)) return { error: 'admin_modules must be an array or null.' }
    for (const k of raw) {
        if (typeof k !== 'string' || !GRANTABLE_ADMIN_MODULE_SET.has(k)) {
            return { error: `Invalid module key: ${k}` }
        }
    }
    return raw
}

async function loadUserRow(id) {
    await ensureUserProfileSchema()
    const cols = await userSelectList()
    const r = await pool.query(`SELECT ${cols} FROM users WHERE id = $1`, [id])
    return r.rows[0] || null
}

// ─── GET ALL USERS ────────────────────────────────────────────────────────────

const getAllUsers = async (req, res) => {
    try {
        try {
            assertAdminHasAnyPortalModule(req, ['overview', 'clinicians', 'scribes', 'qps', 'assignments', 'admins'])
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }
        await ensureUserProfileSchema()
        const cols = await userSelectList()
        let sql = `SELECT ${cols} FROM users`
        const params = []
        if (req.user.role === 'admin' && !isSuperAdmin(req.user.role)) {
            const hasAdminsModule = req.adminModuleKeys && req.adminModuleKeys.has('admins')
            if (hasAdminsModule) {
                sql += ` WHERE role != 'super_admin'`
            } else {
                sql += ` WHERE role NOT IN ('admin','super_admin') OR id = $1`
                params.push(req.user.id)
            }
        }
        sql += ' ORDER BY created_at DESC'
        const result = await pool.query(sql, params)
        res.status(200).json({ users: result.rows })
    } catch (err) {
        console.error('Get all users error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── GET SINGLE USER ──────────────────────────────────────────────────────────

const getUser = async (req, res) => {
    try {
        const { id } = req.params
        const target = await loadUserRow(id)
        if (!target) return res.status(404).json({ error: 'User not found.' })
        if (String(req.user.id) !== String(id) && !actorMayManageUser(req.user.role, target, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to view this user.' })
        }
        try {
            assertAdminCanAccessStaffUser(req, target)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }
        res.status(200).json({ user: target })
    } catch (err) {
        console.error('Get user error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── UPDATE USER ──────────────────────────────────────────────────────────────

const updateUser = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { id } = req.params
        const { name, email, role, specialty, phone, npi, license, rate_per_note, admin_modules } = req.body

        if (!name || !email || !role) {
            return res.status(400).json({ error: 'Name, email and role are required.' })
        }

        if (!VALID_ROLES.includes(role)) {
            return res.status(400).json({ error: 'Invalid role.' })
        }

        const existing = await loadUserRow(id)
        if (!existing) return res.status(404).json({ error: 'User not found.' })

        if (!actorMayManageUser(req.user.role, existing, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to modify this user.' })
        }

        try {
            assertAdminCanAccessStaffUser(req, existing)
            if (existing.role !== role) {
                assertAdminMayUseStaffRole(req, role)
            }
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        // Only the Super Admin user may change their own row via PUT /users/:id (profile fields).
        if (existing.role === 'super_admin' && String(req.user.id) !== String(id)) {
            return res.status(403).json({ error: 'The Super Admin account can only be updated by that account.' })
        }

        if (role === 'super_admin' && existing.role !== 'super_admin') {
            return res.status(403).json({ error: 'The Super Admin role cannot be assigned through the system.' })
        }

        if (existing.role === 'super_admin' && role !== 'super_admin') {
            return res.status(403).json({ error: 'The system Super Admin role cannot be changed.' })
        }

        if (!isSuperAdmin(req.user.role) && isElevatedAccount(role) && existing.role !== role) {
            return res.status(403).json({ error: 'You cannot assign elevated roles.' })
        }

        let adminModulesPayload = undefined
        if (admin_modules !== undefined) {
            if (!isSuperAdmin(req.user.role)) {
                return res.status(403).json({ error: 'Only a Super Admin can change module permissions.' })
            }
            if (role !== 'admin') {
                return res.status(400).json({ error: 'admin_modules applies only to Admin accounts.' })
            }
            const norm = normalizeAdminModulesPayload(admin_modules)
            if (norm && norm.error) return res.status(400).json({ error: norm.error })
            adminModulesPayload = norm
        }

        const hasRate = await hasRatePerNoteColumn()
        let ratePayload = null
        if (hasRate && rate_per_note != null && rate_per_note !== '') {
            const parsed = parseFloat(rate_per_note)
            if (!Number.isFinite(parsed) || parsed < 0) {
                return res.status(400).json({ error: 'Invalid rate_per_note.' })
            }
            ratePayload = parsed
        }

        const returning = await userSelectList()
        let sql
        let params
        if (adminModulesPayload !== undefined) {
            const rateSet = hasRate ? ', rate_per_note = COALESCE($8, rate_per_note)' : ''
            const modIdx = hasRate ? 9 : 8
            const idIdx = hasRate ? 10 : 9
            sql = `UPDATE users
             SET name          = $1,
                 email         = $2,
                 role          = $3,
                 specialty     = $4,
                 phone         = $5,
                 npi           = $6,
                 license       = $7${rateSet},
                 admin_modules = $${modIdx}::jsonb
             WHERE id = $${idIdx}
                 RETURNING ${returning}`
            params = [
                name,
                email.toLowerCase().trim(),
                role,
                specialty || null,
                phone || null,
                npi || null,
                license || null,
            ]
            if (hasRate) params.push(ratePayload)
            params.push(adminModulesPayload === null ? null : JSON.stringify(adminModulesPayload), id)
        } else {
            const rateSet = hasRate ? ', rate_per_note = COALESCE($8, rate_per_note)' : ''
            const idIdx = hasRate ? 9 : 8
            sql = `UPDATE users
             SET name          = $1,
                 email         = $2,
                 role          = $3,
                 specialty     = $4,
                 phone         = $5,
                 npi           = $6,
                 license       = $7${rateSet}
             WHERE id = $${idIdx}
                 RETURNING ${returning}`
            params = [
                name,
                email.toLowerCase().trim(),
                role,
                specialty || null,
                phone || null,
                npi || null,
                license || null,
            ]
            if (hasRate) params.push(ratePayload)
            params.push(id)
        }

        const result = await pool.query(sql, params)

        if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' })

        if (role !== 'admin') {
            await pool.query('UPDATE users SET admin_modules = NULL WHERE id = $1', [id])
            result.rows[0].admin_modules = null
        }

        const auditWrites = [
            auditLog(req.user, 'USER_UPDATED', 'user', id,
                `Updated: ${name} (${email}) — role: ${role}`,
                { req, module_key: 'admins', action_category: 'update', status: 'success' }),
        ]
        if (adminModulesPayload !== undefined) {
            auditWrites.push(
                auditLog(req.user, 'ADMIN_MODULES_UPDATED', 'user', id,
                    `Admin portal modules updated for ${name}`,
                    { req, module_key: 'admins', action_category: 'authorization', status: 'warning',
                        metadata: { modules: adminModulesPayload === null ? null : adminModulesPayload } }),
            )
        }
        await Promise.all(auditWrites)

        res.status(200).json({
            message: 'User updated successfully.',
            user: result.rows[0],
        })
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'users_one_super_admin') {
            return res.status(409).json({ error: 'Only one Super Admin account is allowed in the system.' })
        }
        console.error('Update user error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── PATCH ADMIN MODULES ONLY (fast path; Super Admin) ─────────────────────────

const patchAdminModules = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        if (!isSuperAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Only a Super Admin can change module permissions.' })
        }
        const { id } = req.params
        const { admin_modules } = req.body
        if (admin_modules === undefined) {
            return res.status(400).json({ error: 'admin_modules is required.' })
        }

        const existing = await loadUserRow(id)
        if (!existing) return res.status(404).json({ error: 'User not found.' })
        if (existing.role !== 'admin') {
            return res.status(400).json({ error: 'admin_modules applies only to Admin accounts.' })
        }

        try {
            assertAdminCanAccessStaffUser(req, existing)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        const norm = normalizeAdminModulesPayload(admin_modules)
        if (norm && norm.error) return res.status(400).json({ error: norm.error })

        const jsonVal = norm === null ? null : JSON.stringify(norm)
        const returning = await userSelectList()
        const result = await pool.query(
            `UPDATE users SET admin_modules = $1::jsonb
             WHERE id = $2
             RETURNING ${returning}`,
            [jsonVal, id],
        )
        if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' })

        await auditLog(req.user, 'ADMIN_MODULES_UPDATED', 'user', id,
            `Admin portal modules updated for ${existing.name}`,
            { req, module_key: 'admins', action_category: 'authorization', status: 'warning',
                metadata: { modules: norm } })

        res.status(200).json({ message: 'Module permissions updated.', user: result.rows[0] })
    } catch (err) {
        console.error('Patch admin modules error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── TOGGLE USER STATUS ───────────────────────────────────────────────────────

const toggleStatus = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { id } = req.params
        const current = await pool.query(
            'SELECT id, status, name, role FROM users WHERE id = $1',
            [id]
        )
        if (!current.rows[0]) return res.status(404).json({ error: 'User not found.' })

        const row = current.rows[0]
        if (!actorMayManageUser(req.user.role, row, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to change this account status.' })
        }

        try {
            assertAdminCanAccessStaffUser(req, row)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        if (row.role === 'super_admin') {
            return res.status(403).json({ error: 'The system Super Admin account status cannot be changed through the API.' })
        }

        const newStatus = row.status === 'active' ? 'inactive' : 'active'

        const result = await pool.query(
            'UPDATE users SET status = $1 WHERE id = $2 RETURNING id, name, status',
            [newStatus, id]
        )

        await auditLog(req.user,
            newStatus === 'active' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
            'user', id,
            `${newStatus === 'active' ? 'Activated' : 'Deactivated'}: ${row.name}`,
            { req, module_key: 'admins', action_category: 'update', status: newStatus === 'active' ? 'success' : 'warning' })

        res.status(200).json({
            message: `User ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully.`,
            user: result.rows[0],
        })
    } catch (err) {
        console.error('Toggle status error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── DELETE USER ──────────────────────────────────────────────────────────────

const deleteUser = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { id } = req.params
        if (parseInt(id, 10) === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete your own account.' })
        }
        const user = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [id])
        if (!user.rows[0]) {
            return res.status(404).json({ error: 'User not found.' })
        }
        const target = user.rows[0]
        if (!actorMayManageUser(req.user.role, target, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to delete this user.' })
        }
        if (target.role === 'admin' && !isSuperAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Only a Super Admin may delete Administrator accounts.' })
        }
        try {
            assertAdminCanAccessStaffUser(req, target)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }
        if (target.role === 'super_admin') {
            return res.status(400).json({ error: 'The system Super Admin account cannot be deleted.' })
        }
        await pool.query('DELETE FROM users WHERE id = $1', [id])
        await auditLog(req.user, 'USER_DELETED', 'user', id, `Deleted: ${target.name}`,
            { req, module_key: 'admins', action_category: 'delete', status: 'critical' })
        res.status(200).json({ message: 'User deleted successfully.' })
    } catch (err) {
        console.error('Delete user error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── GET USERS BY ROLE ────────────────────────────────────────────────────────

const getUsersByRole = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { role } = req.params
        if (role === 'receptionist') {
            return res.status(400).json({ error: 'Role is no longer supported.' })
        }
        if (role === 'super_admin') {
            if (!isSuperAdmin(req.user.role)) {
                return res.status(403).json({ error: 'Only Super Admins may list Super Admin accounts.' })
            }
        } else if (role === 'admin') {
            if (!isSuperAdmin(req.user.role)) {
                if (!req.adminModuleKeys?.has('admins')) {
                    return res.status(403).json({ error: 'You do not have permission to list Administrator accounts.' })
                }
            }
        } else if (req.user.role === 'admin' && !isSuperAdmin(req.user.role)) {
            try {
                assertAdminMayUseStaffRole(req, role)
            } catch (e) {
                return res.status(e.statusCode || 403).json({ error: e.message })
            }
        }
        const hasRate = await hasRatePerNoteColumn()
        const rateCol = hasRate ? ', rate_per_note' : ''
        const result = await pool.query(
            `SELECT id, name, email, role, specialty, phone, status${rateCol}, admin_modules
             FROM users WHERE role = $1 AND status = 'active' ORDER BY name ASC`,
            [role]
        )
        res.status(200).json({ users: result.rows })
    } catch (err) {
        console.error('Get users by role error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── UPDATE RATE PER NOTE ─────────────────────────────────────────────────────

const updateRate = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { id } = req.params
        const { rate_per_note } = req.body

        if (!(await hasRatePerNoteColumn())) {
            return res.status(503).json({ error: 'Payroll rates are not available until the database schema is updated.' })
        }
        if (rate_per_note == null || isNaN(rate_per_note) || rate_per_note < 0) {
            return res.status(400).json({ error: 'Valid rate is required.' })
        }

        const target = await loadUserRow(id)
        if (!target) return res.status(404).json({ error: 'User not found.' })
        if (!actorMayManageUser(req.user.role, target, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to update this user.' })
        }
        try {
            assertAdminCanAccessStaffUser(req, target)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        const result = await pool.query(
            `UPDATE users SET rate_per_note = $1 WHERE id = $2
                RETURNING id, name, role, rate_per_note`,
            [parseFloat(rate_per_note), id]
        )

        await auditLog(req.user, 'RATE_UPDATED', 'user', id,
            `Rate updated to $${rate_per_note} for: ${result.rows[0].name}`,
            { req, module_key: 'payroll', action_category: 'update', status: 'success' })

        res.status(200).json({ message: `Rate updated for ${result.rows[0].name}`, user: result.rows[0] })
    } catch (err) {
        console.error('Update rate error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

const resetPassword = async (req, res) => {
    try {
        await ensureUserProfileSchema()
        const { id } = req.params
        const { password } = req.body

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' })
        }

        if (isDisallowedPassword(password)) {
            return res.status(400).json({ error: DISALLOWED_MSG })
        }

        const target = await loadUserRow(id)
        if (!target) return res.status(404).json({ error: 'User not found.' })
        if (!actorMayManageUser(req.user.role, target, req.user.id, req.adminModuleKeys)) {
            return res.status(403).json({ error: 'You do not have permission to reset this user password.' })
        }
        if (target.role === 'super_admin' && String(req.user.id) !== String(id)) {
            return res.status(403).json({ error: 'Only the Super Admin can reset that account password.' })
        }
        try {
            assertAdminCanAccessStaffUser(req, target)
        } catch (e) {
            return res.status(e.statusCode || 403).json({ error: e.message })
        }

        const hashed = await bcrypt.hash(password, 10)
        const result = await pool.query(
            'UPDATE users SET password = $1 WHERE id = $2 RETURNING id, name, email',
            [hashed, id]
        )

        await auditLog(req.user, 'PASSWORD_RESET', 'user', id,
            `Password reset for: ${result.rows[0].name} (${result.rows[0].email})`,
            { req, module_key: 'admins', action_category: 'authorization', status: 'warning' })

        res.status(200).json({ message: `Password reset successfully for ${result.rows[0].name}.` })
    } catch (err) {
        console.error('Reset password error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── GET ADMIN STATS ──────────────────────────────────────────────────────────

const getAdminStats = async (req, res) => {
    try {
        const clinicians = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'clinician' AND status = 'active'`)
        const scribes = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'scribe' AND status = 'active'`)
        const qps = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'qps' AND status = 'active'`)
        const admins = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'`)
        const superAdmins = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND status = 'active'`)
        const totalNotes = await pool.query(`SELECT COUNT(*) FROM notes`)
        const pendingNotes = await pool.query(`SELECT COUNT(*) FROM notes WHERE status = 'submitted'`)
        const uploadedNotes = await pool.query(`SELECT COUNT(*) FROM notes WHERE status = 'uploaded'`)

        res.status(200).json({
            stats: {
                clinicians: parseInt(clinicians.rows[0].count, 10),
                scribes: parseInt(scribes.rows[0].count, 10),
                qps: parseInt(qps.rows[0].count, 10),
                admins: parseInt(admins.rows[0].count, 10),
                superAdmins: parseInt(superAdmins.rows[0].count, 10),
                totalNotes: parseInt(totalNotes.rows[0].count, 10),
                pendingNotes: parseInt(pendingNotes.rows[0].count, 10),
                uploadedNotes: parseInt(uploadedNotes.rows[0].count, 10),
            },
        })
    } catch (err) {
        console.error('Get admin stats error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── GET PAYROLL ──────────────────────────────────────────────────────────────

const getPayroll = async (req, res) => {
    try {
        const hasRate = await hasRatePerNoteColumn()
        const rateSel = hasRate ? 'u.rate_per_note' : 'NULL::numeric AS rate_per_note'
        const totalSel = hasRate
            ? `COUNT(n.id) FILTER (WHERE n.status IN ('submitted','uploaded')) * u.rate_per_note`
            : '0'
        const groupRate = hasRate ? ', u.rate_per_note' : ''
        const result = await pool.query(`
            SELECT
                u.id, u.name, u.email, u.role, u.status, ${rateSel},
                COUNT(n.id) FILTER (WHERE n.status IN ('submitted','uploaded')) AS notes_completed,
                COALESCE(ROUND(AVG(g.overall_score)), 0) AS overall_avg,
                ${totalSel} AS total_amount
            FROM users u
                     LEFT JOIN notes n ON (
                n.submitted_by = u.id
                    OR (n.submitted_by IS NULL AND n.visit_id IN (
                    SELECT id FROM visits WHERE scribe_id = u.id
                ))
                )
                     LEFT JOIN grades g ON g.note_id = n.id
            WHERE u.role IN ('scribe', 'qps', 'admin', 'super_admin')
            GROUP BY u.id, u.name, u.email, u.role, u.status${groupRate}
            ORDER BY u.role ASC, notes_completed DESC
        `)
        res.status(200).json({ payroll: result.rows })
    } catch (err) {
        console.error('Get payroll error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

// ─── GET PERFORMANCE ──────────────────────────────────────────────────────────

const getPerformance = async (req, res) => {
    try {
        const hasRate = await hasRatePerNoteColumn()
        const rateSel = hasRate ? 'u.rate_per_note' : 'NULL::numeric AS rate_per_note'
        const groupRate = hasRate ? ', u.rate_per_note' : ''
        const result = await pool.query(`
            SELECT
                u.id, u.name, u.email, u.role, u.status, ${rateSel},
                COUNT(n.id) FILTER (WHERE n.status IN ('submitted','uploaded')) AS notes_completed,
                COALESCE(ROUND(AVG(g.overall_score)), 0)   AS overall_avg,
                COALESCE(ROUND(AVG(g.accuracy)), 0)        AS accuracy_avg,
                COALESCE(ROUND(AVG(g.completeness)), 0)    AS completeness_avg,
                COALESCE(ROUND(AVG(g.terminology)), 0)     AS terminology_avg,
                COALESCE(ROUND(AVG(g.formatting)), 0)      AS formatting_avg
            FROM users u
                     LEFT JOIN notes n ON (
                n.submitted_by = u.id
                    OR (n.submitted_by IS NULL AND n.visit_id IN (
                    SELECT id FROM visits WHERE scribe_id = u.id
                ))
                )
                     LEFT JOIN grades g ON g.note_id = n.id
            WHERE u.role IN ('scribe', 'qps', 'admin', 'super_admin')
            GROUP BY u.id, u.name, u.email, u.role, u.status${groupRate}
            ORDER BY overall_avg DESC
        `)
        res.status(200).json({ performance: result.rows })
    } catch (err) {
        console.error('Get performance error:', err.message)
        res.status(500).json({ error: 'Server error.' })
    }
}

module.exports = {
    getAllUsers,
    getUser,
    updateUser,
    patchAdminModules,
    toggleStatus,
    deleteUser,
    getUsersByRole,
    getAdminStats,
    getPayroll,
    getPerformance,
    updateRate,
    resetPassword,
}
