// â”€â”€â”€ SECRETS BOOTSTRAP (must run first) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// loadSecrets() hydrates process.env from SSM (prod) or .env (local) BEFORE any
// module that reads process.env at require-time is loaded. instrument.js reads
// SENTRY_DSN on require, and ./config/db builds the PG Pool on require, so both
// are deferred into bootstrap() below â€” after secrets are in place. See
// src/config/loadSecrets.js for the full rationale.
const loadSecrets = require('./config/loadSecrets')

async function bootstrap() {
  await loadSecrets()

  // Sentry init reads SENTRY_DSN â€” require only after secrets are loaded.
  require('../instrument.js')

  const Sentry       = require('@sentry/node')
  const express      = require('express')
  const cors         = require('cors')
  const helmet       = require('helmet')
  const rateLimit    = require('express-rate-limit')

  const jwtSecret = process.env.JWT_SECRET?.trim()
  if (!jwtSecret) {
    console.error('FATAL: JWT_SECRET is required.')
    process.exit(1)
  }
  if (jwtSecret.length < 16 && process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET must be at least 16 characters in production.')
    process.exit(1)
  }

  // ./config/db opens the PostgreSQL Pool the moment it is required, so this
  // line must stay AFTER await loadSecrets() above.
  require('./config/db')

  const loggingMiddleware = require('./middleware/logging')
  const { initCloudWatch } = require('./utils/logger')
  const { ensureUserProfileSchema } = require('./utils/ensureUserProfileSchema')

  const app = express()

// Don't advertise the framework.
app.disable('x-powered-by')

// Behind Railway / other reverse proxies: trust X-Forwarded-* for correct rate-limit IPs.
// In production we default to 1 hop; set TRUST_PROXY=0 to disable (e.g. local testing).
const _tp = process.env.TRUST_PROXY
if (_tp === 'false' || _tp === '0') {
  /* direct connections only */
} else if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
  app.set('trust proxy', 1)
} else if (_tp != null && _tp !== '') {
  const n = parseInt(_tp, 10)
  if (Number.isFinite(n) && n > 0) app.set('trust proxy', n)
}

// â”€â”€â”€ SECURITY HEADERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // We serve audio cross-origin (frontend on Vercel pulls from backend on Railway).
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}))

// Additional explicit security headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  next()
})

// â”€â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Local dev origins are always allowed; CORS_ORIGINS adds extra entries (comma-separated).
// The previous /\.vercel\.app$/ regex matched any attacker-deployed *.vercel.app, so it's gone.
// CORS must run BEFORE rate limiting so that 429 responses (and preflight requests
// throttled by the limiter) still carry Access-Control-Allow-Origin â€” otherwise the
// browser reports those as CORS failures instead of the real status.

// CORS configuration - ISSUE-005 Fix
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'http://localhost:5173',
      process.env.FRONTEND_URL
    ].filter(Boolean)

if (process.env.CORS_ORIGINS) {
  for (const origin of process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin)
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('CORS: Origin not allowed'))
    }
  },
  credentials: true,
}

// cors() handles OPTIONS preflight automatically, so no explicit app.options() route
// is needed (and a '*' path would crash under Express 5 / path-to-regexp).
app.use(cors(corsOptions))

// â”€â”€â”€ RATE LIMITING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// General API limit + stricter limit on auth routes to slow brute-force attempts.

const isProduction = process.env.NODE_ENV === 'production'

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Strict in production; relaxed locally so dev testing isn't throttled.
  max:      isProduction ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 20 per 15min in production: strict enough to slow brute-force, loose enough
  // that legitimate users (e.g. shared office IPs) aren't locked out.
  max:      isProduction ? 20 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
})

app.use('/api', apiLimiter)
app.use('/api/auth', authLimiter)

