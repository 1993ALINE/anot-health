// ─── SECRETS BOOTSTRAP (must run first) ───────────────────────────────────────
// loadSecrets() hydrates process.env from SSM (prod) or .env (local) BEFORE any
// module that reads process.env at require-time is loaded. instrument.js reads
// SENTRY_DSN on require, and ./config/db builds the PG Pool on require, so both
// are deferred into bootstrap() below — after secrets are in place. See
// src/config/loadSecrets.js for the full rationale.
const loadSecrets = require('./config/loadSecrets')
const { validateStartupConfig } = require('./startup/startupDiagnostics')
const express = require('express')

// ─── PROCESS-LEVEL ERROR HANDLERS (register before bootstrap) ─────────────────
// Log fatal async errors so EB/CloudWatch captures the cause instead of a silent
// "Engine execution has encountered an error".
function logFatal(label, err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[FATAL] ${label}:`, msg)
  if (err instanceof Error && err.stack) {
    console.error(err.stack)
  }
}

process.on('unhandledRejection', (reason) => {
  logFatal('Unhandled Rejection', reason)
  process.exit(1)
})

process.on('uncaughtException', (error) => {
  logFatal('Uncaught Exception', error)
  process.exit(1)
})

// ─── EARLY HEALTH SERVER (before secrets/DB — EB ALB probes during warm-up) ─
const PORT = process.env.PORT || 5000
const HOST = process.env.BIND_HOST || '0.0.0.0'

let lastDbHealth = { ok: false, checkedAt: 0 }
let appReady = false
let healthTimer = null
let pool = null

const app = express()

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: appReady ? 'healthy' : 'starting',
    db: appReady ? (lastDbHealth.ok ? 'ok' : 'degraded') : 'pending',
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/', (_req, res) => {
  res.status(200).json({ status: appReady ? 'healthy' : 'starting' })
})

const server = app.listen(PORT, HOST, () => {
  console.log(`[startup] Health probes listening on ${HOST}:${PORT} (app warming up)`)
})

server.on('error', (err) => {
  console.error('[FATAL] Server listen error:', err.message)
  if (err.code === 'EADDRINUSE') {
    console.error(`   ↳ Port ${PORT} is already in use. Set PORT in .env or stop the other process.`)
  }
  process.exit(1)
})

async function bootstrap() {
  const secretsResult = await loadSecrets()

  // Sentry init reads SENTRY_DSN — require only after secrets are loaded.
  require('../instrument.js')

  const Sentry       = require('@sentry/node')
  const compression  = require('compression')
  const cors         = require('cors')
  const helmet       = require('helmet')
  const cookieParser = require('cookie-parser')
  const { initRateLimiters, getRateLimitConfig } = require('./middleware/rateLimit')
  const errorHandler = require('./middleware/errorHandler')

  await validateStartupConfig({ secretsResult })

  // ./config/db opens the PostgreSQL Pool the moment it is required, so this
  // line must stay AFTER await loadSecrets() and env validation above.
  pool = require('./config/db')
  await pool.verifyDatabaseConnection()

  const loggingMiddleware = require('./middleware/logging')
  const { initCloudWatch } = require('./utils/logger')
  const { ensureUserProfileSchema } = require('./utils/ensureUserProfileSchema')
  const { loadAiSettings } = require('./services/aiSettings')
  const { cleanCorruptedSettings } = require('./startup/cleanCorruptedSettings')
  const { encryptPlaintextMfaSecrets } = require('./startup/encryptMfaSecrets')

  // ─── MIDDLEWARE (health routes registered above, before listen) ─────────────
  const { correlationIdMiddleware } = require('./middleware/correlationId')
  app.use(correlationIdMiddleware)

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

  // ─── SECURITY HEADERS ────────────────────────────────────────────────────────

  app.use(compression())
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'", "blob:"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        scriptSrcAttr: ["'none'"],
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
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
    next()
  })

  // ─── CORS ───────────────────────────────────────────────────────────────────
  // Local dev origins are always allowed; CORS_ORIGINS adds extra entries (comma-separated).
  // The previous /\.vercel\.app$/ regex matched any attacker-deployed *.vercel.app, so it's gone.
  // CORS must run BEFORE rate limiting so that 429 responses (and preflight requests
  // throttled by the limiter) still carry Access-Control-Allow-Origin — otherwise the
  // browser reports those as CORS failures instead of the real status.

  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
    : [
        'http://localhost:3000',
        'http://localhost:5173',
        process.env.FRONTEND_URL,
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'x-csrf-token'],
    exposedHeaders: ['x-csrf-token'],
  }

  // cors() handles OPTIONS preflight automatically, so no explicit app.options() route
  // is needed (and a '*' path would crash under Express 5 / path-to-regexp).
  app.use(cookieParser())
  app.use(cors(corsOptions))

  // ─── RATE LIMITING ───────────────────────────────────────────────────────────
  // General API limit + stricter limit on auth routes to slow brute-force attempts.

  const rateLimitConfig = getRateLimitConfig()
  console.log(
    `[rate-limit] API ${rateLimitConfig.api.max} req / ${Math.round(rateLimitConfig.api.windowMs / 1000)}s, ` +
      `login ${rateLimitConfig.login.max} attempts / ${Math.round(rateLimitConfig.login.windowMs / 60000)} min`,
  )

  await initRateLimiters()
  const { apiLimiter } = require('./middleware/rateLimit')
  app.use('/api', apiLimiter)

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
  // look "broken" / "return invalid JSON". We catch them here — before the Sentry
  // error handler — so the client gets an actionable 4xx and we don't log garbage
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

  // ─── AUDIT LOGGING ───────────────────────────────────────────────────────────
  // Attaches req.clientIp (the trusted req.ip — not spoofable X-Forwarded-For) and
  // ships error responses to CloudWatch for HIPAA audit. Placed after trust proxy
  // + body parsing so the IP is correct, and ahead of all routes.
  app.use(loggingMiddleware)

  // CSRF: cookie-parser → /api/csrf-token route → webhooks (HMAC, no CSRF) → csrfProtection → routes
  const { csrfProtection, csrfTokenRoute } = require('./middleware/csrf')
  app.get('/api/csrf-token', csrfTokenRoute)
  app.use('/api/webhooks', require('./routes/webhooks'))
  app.use('/api', csrfProtection)

  // ─── ROUTES ──────────────────────────────────────────────────────────────────
  app.use('/api', require('./routes/openapi'))

  app.use('/api/auth',        require('./routes/auth'))
  app.use('/api/users',       require('./routes/users'))
  app.use('/api/patients',    require('./routes/patients'))
  app.use('/api/visits',      require('./routes/visits'))
  app.use('/api/notes',       require('./routes/notes'))
  app.use('/api/assignments', require('./routes/assignments'))
  app.use('/api/audio',       require('./routes/audio'))
  app.use('/api/audit',       require('./routes/audit'))
  app.use('/api/settings',    require('./routes/settings'))
  app.use('/api/support',     require('./routes/support'))
  app.use('/api/mfa',         require('./routes/mfa'))
  const { enforceAdminMfa } = require('./middleware/enforceAdminMfa')
  app.use('/api/admin', enforceAdminMfa)
  app.use('/api/consent',     require('./routes/consent'))
  app.use('/api/admin',       require('./routes/admin'))
  app.use('/api/admin',       require('./routes/health'))

  // ─── 404 HANDLER ─────────────────────────────────────────────────────────────

  app.use((req, res) => {
    res.status(404).json({ error: 'Resource not found' })
  })

  // ─── SENTRY ERROR HANDLER ────────────────────────────────────────────────────
  // Must be registered after all routes/controllers and before our own error
  // handler. PHI scrubbing is configured in instrument.js (beforeSend).

  Sentry.setupExpressErrorHandler(app)

  // ─── ERROR HANDLER ───────────────────────────────────────────────────────────

  app.use(errorHandler)

  // ─── FINISH STARTUP (server already listening for health probes) ─────────────
  // Apply idempotent schema (users profile/PHI/forced-password columns) before we
  // accept traffic, so the columns exist on a fresh deploy without waiting for the
  // first login to lazily create them. ALTER TABLE ... IF NOT EXISTS is a no-op
  // when the columns are already present.
  const startServer = async () => {
    try {
      console.log('[Startup] Ensuring user profile schema...')
      await ensureUserProfileSchema()
      console.log('[Startup] Schema ready')
    } catch (err) {
      console.error('[Startup] Schema initialization failed:', err.message)
      process.exit(1)
    }

    try {
      await encryptPlaintextMfaSecrets()
    } catch (err) {
      console.warn('[Startup] MFA secret encryption migration skipped:', err.message)
    }

    try {
      await cleanCorruptedSettings()
    } catch (err) {
      console.warn('[Startup] Settings cleanup skipped:', err.message)
    }

    try {
      await loadAiSettings()
      console.log('[Startup] AI settings loaded (decryption failures are non-fatal)')
    } catch (err) {
      console.warn('[Startup] AI settings preload skipped:', err.message)
    }

    appReady = true
    lastDbHealth = { ok: true, checkedAt: Date.now() }
    console.log('[startup] ✅ All startup checks passed — accepting traffic')
    console.log(`[Server] Bound ${HOST}:${PORT} — environment: ${process.env.NODE_ENV || 'development'}`)
    initCloudWatch().catch((err) => console.error('[CloudWatch] Init failed:', err.message))

    // Periodic DB health probe — keeps lastDbHealth fresh for /api/health.
    const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '60000', 10)
    healthTimer = setInterval(async () => {
      try {
        await pool.query('SELECT 1 AS ok')
        lastDbHealth = { ok: true, checkedAt: Date.now() }
      } catch (err) {
        lastDbHealth = { ok: false, checkedAt: Date.now() }
        console.error('[health] Periodic database check failed:', err.message)
      }
    }, HEALTH_CHECK_INTERVAL_MS)
    if (typeof healthTimer.unref === 'function') healthTimer.unref()
  }

  await startServer()

  let shuttingDown = false
  const gracefulShutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] Received ${signal} — closing HTTP server and DB pool…`)
    if (healthTimer) clearInterval(healthTimer)
    server.close(() => {
      if (!pool) {
        process.exit(0)
        return
      }
      pool.end()
        .then(() => {
          console.log('[shutdown] Clean exit')
          process.exit(0)
        })
        .catch((err) => {
          console.error('[shutdown] Pool close error:', err.message)
          process.exit(1)
        })
    })
    setTimeout(() => {
      console.error('[shutdown] Forced exit after 30s')
      process.exit(1)
    }, 30000).unref()
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
} // end bootstrap()

// Kick everything off. Any unhandled bootstrap error is fatal so the process
// supervisor (EB/PM2) restarts cleanly instead of serving a half-initialised app.
bootstrap().catch((err) => {
  logFatal('bootstrap failed', err)
  process.exit(1)
})
