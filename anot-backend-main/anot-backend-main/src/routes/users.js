const express = require('express')
const router  = express.Router()
const {
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
} = require('../controllers/userController')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const { logAdminPortalModuleAccess } = require('../middleware/adminPortalAudit')

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

router.get('/',                protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),            getAllUsers)
router.get('/stats',           protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('overview'), logAdminPortalModuleAccess('overview'), getAdminStats)
router.get('/payroll',         protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('payroll'), logAdminPortalModuleAccess('payroll'), getPayroll)
// Performance reports belong to QPS (quality oversight). Super Admin retains
// access as the bootstrap operator; regular Admins no longer see this report.
router.get('/performance',     protect, restrict('qps', 'super_admin'), getPerformance)
// Role lookup is used by QPS (provider picker) and Admins; staff who only need
// their own assignments use the dedicated /assignments/my-clinicians route.
router.get('/role/:role',      protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin', 'qps'), getUsersByRole)
router.patch('/:id/admin-modules', protect, loadAdminPortalModuleKeys, restrict('super_admin'), requireAdminPortalModules('admins'), patchAdminModules)
router.get('/:id',             protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),            getUser)
router.put('/:id',             protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),            updateUser)
router.put('/:id/toggle-status', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),          toggleStatus)
router.put('/:id/reset-password', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),         resetPassword)
router.put('/:id/rate',        protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),            updateRate)
router.delete('/:id',          protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'),            deleteUser)

module.exports = router