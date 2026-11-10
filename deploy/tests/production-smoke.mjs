import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { combinations, smokeEnvironment, writeEnvironment } from './smoke-config.mjs'

const deploy = resolve(import.meta.dirname, '..')
const selected = process.argv.find((value) => value.startsWith('--modules='))?.slice('--modules='.length) || process.env.DCO_SMOKE_MODULES
const targets = selected ? [selected] : combinations
const buildImages = process.argv.includes('--build-images')
const keepProject = process.argv.includes('--keep-project')
if (keepProject && targets.length !== 1) throw new Error('--keep-project requires one explicit --modules combination')
const services = { time: 'time-tracking', inventory: 'inventory-management', agile: 'agile-project-management' }
const statePaths = { time: '/time/api/state', inventory: '/inventory/api/inventorySystem/state', agile: '/agile/api/agile/workspace' }
const images = { 'core-service': 'dco-launch-audit-core:local', 'time-tracking': 'dco-launch-audit-time:local', 'inventory-management': 'dco-launch-audit-inventory:local', 'agile-project-management': 'dco-launch-audit-agile:local' }

async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { env: options.env, cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk); if (options.stream) process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk); if (options.stream) process.stderr.write(chunk) })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${executable} ${args[0] || ''} failed (${code}): ${stderr || stdout}`)
  return stdout
}

for (const modules of targets) {
  if (!combinations.includes(modules)) throw new Error('Choose a supported canonical module combination')
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolveClosed) => probe.close(resolveClosed))
  const folder = mkdtempSync(join(tmpdir(), 'dco-production-smoke-'))
  const envPath = join(folder, '.env')
  const project = `dco-smoke-${randomBytes(6).toString('hex')}`
  for (const name of ['licenses', 'migration', 'backups', 'secrets']) mkdirSync(join(folder, name))
  const values = { ...smokeEnvironment(modules, port), DCO_BACKUP_DIRECTORY: join(folder, 'backups'), DCO_BACKUP_KEY_FILE: join(folder, 'secrets', 'backup.key') }
  writeFileSync(values.DCO_BACKUP_KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  const env = { ...process.env, ...values }
  writeEnvironment(envPath, values)
  await command(process.execPath, [join(deploy, 'scripts/validate-config.mjs'), envPath], { env })
  const dockerPrefix = process.env.DOCKER_CONTEXT ? ['--context', process.env.DOCKER_CONTEXT] : []
  const original = [...dockerPrefix, 'compose', '-p', project, '--env-file', envPath, '-f', join(deploy, 'compose.yml')]
  const config = JSON.parse(await command('docker', [...original, ...modules.split(',').flatMap(module => ['--profile', module]), '--profile', 'backup', 'config', '--format', 'json'], { env }))
  // New Compose versions apply the profile filter to `config`. Select module
  // profiles explicitly as well as backup, instead of relying on env merging.
  for (const module of modules.split(',')) {
    const name = services[module]
    if (!config.services[name]) throw new Error(`Selected ${name} is missing from the generated configuration`)
  }
  config.name = project
  const expected = new Set(['core-service', 'caddy', ...modules.split(',').map((module) => services[module])])
  for (const [name, service] of Object.entries(config.services)) {
    for (const [key, value] of Object.entries(service)) if (value === null) delete service[key]
    if (name === 'backup') {
      service.image = images['core-service']
      service.restart = 'no'
      continue
    }
    if (!expected.has(name)) { delete config.services[name]; continue }
    delete service.profiles
    service.restart = 'no'
    if (images[name]) service.image = images[name]
  }
  // Keep the production Caddyfile and all routing/auth directives. The isolated
  // loopback smoke gateway uses HTTP on one random port, avoiding public TLS.
  const gateway = config.services.caddy
  gateway.environment.DCO_APP_HOST = `http://127.0.0.1:${port}`
  gateway.ports = [{ target: port, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' }]
  gateway.depends_on = Object.fromEntries([...expected].filter((name) => name !== 'caddy').map((name) => [name, { condition: 'service_started' }]))
  // Never bind private operator/migration material into the synthetic stack.
  for (const volume of config.services['core-service'].volumes || []) {
    if (volume.type === 'bind' && ['/licenses', '/migration'].includes(volume.target)) volume.source = join(folder, volume.target.slice(1))
  }
  const configPath = join(folder, 'compose.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const compose = [...dockerPrefix, 'compose', '-p', project, '--env-file', envPath, '-f', configPath]
  let started = false
  let succeeded = false
  try {
    if (buildImages) await command('docker', [...compose, 'build'], { env, stream: true })
    await command('docker', [...compose, 'up', '-d', '--no-build'], { env })
    started = true
    const base = values.DCO_PUBLIC_BASE_URL
    const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...options, headers: { Origin: base, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
    let ready = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await request('/api/health').then((response) => response.ok).catch(() => false)) { ready = true; break }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    assert.ok(ready, 'Core must start from an empty production volume')
    for (const module of modules.split(',')) {
      let moduleReady = false
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await request(`/${module}/api/health`).then((response) => response.ok).catch(() => false)) { moduleReady = true; break }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      }
      assert.ok(moduleReady, `${module} must start from an empty production volume`)
    }
    async function login(email, password, previousCookie) {
      const result = await request('/api/core/auth/login', { method: 'POST', ...(previousCookie ? { headers: { Cookie: previousCookie } } : {}), body: JSON.stringify({ email, password }) })
      assert.equal(result.status, 200, await result.clone().text())
      const cookie = result.headers.getSetCookie().find((value) => value.startsWith('dco_core_session='))?.split(';')[0]
      assert.ok(cookie, 'Core login must issue its own session cookie')
      return { cookie, payload: await result.json() }
    }
    const adminEmail = values.DCO_INITIAL_ADMIN_EMAIL
    let adminPassword = values.DCO_INITIAL_ADMIN_PASSWORD
    let admin = await login(adminEmail, adminPassword)
    assert.equal(admin.payload.mustChangePassword, true)
    const replacement = 'Changed!SmokePassword2026'
    let result = await request('/api/core/auth/change-password', { method: 'POST', headers: { Cookie: admin.cookie }, body: JSON.stringify({ currentPassword: adminPassword, password: replacement }) })
    assert.equal(result.status, 204, await result.text())
    adminPassword = replacement
    admin = await login(adminEmail, adminPassword)
    const activeModuleIds = admin.payload.modules.filter((module) => module.enabled !== false && module.available !== false && module.allowed !== false).map((module) => module.id)
    for (const module of modules.split(',')) assert.ok(activeModuleIds.includes(module), `${module} should be available to bootstrap admin`)
    for (const module of Object.keys(services)) {
      if (modules.split(',').includes(module)) {
        result = await request(statePaths[module], { headers: { Cookie: admin.cookie, Authorization: 'Bearer obsolete-module-token' } })
        assert.equal(result.status, 200, `${module} state through real Caddy: ${await result.text()}`)
        assert.equal((await request(statePaths[module])).status, 401, `${module} must reject anonymous data reads`)
      } else {
        assert.equal((await request(statePaths[module], { headers: { Cookie: admin.cookie } })).status, 404, `disabled ${module} API must be blocked by the real gateway`)
      }
    }
    const previousAdminCookie = admin.cookie
    admin = await login(adminEmail, adminPassword, previousAdminCookie)
    for (const module of modules.split(',')) {
      assert.equal((await request(statePaths[module], { headers: { Cookie: previousAdminCookie } })).status, 401, `${module} must reject the browser session replaced by a new login`)
      assert.equal((await request(statePaths[module], { headers: { Cookie: admin.cookie } })).status, 200)
    }
    result = await request('/api/core/users', { method: 'POST', headers: { Cookie: admin.cookie }, body: JSON.stringify({ name: 'Smoke Employee', email: 'employee@example.invalid', role: 'employee', password: 'Initial!EmployeePassword2026', memberships: modules.split(',').map((moduleId) => ({ moduleId, role: moduleId === 'inventory' ? 'viewer' : 'employee', active: true })) }) })
    assert.equal(result.status, 201, await result.clone().text())
    const employeeId = (await result.json()).user.id
    let employee = await login('employee@example.invalid', 'Initial!EmployeePassword2026')
    result = await request('/api/core/auth/change-password', { method: 'POST', headers: { Cookie: employee.cookie }, body: JSON.stringify({ currentPassword: 'Initial!EmployeePassword2026', password: 'Changed!EmployeePassword2026' }) })
    assert.equal(result.status, 204)
    employee = await login('employee@example.invalid', 'Changed!EmployeePassword2026')
    for (const module of modules.split(',')) assert.equal((await request(statePaths[module], { headers: { Cookie: employee.cookie } })).status, 200)
    if (modules.split(',').includes('time')) {
      assert.equal((await request('/time/api/clock', { method: 'POST', headers: { Cookie: employee.cookie }, body: '{"action":"start_work"}' })).status, 200)
      assert.equal((await request('/time/api/clock', { method: 'POST', headers: { Cookie: employee.cookie }, body: '{"action":"stop_work"}' })).status, 200)
    }
    if (modules.split(',').includes('inventory')) assert.equal((await request('/inventory/api/inventorySystem/items', { method: 'POST', headers: { Cookie: employee.cookie }, body: '{}' })).status, 403, 'viewer membership must reject inventory writes')
    // Crossing the free user allowance must make module writes read-only while
    // keeping operator administration and data exports available.
    for (let index = 0; index < 9; index += 1) {
      result = await request('/api/core/users', { method: 'POST', headers: { Cookie: admin.cookie }, body: JSON.stringify({ name: `Limit Employee ${index}`, email: `limit-${index}@example.invalid`, role: 'employee', password: 'Initial!LimitPassword2026', memberships: [{ moduleId: modules.split(',')[0], role: modules.split(',')[0] === 'inventory' ? 'viewer' : 'employee', active: true }] }) })
      assert.equal(result.status, 201, await result.clone().text())
    }
    const writePaths = { time: '/time/api/clock', inventory: '/inventory/api/inventorySystem/items', agile: '/agile/api/agile/workspace/commands' }
    const exportPaths = { time: '/time/api/exports/time-csv?period=day&date=2026-09-01', inventory: '/inventory/api/inventorySystem/exports?format=json', agile: '/agile/api/agile/workspace/export' }
    for (const module of modules.split(',')) {
      assert.equal((await request(statePaths[module], { headers: { Cookie: admin.cookie } })).status, 200, `${module} over-limit data must remain readable`)
      assert.equal((await request(exportPaths[module], { headers: { Cookie: admin.cookie } })).status, 200, `${module} over-limit data must remain exportable`)
      assert.equal((await request(writePaths[module], { method: 'POST', headers: { Cookie: admin.cookie }, body: module === 'time' ? '{"action":"start_work"}' : '{}' })).status, 403, `${module} must enforce Core over-limit write protection`)
    }
    result = await request(`/api/core/users/${employeeId}`, { method: 'DELETE', headers: { Cookie: admin.cookie } })
    assert.ok(result.ok, await result.text())
    for (const module of modules.split(',')) assert.equal((await request(statePaths[module], { headers: { Cookie: employee.cookie } })).status, 401, `${module} must honor immediate Core offboarding`)
    if (modules === 'time,inventory,agile') {
      await command(process.execPath, [join(import.meta.dirname, 'backup-recovery-smoke.mjs'), configPath], { env, stream: true })
    }
    succeeded = true
    console.log(`Production smoke passed: ${modules}; empty volumes, forced password change, real gateway, module authorization, over-limit read/export access, shared revocation.`)
  } catch (error) {
    if (started) console.error(await command('docker', [...compose, 'logs', '--no-color', '--tail', '80'], { env }).catch(() => 'Container logs unavailable'))
    throw error
  } finally {
    // This generated project is the only destructive target. No production
    // Compose project, bind-mounted customer data, or global volume is removed.
    assert.match(project, /^dco-smoke-[a-f0-9]{12}$/)
    if (keepProject && succeeded) {
      console.log(JSON.stringify({ retainedProject: project, composeFile: configPath, envFile: envPath, baseUrl: values.DCO_PUBLIC_BASE_URL, modules }, null, 2))
    } else {
      await command('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { env }).catch((error) => console.error(`Smoke cleanup failed for ${project}: ${error.message}`))
    }
  }
}
