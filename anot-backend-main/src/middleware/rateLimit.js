'use strict'

const rateLimit = require('express-rate-limit')

let loginLimiter = null
let apiLimiter = null
let mfaVerifyLimiter = null
let redisClient = null

const PUBLIC_API_PATHS = new Set([
  '/health',
  '/admin/health',
])

function parsePositiveInt(value, fallback) {
  if (value == null || value === '') { return fallback }
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function getRateLimitConfig() {
  const loginWindowMs =
    parsePositiveInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS, 0) ||
    parsePositiveInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES, 15) * 60 * 1000

  const apiWindowMs =
    parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MS, 0) ||
    parsePositiveInt(process.env.RATE_LIMIT_API_WINDOW_MINUTES, 1) * 60 * 1000

  return {
    login: {
      windowMs: loginWindowMs,
      max: parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, 30),
    },
    api: {
      windowMs: apiWindowMs,
      max: parsePositiveInt(process.env.RATE_LIMIT_API_MAX, 10000),
    },
  }
}

function shouldSkipApiRateLimit(req) {
  const path = (req.path || '').split('?')[0]
  if (PUBLIC_API_PATHS.has(path)) { return true }
  if (path.startsWith('/webhooks')) { return true }
  // Skip aggressive rate limiting for authenticated user requests
  if (req.cookies?.session_token || req.headers?.authorization || req.headers?.['x-csrf-token']) {
    return true
  }
  return false
}

function buildLimiterOptions(cfg, store) {
  const base = {
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false,
  }
  if (store) {
    base.store = store
  }
  return base
}

function createLoginLimiter(store) {
  const cfg = getRateLimitConfig().login
  const windowMinutes = Math.round(cfg.windowMs / 60000)

  return rateLimit({
    ...buildLimiterOptions(cfg, store),
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

function createMfaVerifyLimiter(store) {
  const windowMs = parsePositiveInt(process.env.RATE_LIMIT_MFA_WINDOW_MS, 15 * 60 * 1000)
  const max = parsePositiveInt(process.env.RATE_LIMIT_MFA_MAX, 10)
  return rateLimit({
    ...buildLimiterOptions({ windowMs, max }, store),
    skipSuccessfulRequests: true,
    message: { error: 'Too many MFA attempts. Please try again later.' },
    handler(req, res, _next, options) {
      console.warn(`[rate-limit] MFA verify limit exceeded: ${req.ip}`)
      res.status(options.statusCode).json(options.message)
    },
  })
}

function createApiLimiter(store) {
  const cfg = getRateLimitConfig().api

  return rateLimit({
    ...buildLimiterOptions(cfg, store),
    skip: shouldSkipApiRateLimit,
    message: { error: 'Too many requests. Please try again later.' },
    handler(req, res, _next, options) {
      console.warn(`[rate-limit] API limit exceeded: ${req.ip} ${req.method} ${req.originalUrl}`)
      res.status(options.statusCode).json(options.message)
    },
  })
}

async function createRedisStore(prefix) {
  const url = process.env.REDIS_URL?.trim()
  if (!url) { return null }

  try {
    const { createClient } = require('redis')
    const { RedisStore } = require('rate-limit-redis')

    if (!redisClient) {
      redisClient = createClient({ url })
      redisClient.on('error', (err) => {
        console.warn('[rate-limit] Redis error:', err.message)
      })
      await redisClient.connect()
      console.log('[rate-limit] Redis store connected')
    }

    return new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix,
    })
  } catch (err) {
    console.warn('[rate-limit] Redis unavailable — using in-memory store:', err.message)
    return null
  }
}

async function initRateLimiters() {
  const store = await createRedisStore('anot:rl:')
  loginLimiter = createLoginLimiter(store)
  apiLimiter = createApiLimiter(store)
  mfaVerifyLimiter = createMfaVerifyLimiter(store)
  if (store) {
    console.log('[rate-limit] Using Redis-backed rate limiting')
  } else {
    console.log('[rate-limit] Using in-memory rate limiting')
  }
  return { loginLimiter, apiLimiter }
}

function getLoginLimiter() {
  if (!loginLimiter) { loginLimiter = createLoginLimiter(null) }
  return loginLimiter
}

function getMfaVerifyLimiter() {
  if (!mfaVerifyLimiter) { mfaVerifyLimiter = createMfaVerifyLimiter(null) }
  return mfaVerifyLimiter
}

function getApiLimiter() {
  if (!apiLimiter) { apiLimiter = createApiLimiter(null) }
  return apiLimiter
}

module.exports = {
  getRateLimitConfig,
  shouldSkipApiRateLimit,
  createLoginLimiter,
  createApiLimiter,
  initRateLimiters,
  get loginLimiter() { return getLoginLimiter() },
  get apiLimiter() { return getApiLimiter() },
  get mfaVerifyLimiter() { return getMfaVerifyLimiter() },
}
