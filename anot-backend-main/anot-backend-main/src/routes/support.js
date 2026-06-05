const express = require('express')
const router = express.Router()
const { protect, restrict } = require('../middleware/auth')
const { supportChat } = require('../controllers/supportController')

router.post('/chat', protect, restrict('clinician'), supportChat)

module.exports = router
