import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadArtifact, runPlay, validateTrack, packageName } from './play.mjs'

const bytes = Buffer.from('fake bundle for isolated API protocol tests')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const artifact = { bytes, sha256, versionCode: 3, versionName: '1.0.2', name: 'test.aab' }
const notes = [{ language: 'en-US', text: 'Choose your server before sign-in.' }]

function fakeGoogle({ tracks = [{ track: 'alpha', releases: [{ status: 'completed', versionCodes: ['2'] }] },
  { track: 'production', releases: [] }], bundles = [], uploaded = { versionCode: 3, sha256 }, failAt } = {}) {
  const calls = []
  const request = async (method, url, body) => {
    calls.push({ method, url, body })
    if (failAt?.(method, url)) throw new Error('simulated network or API failure')
    if (url.endsWith('/edits')) return { id: 'edit-1' }
    if (url.endsWith('/tracks') && method === 'GET') return { tracks }
    if (url.endsWith('/bundles') && method === 'GET') return { bundles }
    if (url.includes('uploadType=media')) return uploaded
    return {}
  }
  return { calls, request }
}

test('production, form-factor production, open beta and unset tracks are rejected before API access', async () => {
  for (const track of ['production', 'wear:production', 'Production', 'beta', '', '../production', 'REPLACE_WITH_TRACK']) {
    const google = fakeGoogle()
    await assert.rejects(runPlay({ ...google, mode: 'publish', track, artifact, notes }), /Public tracks are disabled/)
    assert.equal(google.calls.length, 0)
  }
  assert.equal(validateTrack('coworkers-closed'), 'coworkers-closed')
})

test('listing tracks creates and discards an edit without publishing', async () => {
  const google = fakeGoogle()
  const result = await runPlay({ ...google, mode: 'tracks' })
  assert.equal(result.packageName, packageName)
  assert.deepEqual(google.calls.map(({ method }) => method), ['POST', 'GET', 'DELETE'])
})

test('publish verifies the upload, validates, preserves other tracks and does not cancel existing reviews', async () => {
  const google = fakeGoogle()
  const receipts = []
  const result = await runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes,
    persist: async (receipt) => receipts.push(receipt) })
  assert.equal(result.state, 'committed')
  assert.deepEqual(receipts.map(({ state }) => state), ['committing', 'committed'])
  assert.equal(google.calls.filter(({ url }) => url.includes('uploadType=media')).length, 1)
  const updates = google.calls.filter(({ method }) => method === 'PUT')
  assert.equal(updates.length, 1)
  assert.ok(updates[0].url.endsWith('/tracks/alpha'))
  assert.deepEqual(updates[0].body.releases[0].versionCodes, ['3'])
  assert.equal(updates[0].body.releases[0].status, 'completed')
  assert.match(google.calls.at(-2).url, /:validate$/)
  assert.match(google.calls.at(-1).url, /:commit\?changesInReviewBehavior=ERROR_IF_IN_REVIEW$/)
})

test('server validation discards the edit without committing', async () => {
  const google = fakeGoogle()
  const result = await runPlay({ ...google, mode: 'validate', track: 'alpha', artifact, notes })
  assert.equal(result.state, 'validated-not-committed')
  assert.equal(google.calls.at(-1).method, 'DELETE')
  assert.ok(!google.calls.some(({ url }) => url.includes(':commit')))
})

test('a failed validate never reaches commit and discards the edit', async () => {
  const google = fakeGoogle({ failAt: (_, url) => url.endsWith(':validate') })
  await assert.rejects(runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes }))
  assert.equal(google.calls.at(-1).method, 'DELETE')
  assert.ok(!google.calls.some(({ url }) => url.includes(':commit')))
})

test('uncertain commit is recorded, not retried or deleted', async () => {
  const google = fakeGoogle({ failAt: (_, url) => url.includes(':commit') })
  const receipts = []
  await assert.rejects(runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes,
    persist: async (receipt) => receipts.push(receipt) }), /Check Play\/track state before retrying/)
  assert.equal(google.calls.filter(({ url }) => url.includes(':commit')).length, 1)
  assert.ok(!google.calls.some(({ method }) => method === 'DELETE'))
  assert.equal(receipts.at(-1).state, 'commit-outcome-needs-check')
})

