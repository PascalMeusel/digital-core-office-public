import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import type { StatePayload } from '../shared/domain.ts'
import { fadeOutSuiteBoot, waitForSuiteBootMinimum } from '@digital-core-office/suite-ui/boot'

const appBasePath = import.meta.env.BASE_URL
const configuredApiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const apiBase =
  configuredApiBase || (import.meta.env.PROD ? appBasePath.replace(/\/$/, '') : 'http://localhost:4177')
const authTokenStorageKey = 'time-tracker-token'

function appBaseUrlPath() {
  const base = new URL(appBasePath, window.location.origin).pathname
  return base.endsWith('/') ? base : `${base}/`
}

function appRelativePath() {
  const base = appBaseUrlPath()
  const path = window.location.pathname
  const baseWithoutSlash = base.replace(/\/+$/, '')
  if (baseWithoutSlash && path === baseWithoutSlash) {
    return ''
  }
  if (base !== '/' && path.startsWith(base)) {
    return path.slice(base.length).replace(/^\/+/, '')
  }
  if (baseWithoutSlash && path.startsWith(`${baseWithoutSlash}/`)) {
    return path.slice(baseWithoutSlash.length + 1).replace(/^\/+/, '')
  }
  return path.replace(/^\/+/, '')
}

function routeNeedsPublicAuthScreen() {
  const firstSegment = appRelativePath().split('/').filter(Boolean)[0]
  return firstSegment === 'invite' || firstSegment === 'reset'
}

function storedAuthToken() {
  return localStorage.getItem(authTokenStorageKey) ?? sessionStorage.getItem(authTokenStorageKey) ?? ''
}

function clearStoredAuthToken() {
  localStorage.removeItem(authTokenStorageKey)
  sessionStorage.removeItem(authTokenStorageKey)
}

async function loadInitialState() {
  if (routeNeedsPublicAuthScreen()) {
    return undefined
  }

  const token = storedAuthToken()
  if (!token) {
    return undefined
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${apiBase}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response.status === 401) {
      clearStoredAuthToken()
      return undefined
    }
    if (!response.ok) {
      return undefined
    }
    return (await response.json()) as StatePayload
  } catch {
    return undefined
  } finally {
    window.clearTimeout(timeout)
  }
}

async function bootstrap() {
  const rootElement = document.getElementById('root')!
  document.title = 'Digital Core Office Time'
  const initialState = await loadInitialState()
  await waitForSuiteBootMinimum()
  await fadeOutSuiteBoot(rootElement)
  rootElement.removeAttribute('data-booting')
  rootElement.removeAttribute('data-boot-exit')

  createRoot(rootElement).render(
    <StrictMode>
      <App initialState={initialState} />
    </StrictMode>,
  )
}

void bootstrap()
