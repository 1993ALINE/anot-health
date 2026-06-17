const express = require('express')
const router = express.Router()
const { getAllPatients, createPatient, getPatient } = require('../controllers/patientController')
const { protect, restrict } = require('../middleware/auth')

router.use(protect)

// Reading the patient roster is needed by clinicians (scheduling), scribes
// (drafting context) and QPS (review context). The controller scopes rows per role.
router.get('/',     restrict('clinician', 'scribe', 'qps'), getAllPatients)
// Adding patients is a clinician-only action per the role spec.
router.post('/',    restrict('clinician'),                  createPatient)
router.get('/:id',  restrict('clinician', 'scribe', 'qps'), getPatient)

module.exports = router