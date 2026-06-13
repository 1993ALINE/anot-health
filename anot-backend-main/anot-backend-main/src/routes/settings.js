const express = require('express')
const router = express.Router()
const db = require('../config/db')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys, requireAdminPortalModules } = require('../middleware/adminPortalModules')
const { getPublicSettings, getInternalSettings, updateSettings } = require('../controllers/settingsController')

router.get('/public', getPublicSettings)
router.get('/internal', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), getInternalSettings)
router.put('/', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), requireAdminPortalModules('settings'), updateSettings)


// Admin-only: Clean database (delete all clinical data)
router.post('/admin/cleanup-database', protect, restrict('super_admin'), async (req, res) => {
  try {
    const client = await db.connect()
    try {
      await client.query('BEGIN')

      // Delete in correct FK order: grades -> notes -> visits -> patients
      await client.query('DELETE FROM grades')
      await client.query('DELETE FROM notes')
      await client.query('DELETE FROM visits')
      await client.query('DELETE FROM patients')

      // Reset auto-increment sequences
      await client.query('ALTER SEQUENCE grades_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE notes_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE visits_id_seq RESTART WITH 1')
      await client.query('ALTER SEQUENCE patients_id_seq RESTART WITH 1')

      await client.query('COMMIT')

      res.json({
        success: true,
        message: 'Database cleaned successfully'
      })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('[cleanup] Error:', error.message)
    res.status(500).json({ error: 'Cleanup failed: ' + error.message })
  }
})

module.exports = router



