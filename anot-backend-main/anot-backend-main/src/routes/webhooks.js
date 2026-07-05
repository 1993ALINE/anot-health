const express = require('express')
const router = express.Router()
const { postDeepgramWebhook } = require('../controllers/deepgramWebhookController')

router.post('/deepgram', postDeepgramWebhook)

module.exports = router
