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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
})
app.use('/api', apiLimiter)

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────

app.use(helmet({
  // We serve audio cross-origin (frontend on Vercel pulls from backend on Railway).
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allowlist is env-driven (CORS_ORIGINS=comma,sep,list). The previous
// /\.vercel\.app$/ regex matched any attacker-deployed *.vercel.app, so it's gone.

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:3000',
  'https://anot-frontend.vercel.app',
  'https://anot-frontend-git-main-1993alines-projects.vercel.app',
  'https://anot-frontend-5m4fm5c5p-1993alines-projects.vercel.app',
]

const allowedOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS)

const allowLocalhostDev =
  process.env.NODE_ENV !== 'production' && !process.env.RAILWAY_ENVIRONMENT

app.use(cors({
  origin: (origin, cb) => {
    // Allow non-browser tools (curl, server-to-server) where Origin is undefined.
    if (!origin) return cb(null, true)
    if (allowLocalhostDev && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return cb(null, true)
    if (allowLocalhostDev && /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error(`CORS: origin not allowed: ${origin}`))
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
