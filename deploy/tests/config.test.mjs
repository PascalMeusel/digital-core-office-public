import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import { combinations, smokeEnvironment, writeEnvironment } from './smoke-config.mjs'
const deploy = resolve(import.meta.dirname, '..')

for (const modules of combinations) {
  test(`deployment validator accepts ${modules} with no key for disabled Time`, () => {
    const folder = mkdtempSync(join(tmpdir(), 'dco-config-'))
    const path = join(folder, '.env')
    const values = smokeEnvironment(modules)
    writeEnvironment(path, values)
    const checked = spawnSync(process.execPath, [join(deploy, 'scripts/validate-config.mjs'), path], { env: { ...process.env, ...values }, encoding: 'utf8', windowsHide: true })
    assert.equal(checked.status, 0, checked.stderr)
    if (!modules.includes('time')) assert.equal(values.TIME_DATA_ENCRYPTION_KEY, '')
    if (process.env.DCO_TEST_DOCKER_CONFIG === 'true') {
      const docker = spawnSync('docker', [...(process.env.DOCKER_CONTEXT ? ['--context', process.env.DOCKER_CONTEXT] : []), 'compose', '--env-file', path, '-f', join(deploy, 'compose.yml'), 'config', '--services'], { env: { ...process.env, ...values }, encoding: 'utf8', windowsHide: true })
      assert.equal(docker.status, 0, docker.stderr)
      const services = new Set(docker.stdout.trim().split(/\r?\n/))
      assert.deepEqual(services, new Set(['core-service', 'caddy', ...modules.split(',').map((module) => ({ time: 'time-tracking', inventory: 'inventory-management', agile: 'agile-project-management' })[module])]))
    }
  })
}

test('deployment validator rejects enabling Time without an encryption key', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dco-config-'))
  const path = join(folder, '.env')
  const values = { ...smokeEnvironment('time'), TIME_DATA_ENCRYPTION_KEY: '' }
  writeEnvironment(path, values)
  const checked = spawnSync(process.execPath, [join(deploy, 'scripts/validate-config.mjs'), path], { env: { ...process.env, ...values }, encoding: 'utf8', windowsHide: true })
  assert.equal(checked.status, 1)
  assert.match(checked.stderr, /TIME_DATA_ENCRYPTION_KEY/)
})
