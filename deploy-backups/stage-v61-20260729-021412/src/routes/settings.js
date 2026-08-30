const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const { getPublicSettings, getInternalSettings, getTranscriptionSettings, updateTranscriptionSettings, updateSettings, testDeepgramAdvancedSettings } = require('../controllers/settingsController')
const { getClinicianTemplates, saveClinicianTemplates, deleteClinicianTemplate } = require('../controllers/clinicianTemplatesController')
const {
  listConnections,
  getConnectionTypes,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
} = require('../controllers/ehrConnectionsController')

router.get('/public', getPublicSettings)
router.get('/clinician-templates', protect, restrict('clinician'), getClinicianTemplates)
router.post('/clinician-templates', protect, restrict('clinician'), saveClinicianTemplates)
router.delete('/clinician-templates/:id', protect, restrict('clinician'), deleteClinicianTemplate)
router.get('/internal', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getInternalSettings)
router.get('/transcription', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getTranscriptionSettings)
router.put('/transcription', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateTranscriptionSettings)
router.put('/', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateSettings)
router.post('/deepgram/test', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), testDeepgramAdvancedSettings)
router.get('/ehr-connections', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), listConnections)
router.get('/ehr-connections/types', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getConnectionTypes)
router.post('/ehr-connections', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), createConnection)
router.put('/ehr-connections/:id', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateConnection)
router.delete('/ehr-connections/:id', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), deleteConnection)
router.post('/ehr-connections/:id/test', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), testConnection)

// NOTE: The bulk "cleanup-database" endpoint was removed for HIPAA compliance
// (§164.312(b)). Destroying all patient/visit/note PHI must never be reachable
// from the production API. For local development only, use scripts/cleanup-dev.js.

module.exports = router
