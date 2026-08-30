// PM2 process configuration for the Anot Health backend.
// Docs: https://pm2.keymetrics.io/docs/usage/application-declaration/
//
// Usage:
//   pm2 start ecosystem.config.js                 (uses default `env`)
//   pm2 start ecosystem.config.js --env production (uses `env_production`)
//
// See deploy/PM2_SETUP.md for the full guide.

module.exports = {
  apps: [
    {
      name: 'anot-backend',
      script: 'src/server.js',

      // Single instance (the app keeps in-memory rate-limit state and is not
      // currently designed for clustered multi-instance scaling).
      instances: 1,
      exec_mode: 'fork',

      // Restart the process automatically if it crashes.
      autorestart: true,

      // Restart if the process exceeds this memory ceiling (guards against leaks).
      max_memory_restart: '500M',

      // Don't watch files in production (use a deploy/restart instead).
      watch: false,

      // Give the app time to boot / shut down cleanly.
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 5000,

      // ── Logs ──────────────────────────────────────────────────────────────
      error_file: 'logs/anot-backend-error.log',
      out_file: 'logs/anot-backend-out.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // ── Environment ───────────────────────────────────────────────────────
      // Default environment (applied with a plain `pm2 start`).
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },

      // Production environment (applied with `--env production`).
      // Secrets (JWT_SECRET, DATABASE_URL, API keys, SENTRY_DSN, etc.) should be
      // provided by the host/.env and NOT committed here.
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
    },
  ],
}
