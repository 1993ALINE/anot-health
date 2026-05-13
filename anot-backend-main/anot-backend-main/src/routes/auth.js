const express = require('express')
const rateLimit = require('express-rate-limit')
const router = express.Router()
const { login, register, getMe, updateMe, changePassword, logout } = require('../controllers/authController')
const { protect, restrict } = require('../middleware/auth')
const { loadAdminPortalModuleKeys } = require('../middleware/adminPortalModules')

// Brute-force protection on credential endpoints.
// 10 attempts per 15min per IP; the limiter only counts failed responses
// so legitimate users aren't punished after a successful login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again later.' },
})

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

// POST /api/auth/register (admin only)
router.post('/register', protect, loadAdminPortalModuleKeys, restrict('admin', 'super_admin'), register)

// POST /api/auth/logout — record sign-out (client still discards token)
router.post('/logout', protect, logout)

// GET /api/auth/me (get current logged in user)
router.get('/me', protect, getMe)

// PUT /api/auth/me (update current logged in user profile)
router.put('/me', protect, updateMe)

// PUT /api/auth/change-password
router.put('/change-password', protect, passwordLimiter, changePassword)

module.exports = router
