import cors from 'cors'
import express, { type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventoryStaticMediaPath, inventorySystemHealth, inventorySystemRouter } from './inventorySystem.ts'

const app = express()
const port = Number(process.env.PORT ?? 4187)
const host = process.env.HOST ?? '0.0.0.0'
const moduleDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(moduleDir, '..', 'dist')
const indexHtmlPath = join(distDir, 'index.html')
const httpServer = createServer(app)

app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(securityHeaders)
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json({ limit: '8mb' }))

function securityHeaders(_request: Request, response: Response, next: () => void) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'SAMEORIGIN')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'sha256-n1Tw0oCr4hQJLBIQcOVxXTjMsdHr+SxbHKLdlBgg53A='",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' http://localhost:5174 http://127.0.0.1:5174",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  )
  next()
}

function normalizeOrigin(value: string | undefined) {
  return value?.trim().replace(/\/+$/, '')
}

function configuredCorsOrigins() {
  const configured = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return new Set([
    ...configured,
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:4187',
    'http://127.0.0.1:4187',
    'http://asset.localhost',
    'https://asset.localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
    'capacitor://localhost',
    'https://localhost',
  ])
}

function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  const normalizedOrigin = normalizeOrigin(origin)
  callback(null, !normalizedOrigin || configuredCorsOrigins().has(normalizedOrigin))
}

app.get('/api/health', (_request, response) => {
  const health = inventorySystemHealth()
  response.status(health.ok ? 200 : 503).json(health)
})

app.use('/api/inventorySystem', inventorySystemRouter)

// Room plans and location photos persist beside the database, outside Vite's
// disposable build output. Keep packaged media as a fallback for older installs.
app.use('/inventory-media', express.static(inventoryStaticMediaPath, { index: false }), express.static(join(distDir, 'inventory-media'), { index: false }), (_request, response) => {
  response.status(404).json({ message: 'Inventory image not found.' })
})

if (existsSync(indexHtmlPath)) {
  app.use(express.static(distDir, { index: false }))
  app.get(/.*/, (_request, response) => response.sendFile(indexHtmlPath))
}

httpServer.listen(port, host, () => {
  console.log(`Inventory Management API listening on http://${host}:${port}`)
})
