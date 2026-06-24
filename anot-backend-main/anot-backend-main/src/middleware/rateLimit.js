'use strict'

const rateLimit = require('express-rate-limit')

/**
 * Paths under /api that are excluded from the general API rate limiter.
 * Root (/) and EB health probes are outside /api and are never limited here.
 */
const PUBLIC_API_PATHS = new Set([
  '/admin/health',
  '/openapi.yaml',
  '/docs',
])

function parsePositiveInt(value, fallback) {
  if (value == null || value === '') return fallback
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Read rate-limit settings from environment (EB env props, .env, or SSM via loadSecrets).
 * Defaults: login 10 / 15 min, API 200 / 1 min (production).
 */
function getRateLimitConfig() {
  const isProduction = process.env.NODE_ENV === 'production'

  const loginWindowMs =
    parsePositiveInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS, 0) ||
    parsePositiveInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES, 15) * 60 * 1000

  const apiWindowMs =
    parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MS, 0) ||
    parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MINUTES, 1) * 60 * 1000

  return {
    login: {
      windowMs: loginWindowMs,
      max: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, 10),
    },
    api: {
      windowMs: apiWindowMs,
      max: parsePositiveInt(process.env.RATE_LIMIT_API_MAX, isProduction ? 200 : 2000),
    },
  }
}

function shouldSkipApiRateLimit(req) {
  const path = (req.path || '').split('?')[0]
  if (PUBLIC_API_PATHS.has(path)) return true
  if (path.startsWith('/webhooks')) return true
  return false
}

function createLoginLimiter() {
  const cfg = getRateLimitConfig().login
  const windowMinutes = Math.round(cfg.windowMs / 60000)

  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      error: `Too many login attempts. Please try again in ${windowMinutes} minutes.`,
    },
    handler(req, res, _next, options) {
      console.warn(`[rate-limit] Login limit exceeded: ${req.ip}`)
      res.status(options.statusCode).json(options.message)
    },
  })
}

function createApiLimiter() {
  const cfg = getRateLimitConfig().api

  return rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: shouldSkipApiRateLimit,
    message: { error: 'Too many requests. Please try again later.' },
    handler(req, res, _next, options) {
      console.warn(`[rate-limit] API limit exceeded: ${req.ip} ${req.method} ${req.originalUrl}`)
      res.status(options.statusCode).json(options.message)
    },
  })
}

const loginLimiter = createLoginLimiter()
const apiLimiter = createApiLimiter()

module.exports = {
  getRateLimitConfig,
  shouldSkipApiRateLimit,
  createLoginLimiter,
  createApiLimiter,
  loginLimiter,
  apiLimiter,
}
