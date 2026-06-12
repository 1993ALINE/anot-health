const express = require('express')
const router = express.Router()
const db = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const { getPublicSettings, getInternalSettings, updateSettings } = require('../controllers/settingsController')

router.get('/public', getPublicSettings)
router.get('/internal', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getInternalSettings)
router.put('/', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateSettings)


// Admin-only: Clean database (delete all visits/recordings)
router.post('/admin/cleanup-database', protect, restrict('super_admin'), async (req, res) => {
  try {
    const client = await db.connect()
    try {
      await client.query('DELETE FROM transcriptions')
      await client.query('DELETE FROM visit_audio_files')
      await client.query('DELETE FROM visits')
      await client.query('ALTER SEQUENCE visits_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE transcriptions_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE visit_audio_files_id_seq RESTART WITH 1')
      
      res.json({ 
        success: true, 
        message: 'Database cleaned: all visits and recordings deleted'
      })
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Database cleanup error:', error)
    res.status(500).json({ error: 'Cleanup failed: ' + error.message })
  }
})

module.exports = router



