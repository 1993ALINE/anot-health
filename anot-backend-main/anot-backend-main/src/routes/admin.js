'use strict'

/**
 * TEMPORARY Super Admin utilities.
 * POST /api/admin/reset-database — purge all test PHI, keep one super admin.
 */

const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { resetDatabase } = require('../controllers/adminResetController')

router.use(protect)
router.use(restrict('super_admin'))

router.post('/reset-database', resetDatabase)

module.exports = router
