const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const { getPublicSettings, getInternalSettings, updateSettings } = require('../controllers/settingsController')

router.get('/public', getPublicSettings)
router.get('/internal', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getInternalSettings)
router.put('/', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateSettings)

module.exports = router

