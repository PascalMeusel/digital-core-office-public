import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { isPublicPath, preparePublicRelease } from '../preparePublicRelease.mjs'

test('release allowlist excludes private/runtime content even when Git tracks it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-release-test-'))
  const root = join(directory, 'source')
  mkdirSync(root)
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value) }
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    write('.gitignore', 'node_modules/\n')
    write('README.md', 'Public readme')
    write('core-service/server/index.ts', 'export const publicCode = true')
    write('deploy/.env.example', 'DCO_INTERNAL_AUTH_SECRET=\n')
    for (const path of ['docs/incident-2026-09-22-clock-failures.md', 'docs/unreviewed-notes.md', 'android-app/store-listing/play-review-instructions.md', '.codex-remote-attachments/private.png', 'artifacts/release.tar.gz', 'deploy/.env', 'android-app/local.properties', 'core-service/server/data/users.json', 'inventory-management-system/docs/floorplan.pdf']) write(path, 'private fixture')
    execFileSync('git', ['add', '-f', '.'], { cwd: root })
    const target = join(directory, 'public')
    preparePublicRelease(root, target)
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'Public readme')
    assert.equal(existsSync(join(target, 'deploy/.env.example')), true)
    assert.equal(existsSync(join(target, 'deploy/.env')), false)
    assert.equal(existsSync(join(target, 'artifacts')), false)
    assert.equal(existsSync(join(target, '.codex-remote-attachments')), false)
    assert.equal(existsSync(join(target, 'core-service/server/data/users.json')), false)
    assert.equal(existsSync(join(target, 'docs/incident-2026-09-22-clock-failures.md')), false)
    assert.equal(existsSync(join(target, 'docs/unreviewed-notes.md')), false)
    assert.equal(existsSync(join(target, 'android-app/store-listing/play-review-instructions.md')), false)
    assert.equal(isPublicPath('android-app/secrets/release.jks'), false)
    assert.equal(isPublicPath('deploy/secrets/.env.example'), false)
    assert.equal(isPublicPath('deploy/private-review/.env.example'), false)
    assert.equal(isPublicPath('deploy/scripts/set-suite-admin.mjs'), false)
    assert.equal(isPublicPath('packages/core-client/index.ts'), true)
    assert.equal(isPublicPath('docs/incident-2026-09-22-clock-failures.md'), false)
    assert.equal(isPublicPath('docs/unreviewed-notes.md'), false)
    assert.equal(isPublicPath('docs/day-review.md'), true)
    assert.equal(isPublicPath('android-app/store-listing/play-review-instructions.md'), false)
    assert.equal(isPublicPath('android-app/store-listing/assets/reviewer-inventory-usbc-qr.png'), false)
    assert.equal(isPublicPath('android-app/store-listing/assets/screenshots/company-login.png'), false)
    assert.equal(isPublicPath('android-app/store-listing/release-checklist.md'), false)
    assert.equal(isPublicPath('core-service/artifacts/test-users.json'), false)
    assert.equal(isPublicPath('time-tracking-system/.vite/browser-cache.json'), false)
    assert.throws(() => preparePublicRelease(root, join(root, 'output')), /outside/)
    assert.throws(() => preparePublicRelease(root, target), /empty/)
    const secret = ['gh', 'p_', 'a'.repeat(40)].join('')
    write('core-service/server/large.ts', `// ${'x'.repeat(1024 * 1024 + 10)}\n${secret}`)
    assert.throws(() => preparePublicRelease(root, join(directory, 'rejected')), /embedded secret/)
    assert.equal(existsSync(join(directory, 'rejected')), false)
  } finally {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Unsafe cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
