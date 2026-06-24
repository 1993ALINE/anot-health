import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serviceWorkerPath = resolve(__dirname, 'src/service-worker.js')

// https://vite.dev/config/
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
        copyFileSync(serviceWorkerPath, resolve(__dirname, 'dist/service-worker.js'))
      },
    },
  ],
})