const jsonSmall = express.json({ limit: '2mb' })
const jsonLarge = express.json({ limit: '15mb' })
app.use((req, res, next) => {
  if (String(req.originalUrl || '').startsWith('/api/webhooks')) return jsonLarge(req, res, next)
  return jsonSmall(req, res, next)
})
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// Body-parser failures must not surface as opaque 500s. A malformed JSON body
// (e.g. a client sending `{"patient_id":,...}`) makes express.json() throw a
// SyntaxError with status 400; an oversized body throws status 413. Without this
// handler those errors fall through to the generic 500 ("Internal server error"),
// which is what made POST /api/visits, POST /api/patients and the audit routes
// look "broken" / "return invalid JSON". We catch them here â€” before the Sentry
// error handler â€” so the client gets an actionable 4xx and we don't log garbage
// payloads as server errors.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || (err.status === 400 && 'body' in err))) {
    return res.status(400).json({ error: 'Invalid JSON in request body.' })
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Request body is too large.' })
  }
  return next(err)
})

// Audio is served only via authorized GET /api/audio/:visitId (not a public /uploads URL).

// â”€â”€â”€ AUDIT LOGGING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Attaches req.clientIp (the trusted req.ip â€” not spoofable X-Forwarded-For) and
// ships error responses to CloudWatch for HIPAA audit. Placed after trust proxy
// + body parsing so the IP is correct, and ahead of all routes.
app.use(loggingMiddleware)

// â”€â”€â”€ HEALTH CHECK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/', (req, res) => {
  res.json({ message: 'âœ… Anot API is running', version: 'v40', status: 'healthy' })
})

// â”€â”€â”€ ROUTES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use('/api/auth',        require('./routes/auth'))
app.use('/api/webhooks',    require('./routes/webhooks'))
app.use('/api/users',       require('./routes/users'))
app.use('/api/patients',    require('./routes/patients'))
app.use('/api/visits',      require('./routes/visits'))
app.use('/api/notes',       require('./routes/notes'))
app.use('/api/assignments', require('./routes/assignments'))
app.use('/api/audio',       require('./routes/audio'))
app.use('/api/audit',       require('./routes/audit'))
app.use('/api/settings',    require('./routes/settings'))
app.use('/api/support',     require('./routes/support'))
app.use('/api/admin',       require('./routes/health'))

// â”€â”€â”€ 404 HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` })
})

// â”€â”€â”€ SENTRY ERROR HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Must be registered after all routes/controllers and before our own error
// handler. PHI scrubbing is configured in instrument.js (beforeSend).

Sentry.setupExpressErrorHandler(app)

// â”€â”€â”€ ERROR HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.use((err, req, res, next) => {
  if (err.message && String(err.message).startsWith('CORS:')) {
    return res.status(403).json({ error: 'Origin not allowed.' })
  }
  console.error('Server error:', err.message)
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  })
})

// â”€â”€â”€ START â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PORT = process.env.PORT || 5000
// Bind IPv4 explicitly so http://127.0.0.1:PORT always hits this process on Windows/WSL.
const HOST = process.env.BIND_HOST || '0.0.0.0'

// Apply idempotent schema (users profile/PHI/forced-password columns) before we
// accept traffic, so the columns exist on a fresh deploy without waiting for the
// first login to lazily create them. ALTER TABLE ... IF NOT EXISTS is a no-op
// when the columns are already present.
const startServer = async () => {
  try {
    console.log('[Startup] Ensuring user profile schema...')
    await ensureUserProfileSchema()
    console.log('[Startup] âœ… Schema ready')
  } catch (err) {
    console.error('[Startup] Schema initialization failed:', err.message)
    process.exit(1)
  }

  app.listen(PORT, HOST, () => {
    console.log(`ðŸš€ Anot server running on http://127.0.0.1:${PORT} (bound ${HOST}:${PORT})`)
    console.log(`ðŸ“‹ Environment: ${process.env.NODE_ENV || 'development'}`)
    // Provision the CloudWatch log group/stream. No-ops safely when audit
    // shipping is disabled or AWS isn't configured (e.g. Railway).
    initCloudWatch().catch((err) => console.error('CloudWatch init error:', err.message))
  })
}

  startServer()
} // end bootstrap()

// Kick everything off. Any unhandled bootstrap error is fatal so the process
// supervisor (EB/PM2) restarts cleanly instead of serving a half-initialised app.
bootstrap().catch((err) => {
  console.error('FATAL: bootstrap failed:', err && err.message ? err.message : err)
  process.exit(1)
})
