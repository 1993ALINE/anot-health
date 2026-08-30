const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { syncPatients, syncAppointments, getStatus } = require('../controllers/ehrController')

router.use(protect)
router.use(restrict('admin', 'super_admin'))

router.get('/:connectionId/status', getStatus)
router.post('/:connectionId/sync-patients', syncPatients)
router.post('/:connectionId/sync-appointments', syncAppointments)

module.exports = router
