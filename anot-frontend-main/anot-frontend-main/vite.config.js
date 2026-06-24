import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serviceWorkerPath = resolve(__dirname, 'src/service-worker.js')

export default defineConfig({
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
          // Ensure dist directory exists
          mkdirSync(resolve(__dirname, 'dist'), { recursive: true })
          // Copy service worker
          copyFileSync(serviceWorkerPath, resolve(__dirname, 'dist/service-worker.js'))
          console.log('? Service worker copied to dist/')
        } catch (error) {
          console.warn('?? Service worker copy warning:', error.message)
          // Don't fail build if service worker copy fails
        }
      },
    },
  ],
})
