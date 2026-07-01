'use strict'

/**
 * Super Admin utilities.
 * POST /api/admin/reset-database — purge all test PHI, keep one super admin.
 * DELETE /api/admin/users/:userId — permanently delete a non–super-admin user.
 */

const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { resetDatabase } = require('../controllers/adminResetController')
const { deleteAdminUser } = require('../controllers/adminDeleteUserController')

router.use(protect)
router.use(restrict('super_admin'))

router.post('/reset-database', resetDatabase)
router.delete('/users/:userId', deleteAdminUser)

module.exports = router
