'use strict'

/**
 * Super Admin utilities.
 * DELETE /api/admin/users/:userId — permanently delete a non–super-admin user.
 *
 * POST /api/admin/reset-database was removed from the router — it purged all PHI
 * and is too dangerous for production (accidental trigger or compromised session).
 */

const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { deleteAdminUser } = require('../controllers/adminDeleteUserController')

router.use(protect)
router.use(restrict('super_admin'))

router.delete('/users/:userId', deleteAdminUser)

module.exports = router
