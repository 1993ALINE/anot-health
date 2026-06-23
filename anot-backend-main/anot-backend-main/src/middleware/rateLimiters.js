/**
 * Rate Limiters Configuration
 * ISSUE-007 Fix: Password reset and sensitive endpoint rate limiting
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redis = require('redis');

// Create Redis client for distributed rate limiting (optional)
let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL,
      legacyMode: false
    });
    redisClient.connect();
    console.log('[OK] Redis connected for rate limiting');
  } catch (error) {
    console.warn('Redis not available, using in-memory rate limiting:', error.message);
  }
}

/**
 * Password Reset Rate Limiter
 * Very strict: 5 requests per hour per IP
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  message: {
    error: 'Too many password reset attempts. Please try again later.',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use Redis store if available
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:password-reset:'
  }) : undefined,
  // Custom key generator (IP + user identifier if available)
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress;
    const userId = req.body?.email || req.params?.id || '';
    return `${ip}-${userId}`;
  },
  // Handler for when limit is exceeded
  handler: (req, res) => {
    console.warn(`[SECURITY] Password reset rate limit exceeded: ${req.ip}`);
    
    // Log to audit system
    if (req.auditLog) {
      req.auditLog({
        event: 'PASSWORD_RESET_RATE_LIMIT',
        severity: 'WARNING',
        ip: req.ip,
        details: 'Too many password reset attempts'
      });
    }
    
    res.status(429).json({
      error: 'Too many password reset attempts',
      message: 'Please try again in 1 hour',
      retryAfter: 3600
    });
  }
});

/**
 * User Management Rate Limiter
 * Moderate: 20 requests per 15 minutes per IP
 */
const userManagementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    error: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:user-mgmt:'
  }) : undefined
});

/**
 * Login Rate Limiter
 * 10 attempts per 15 minutes per IP
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many login attempts. Please try again later.'
  },
  skipSuccessfulRequests: true, // Don't count successful logins
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:login:'
  }) : undefined,
  handler: (req, res) => {
    console.warn(`[SECURITY] Login rate limit exceeded: ${req.ip}`);
    
    res.status(429).json({
      error: 'Too many login attempts',
      message: 'Please try again in 15 minutes',
      retryAfter: 900
    });
  }
});

/**
 * Registration Rate Limiter
 * 3 registrations per hour per IP
 */
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: {
    error: 'Too many registration attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:register:'
  }) : undefined
});

/**
 * API General Rate Limiter
 * 100 requests per 15 minutes per IP
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisClient ? new RedisStore({
    client: redisClient,
    prefix: 'rl:api:'
  }) : undefined
});

module.exports = {
  passwordResetLimiter,
  userManagementLimiter,
  loginLimiter,
  registrationLimiter,
  apiLimiter
};
