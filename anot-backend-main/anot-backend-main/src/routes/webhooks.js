const express = require('express')
const router = express.Router()
const { postDeepgramWebhook } = require('../controllers/deepgramWebhookController')

// No JWT or CSRF — verified via HMAC query (visit_id + sig).
router.post('/deepgram', postDeepgramWebhook)

module.exports = router
