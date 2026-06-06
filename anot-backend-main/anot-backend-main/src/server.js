const express      = require('express')
const cors         = require('cors')
const helmet       = require('helmet')
const dotenv       = require('dotenv')
const rateLimit    = require('express-rate-limit')

dotenv.config()

const jwtSecret = process.env.JWT_SECRET?.trim()
if (!jwtSecret) {
  console.error('FATAL: JWT_SECRET is required.')
  process.exit(1)
}
if (jwtSecret.length < 16 && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET must be at least 16 characters in production.')
  process.exit(1)
}

require('./config/db')

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

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────

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

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// General API limit + stricter limit on auth routes to slow brute-force attempts.

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
})

app.use('/api', apiLimiter)
app.use('/api/auth', authLimiter)

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Local dev origins are always allowed; CORS_ORIGINS adds extra entries (comma-separated).
// The previous /\.vercel\.app$/ regex matched any attacker-deployed *.vercel.app, so it's gone.

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://localhost:3000',
  'https://anot-frontend.vercel.app',
  'https://anot-frontend-git-main-1993alines-projects.vercel.app',
  'https://anot-frontend-5m4fm5c5p-1993alines-projects.vercel.app',
]

if (process.env.CORS_ORIGINS) {
  for (const origin of process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin)
  }
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))

const jsonSmall = express.json({ limit: '2mb' })
const jsonLarge = express.json({ limit: '15mb' })
app.use((req, res, next) => {
  if (String(req.originalUrl || '').startsWith('/api/webhooks')) return jsonLarge(req, res, next)
  return jsonSmall(req, res, next)
})
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// Audio is served only via authorized GET /api/audio/:visitId (not a public /uploads URL).

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: '✅ Anot API is running', version: '1.0.0', status: 'healthy' })
})

// ─── ROUTES ───────────────────────────────────────────────────────────────────

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

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` })
})

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────

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

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000
// Bind IPv4 explicitly so http://127.0.0.1:PORT always hits this process on Windows/WSL.
const HOST = process.env.BIND_HOST || '0.0.0.0'
app.listen(PORT, HOST, () => {
  console.log(`🚀 Anot server running on http://127.0.0.1:${PORT} (bound ${HOST}:${PORT})`)
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`)
})
