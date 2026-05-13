const express = require('express')
const router = express.Router()
const { getAllPatients, createPatient, getPatient } = require('../controllers/patientController')
const { protect } = require('../middleware/auth')

router.use(protect)

router.get('/',     getAllPatients)
router.post('/',    createPatient)
router.get('/:id',  getPatient)

module.exports = router