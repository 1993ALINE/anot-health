const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const {
    listAuditLogs,
    getAuditSummary,
    exportAuditLogs,
    applyRetention,
} = require('../controllers/auditController')
const { logAdminPortalModuleAccess } = require('../middleware/adminPortalAudit')

router.use(protect)
router.use(loadAdminPortalModuleKeys)
router.use(restrict('admin', 'super_admin'))
router.use(requireAdminPortalModules('audit'))

router.get('/summary', logAdminPortalModuleAccess('audit'), getAuditSummary)
router.get('/export', exportAuditLogs)
router.post('/retention/apply', restrict('super_admin'), applyRetention)
router.get('/', logAdminPortalModuleAccess('audit'), listAuditLogs)

module.exports = router
