const express = require('express')
const router = express.Router()
const { getAllPatients, createPatient, getPatient, deletePatient } = require('../controllers/patientController')
const { protect, restrict } = require('../middleware/auth')

router.use(protect)

// Reading the patient roster is needed by clinicians (scheduling), scribes
// (drafting context) and QPS (review context), plus admins.
router.get('/',     restrict('clinician', 'scribe', 'qps', 'admin', 'super_admin'), getAllPatients)
// Adding patients is a clinician-only action, but admins need it for testing/management.
router.post('/',    restrict('clinician', 'admin', 'super_admin'),                  createPatient)
router.get('/:id',  restrict('clinician', 'scribe', 'qps', 'admin', 'super_admin'), getPatient)
router.delete('/:id', restrict('admin', 'super_admin'), deletePatient)

module.exports = router