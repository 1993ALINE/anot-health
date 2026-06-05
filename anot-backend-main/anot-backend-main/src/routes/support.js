const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { supportMessage } = require('../controllers/supportController')

router.post('/message', protect, restrict('clinician'), supportMessage)

module.exports = router
