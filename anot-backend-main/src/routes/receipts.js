const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { getClinicianReceipts, getClinicianReceiptById } = require('../controllers/receiptsController')

// GET /api/receipts        — list all receipts for the authenticated clinician
router.get('/', protect, restrict('clinician'), getClinicianReceipts)

// GET /api/receipts/:id    — get one receipt by ID (ownership verified server-side)
router.get('/:id', protect, restrict('clinician'), getClinicianReceiptById)

module.exports = router