test('failure to write the pre-commit receipt prevents commit', async () => {
  const google = fakeGoogle()
  await assert.rejects(runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes,
    persist: async () => { throw new Error('disk unavailable') } }), /disk unavailable/)
  assert.ok(!google.calls.some(({ url }) => url.includes(':commit')))
  assert.equal(google.calls.at(-1).method, 'DELETE')
})

test('repeating an already assigned identical bundle does not upload or commit again', async () => {
  const google = fakeGoogle({ tracks: [{ track: 'alpha', releases: [{ status: 'completed', versionCodes: ['3'] }] }],
    bundles: [{ versionCode: 3, sha256 }] })
  const result = await runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes })
  assert.equal(result.state, 'already-on-track')
  assert.ok(!google.calls.some(({ url, method }) => url.includes('uploadType') || url.includes(':commit') || method === 'PUT'))
})

test('a matching bundle already in Play can be assigned without another upload', async () => {
  const google = fakeGoogle({ bundles: [{ versionCode: 3, sha256 }] })
  await runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes })
  assert.ok(!google.calls.some(({ url }) => url.includes('uploadType')))
  assert.ok(google.calls.some(({ url }) => url.includes(':commit')))
})

test('version conflicts and hash mismatches cannot produce a release', async () => {
  for (const setup of [
    { bundles: [{ versionCode: 3, sha256: 'wrong' }] },
    { bundles: [{ versionCode: 4, sha256 }] },
    { uploaded: { versionCode: 3, sha256: 'wrong' } },
    { uploaded: { versionCode: 4, sha256 } },
    { tracks: [{ track: 'alpha', releases: [{ status: 'completed', versionCodes: ['4'] }] }] },
  ]) {
    const google = fakeGoogle(setup)
    await assert.rejects(runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes }))
    assert.ok(!google.calls.some(({ method }) => method === 'PUT'))
    assert.equal(google.calls.at(-1).method, 'DELETE')
  }
})

test('missing tracks and unfinished rollouts are preserved', async () => {
  for (const releases of [undefined, [{ status: 'draft' }], [{ status: 'inProgress' }], [{ status: 'halted' }]]) {
    const google = fakeGoogle({ tracks: releases ? [{ track: 'alpha', releases }] : [] })
    await assert.rejects(runPlay({ ...google, mode: 'publish', track: 'alpha', artifact, notes }))
    assert.ok(!google.calls.some(({ method }) => method === 'PUT'))
    assert.ok(!google.calls.some(({ url }) => url.includes('uploadType')))
  }
})

test('local preflight rejects changed artifacts, wrong apps and failed acceptance records', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dco-play-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const record = { formatVersion: 1, applicationId: packageName, versionCode: 3, versionName: '1.0.2',
    validation: { unitTests: 8, unitFailures: 0, lintErrors: 0, finalInstrumentation: { tests: 8, failures: 0 },
      liveAuthenticated: { passed: true }, aabSignature: 'verified', bundleStructure: 'validated' },
    artifacts: [{ name: 'test.aab', bytes: bytes.length, sha256 }] }
  const path = join(dir, 'test.build.json')
  await writeFile(join(dir, 'test.aab'), bytes)
  await writeFile(path, JSON.stringify(record))
  assert.equal((await loadArtifact(path)).sha256, sha256)
  await writeFile(join(dir, 'test.aab'), 'changed')
  await assert.rejects(loadArtifact(path), /differs from the tested release/)
  await writeFile(join(dir, 'test.aab'), bytes)
  await writeFile(path, JSON.stringify({ ...record, applicationId: `${packageName}.debug` }))
  await assert.rejects(loadArtifact(path), /wrong application/)
  await writeFile(path, JSON.stringify({ ...record, validation: { ...record.validation, unitFailures: 1 } }))
  await assert.rejects(loadArtifact(path), /passing unit/)
})
