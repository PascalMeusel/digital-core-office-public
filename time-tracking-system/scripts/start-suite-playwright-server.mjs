import { createServer, request as httpRequest } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const timeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suiteRoot = resolve(timeRoot, '..')
const runtimeRoot = join(suiteRoot, '.runtime', 'suite-browser')
const isWindows = process.platform === 'win32'
const npmCommand = isWindows ? 'cmd.exe' : 'npm'
const nodeCommand = process.execPath
const ssoSecret = 'suite-browser-sso-secret-000000000000000000000000'
const internalSecret = 'suite-browser-internal-secret-000000000000000000'
const admin = {
  name: 'Suite Smoke Admin',
  email: 'suite-smoke@example.com',
  password: 'UseAUnique!Temporary2026',
  changedPassword: 'UseAUnique!Changed2026',
}

rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(runtimeRoot, { recursive: true })

function build(project, env) {
  const result = spawnSync(npmCommand, isWindows ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'], {
    cwd: join(suiteRoot, project),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const commonBuild = {
  VITE_ENABLED_MODULES: 'time,inventory,agile',
  VITE_CORE_URL: '/',
}
build('core-service', {})
build('time-tracking-system', {
  ...commonBuild,
  VITE_BASE_PATH: '/time/',
  VITE_API_URL: '/time',
  VITE_INVENTORY_URL: '/inventory',
  VITE_AGILE_URL: '/agile',
})
build('inventory-management-system', {
  ...commonBuild,
  VITE_BASE_PATH: '/inventory/',
  VITE_API_URL: '/inventory',
  VITE_TIME_URL: '/time',
  VITE_AGILE_URL: '/agile',
})
build('agile-project-management-prototype', {
  ...commonBuild,
  VITE_BASE_PATH: '/agile/',
  VITE_API_URL: '/agile',
  VITE_TIME_URL: '/time',
  VITE_INVENTORY_URL: '/inventory',
})

const encryptionKey = Buffer.alloc(64, 7).toString('base64')
const commonRuntime = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  DCO_ENABLED_MODULES: 'time,inventory,agile',
  DCO_CORE_URL: 'http://127.0.0.1:4167',
  DCO_CORE_LOGIN_URL: 'http://127.0.0.1:4300',
  DCO_INTERNAL_AUTH_SECRET: internalSecret,
  DIGITAL_OFFICE_SSO_SECRET: ssoSecret,
  DISABLE_LOCAL_WEB_LOGIN: 'true',
  DCO_TIMEZONE: 'Europe/Berlin',
  TZ: 'Europe/Berlin',
}

const definitions = [
  {
    project: 'core-service',
    port: '4167',
    env: {
      ...commonRuntime,
      PORT: '4167',
      DCO_PUBLIC_BASE_URL: 'http://127.0.0.1:4300',
      DCO_CORE_DATA: join(runtimeRoot, 'core.sqlite'),
      DCO_INITIAL_ADMIN_NAME: admin.name,
      DCO_INITIAL_ADMIN_EMAIL: admin.email,
      DCO_INITIAL_ADMIN_PASSWORD: admin.password,
    },
  },
  {
    project: 'time-tracking-system',
    port: '4177',
    env: {
      ...commonRuntime,
      PORT: '4177',
      TIME_TRACKER_DATA: join(runtimeRoot, 'time.sqlite'),
      TIME_TRACKER_BACKUP_DIR: join(runtimeRoot, 'time-backups'),
      DATA_ENCRYPTION_KEY: encryptionKey,
      REQUIRE_DATA_ENCRYPTION: 'true',
    },
  },
  {
    project: 'inventory-management-system',
    port: '4187',
    env: {
      ...commonRuntime,
      PORT: '4187',
      INVENTORY_SYSTEM_DATA: join(runtimeRoot, 'inventory.sqlite'),
      INVENTORY_REFERENCE_DATA_FILE: '',
    },
  },
  {
    project: 'agile-project-management-prototype',
    port: '4197',
    env: {
      ...commonRuntime,
      PORT: '4197',
      AGILE_PROJECT_DATA: join(runtimeRoot, 'agile.sqlite'),
    },
  },
]

const children = definitions.map((definition) => spawn(nodeCommand, ['--import', 'tsx', 'server/index.ts'], {
  cwd: join(suiteRoot, definition.project),
  env: definition.env,
  stdio: 'inherit',
}))

async function waitForServices() {
  for (const definition of definitions) {
    let ready = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const child = children[definitions.indexOf(definition)]
      if (child.exitCode !== null) throw new Error(`${definition.project} exited during startup (${child.exitCode}).`)
      try {
        const response = await fetch(`http://127.0.0.1:${definition.port}/api/health`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) { ready = true; break }
      } catch {
        // Service is still starting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
    if (!ready) throw new Error(`${definition.project} did not start.`)
  }
}

function targetForPath(pathname) {
  if (['/time', '/time/', '/inventory', '/inventory/', '/agile', '/agile/'].includes(pathname)) {
    return { port: 4167, path: pathname }
  }
  for (const [prefix, port] of [['/time', 4177], ['/inventory', 4187], ['/agile', 4197]]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { port, path: pathname.slice(prefix.length) || '/' }
    }
  }
  return { port: 4167, path: pathname }
}

try {
  await waitForServices()
  const login = await fetch('http://127.0.0.1:4167/api/core/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  })
  if (!login.ok) throw new Error(`Core bootstrap login failed: ${login.status}`)
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith('dco_core_session='))?.split(';')[0]
  if (!cookie) throw new Error('Core bootstrap did not issue a session.')
  const changed = await fetch('http://127.0.0.1:4167/api/core/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: commonRuntime.DCO_CORE_LOGIN_URL },
    body: JSON.stringify({ currentPassword: admin.password, password: admin.changedPassword }),
  })
  if (!changed.ok) throw new Error(`Core bootstrap password change failed: ${changed.status}`)
} catch (error) {
  for (const child of children) child.kill()
  throw error
}

const proxy = createServer((request, response) => {
  const incomingUrl = new URL(request.url ?? '/', 'http://127.0.0.1:4300')
  const target = targetForPath(incomingUrl.pathname)
  const outgoing = httpRequest({
    hostname: '127.0.0.1',
    port: target.port,
    method: request.method,
    path: `${target.path}${incomingUrl.search}`,
    headers: { ...request.headers, host: `127.0.0.1:${target.port}`, 'x-forwarded-host': request.headers.host, 'x-forwarded-proto': 'http' },
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(response)
  })
  outgoing.on('error', (error) => {
    response.statusCode = 502
    response.end(error.message)
  })
  request.pipe(outgoing)
})

proxy.listen(4300, '127.0.0.1')

function shutdown() {
  proxy.close()
  for (const child of children) child.kill()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown)
for (const child of children) child.on('exit', (code) => {
  if (code && code !== 0) {
    shutdown()
    process.exit(code)
  }
})
