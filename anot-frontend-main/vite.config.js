import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { cwd } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serviceWorkerPath = resolve(__dirname, 'src/service-worker.js')

/** Fail the build when production API URL is missing or points at localhost. */
function validateProductionApiUrl(mode) {
  if (mode !== 'production') { return }

  const env = loadEnv(mode, cwd(), '')
  const apiUrl = (env.VITE_API_URL || '').replace(/\/+$/, '')

  if (!apiUrl) {
    throw new Error(
      'VITE_API_URL must be set for production builds (e.g. https://app.anot.health/api). ' +
        'Add it to .env.production or pass it in CI.',
    )
  }

  if (/localhost|127\.0\.0\.1/i.test(apiUrl)) {
    throw new Error(
      `Production build cannot use a localhost API URL (got "${apiUrl}"). ` +
        'Set VITE_API_URL to your production API host.',
    )
  }
}

export default defineConfig(({ mode }) => {
  validateProductionApiUrl(mode)

  return {
    plugins: [
      react(),
      {
        name: 'service-worker',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/service-worker.js') {
              res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
              res.setHeader('Service-Worker-Allowed', '/')
              res.end(readFileSync(serviceWorkerPath))
              return
            }
            next()
          })
        },
        closeBundle() {
          try {
            mkdirSync(resolve(__dirname, 'dist'), { recursive: true })
            copyFileSync(serviceWorkerPath, resolve(__dirname, 'dist/service-worker.js'))
          } catch (error) {
            console.warn('Service worker copy warning:', error.message)
          }
        },
      },
    ],
  }
})
