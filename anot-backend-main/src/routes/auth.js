const express = require('express')
const rateLimit = require('express-rate-limit')
const router = express.Router()
const { login, register, getMe, updateMe, changePassword, logout, acknowledgePhiTraining, verifyMfaLogin } = require('../controllers/authController')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys } = require('../middleware/adminPortalModules')
const { loginLimiter, mfaVerifyLimiter } = require('../middleware/rateLimit')

// Slightly stricter on password change since the actor is already authenticated
// (mostly to slow down a stolen-token brute force of the *current* password).
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password change attempts. Please try again later.' },
})

// POST /api/auth/login
router.post('/login', loginLimiter, login)

// POST /api/auth/acknowledge-phi-training — completes the PHI-training gate.
// The short-lived temporaryToken from login is verified inside the controller
// (it arrives in the body, not the Authorization header), so no `protect` here.
// Rate-limited like other credential endpoints to bound abuse.
router.post('/acknowledge-phi-training', loginLimiter, acknowledgePhiTraining)

// POST /api/auth/verify-mfa — completes the MFA gate after password verification.
router.post('/verify-mfa', mfaVerifyLimiter, verifyMfaLogin)

// POST /api/auth/register (admin only)
router.post('/register', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), register)

// POST /api/auth/logout — record sign-out (client still discards token)
router.post('/logout', protect, logout)

// GET /api/auth/me (get current logged in user)
router.get('/me', protect, getMe)

// PUT /api/auth/me (update current logged in user profile)
router.put('/me', protect, updateMe)

// PUT /api/auth/change-password
// The short-lived temporaryToken (require_password_change claim) is accepted
// in the body and/or Authorization header so the forced-change gate can work
// even when the session cookie is present but stale. `protect` is used when
// no temporaryToken is in the body (i.e. the user is changing their own
// password from inside the portal — requires current password).
const { changePasswordGate } = require('../middleware/changePasswordGate')
router.put('/change-password', changePasswordGate, passwordLimiter, changePassword)

module.exports = router
