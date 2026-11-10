import { createHash } from 'node:crypto'
import { readFile, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const appRoot = resolve(import.meta.dirname, '..')
const secrets = resolve(appRoot, 'secrets')
export const packageName = 'de.digitalcoreoffice'
const api = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`
const uploadApi = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}`
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function validateTrack(track) {
  if (typeof track !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(track)
      || /production|REPLACE/i.test(track) || track === 'beta') {
    throw new Error('Configure the coworkers’ closed testing track ID (or internal). Public tracks are disabled.')
  }
  return track
}

export async function loadArtifact(recordPath) {
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  if (record.applicationId !== packageName || record.formatVersion !== 1
      || !Number.isInteger(record.versionCode) || record.versionCode < 1
      || record.versionCode > 2100000000 || !record.versionName) {
    throw new Error('Invalid release record or wrong application ID.')
  }
  const v = record.validation
  if (!(v?.unitTests > 0) || v.unitFailures !== 0 || v.lintErrors !== 0
      || !(v.finalInstrumentation?.tests > 0) || v.finalInstrumentation.failures !== 0
      || v.liveAuthenticated?.passed !== true || !v.aabSignature || !v.bundleStructure) {
    throw new Error('The release record must include passing unit, lint, device, live login, signature and bundle checks.')
  }
  const aabs = record.artifacts?.filter((entry) => entry.name?.endsWith('.aab')) ?? []
  if (aabs.length !== 1 || basename(aabs[0].name) !== aabs[0].name) {
    throw new Error('The release record must identify one adjacent AAB file.')
  }
  const entry = aabs[0]
  const bytes = await readFile(resolve(dirname(recordPath), entry.name))
  const sha256 = hash(bytes)
  if (sha256 !== entry.sha256 || bytes.length !== entry.bytes) {
    throw new Error('The bundle differs from the tested release record. Rebuild and verify it before uploading.')
  }
  return { bytes, sha256, versionCode: record.versionCode, versionName: record.versionName, name: entry.name }
}

export async function loadNotes() {
  return Promise.all([['en-US', 'en'], ['de-DE', 'de']].map(async ([language, suffix]) => {
    const text = (await readFile(resolve(appRoot, `store-listing/release-notes-${suffix}.txt`), 'utf8')).trim()
    if (!text || [...text].length > 500) throw new Error(`Release notes for ${language} must contain 1–500 characters.`)
    return { language, text }
  }))
}

export async function googleRequest() {
  const path = resolve(secrets, 'google-play-service-account.json')
  let credentials
  try { credentials = JSON.parse(await readFile(path, 'utf8')) } catch {
    throw new Error(`Google Play is not connected. Save the service-account JSON key at ${path}.`)
  }
  if (credentials.type !== 'service_account' || !credentials.client_email?.endsWith('.iam.gserviceaccount.com')
      || !credentials.private_key) throw new Error('Expected a Google service-account JSON key.')
  const { JWT } = await import('google-auth-library')
  // Select only service-account fields; credential files cannot override token/API hosts.
  const auth = new JWT({ email: credentials.client_email, key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'] })
  return async (method, url, body) => {
    if (!(url.startsWith(`${api}/`) || url.startsWith(`${uploadApi}/`))) throw new Error('Unexpected Play API destination.')
    let token
    try { token = (await auth.getAccessToken()).token } catch {
      throw new Error('Google authentication failed. Check the service-account key and API setup; credentials were not logged.')
    }
    if (!token) throw new Error('Google did not return an access token.')
    const binary = Buffer.isBuffer(body)
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body) })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { throw new Error(`Google returned non-JSON data (HTTP ${response.status}).`) }
    if (!response.ok) {
      // Never print the auth client, request headers or credential-bearing error objects.
      const error = new Error(`Google Play HTTP ${response.status}: ${String(data.error?.message ?? response.statusText).slice(0, 1500)}`)
      error.httpStatus = response.status
      throw error
    }
    return data
  }
}

function verifyRemoteBundle(remote, artifact) {
  if (Number(remote?.versionCode) !== artifact.versionCode || remote.sha256 !== artifact.sha256) {
    throw new Error('Google’s bundle version/hash does not match the verified local bundle. No release was committed.')
  }
}

export async function runPlay({ request, mode, track, artifact, notes, persist = async () => {} }) {
  if (!['tracks', 'validate', 'publish'].includes(mode)) throw new Error('Unknown Play operation.')
  if (mode !== 'tracks') validateTrack(track)
  let editUrl
  let receipt
  let commitStarted = false
  let committed = false
  let failure
  try {
    const edit = await request('POST', `${api}/edits`, {})
    if (!edit.id) throw new Error('Google did not return an edit ID.')
    editUrl = `${api}/edits/${encodeURIComponent(edit.id)}`
    const listing = await request('GET', `${editUrl}/tracks`)
    const tracks = listing.tracks ?? []
    if (mode === 'tracks') return { packageName, tracks }
    const current = tracks.find((entry) => entry.track === track)
    if (!current) throw new Error(`Track ${track} does not exist. Configure the exact closed track ID from Play Console.`)
    if ((current.releases ?? []).some((release) => release.status !== 'completed')) {
      throw new Error('The test track has a draft, halted or ongoing rollout. Resolve it before replacing its release.')
    }
    const bundles = (await request('GET', `${editUrl}/bundles`)).bundles ?? []
    let remote = bundles.find((bundle) => Number(bundle.versionCode) === artifact.versionCode)
    if (remote) verifyRemoteBundle(remote, artifact)
    const currentCodes = (current.releases ?? []).flatMap((release) => release.versionCodes ?? []).map(Number)
    if (currentCodes.some((code) => code > artifact.versionCode)) throw new Error('A newer version is already on this track; refusing a downgrade.')
    if (remote && currentCodes.includes(artifact.versionCode)) {
      return { state: 'already-on-track', packageName, track, versionCode: artifact.versionCode,
        sha256: artifact.sha256, note: 'Track assignment verified; review and distribution may still be pending.' }
    }
    const knownCodes = [...bundles.map((bundle) => Number(bundle.versionCode)),
      ...tracks.flatMap((entry) => (entry.releases ?? []).flatMap((release) => (release.versionCodes ?? []).map(Number)))]
    if (!remote && knownCodes.some((code) => code >= artifact.versionCode)) {
      throw new Error('Use a new, higher version code and rebuild/retest before uploading.')
    }
    if (!remote) remote = await request('POST', `${uploadApi}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`, artifact.bytes)
    verifyRemoteBundle(remote, artifact)
    await request('PUT', `${editUrl}/tracks/${encodeURIComponent(track)}`, { track, releases: [{
      name: `${artifact.versionName} (${artifact.versionCode})`, status: 'completed',
      versionCodes: [String(artifact.versionCode)], releaseNotes: notes,
    }] })
    await request('POST', `${editUrl}:validate`)
    receipt = { createdAtUtc: new Date().toISOString(), packageName, track,
      versionCode: artifact.versionCode, versionName: artifact.versionName, sha256: artifact.sha256, editId: edit.id }
    if (mode === 'validate') return { ...receipt, state: 'validated-not-committed' }
    await persist({ ...receipt, state: 'committing' })
    commitStarted = true
    // An update must not cancel another release's Google review. No automatic mutation retries.
    await request('POST', `${editUrl}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`)
    committed = true
    receipt = { ...receipt, state: 'committed', note: 'Submitted to Play; Google review/processing and publishing settings still apply.' }
    await persist(receipt)
    return receipt
  } catch (error) {
    failure = error
    if (commitStarted) {
      const state = committed ? 'committed-receipt-write-failed' : 'commit-outcome-needs-check'
      try { await persist({ ...receipt, state }) } catch { /* Original error remains actionable. */ }
      throw new Error(`${committed ? 'Google confirmed the commit, but its local receipt could not be saved.' : 'Commit did not return success. Check Play/track state before retrying.'} ${error.message}`)
    }
    throw error
  } finally {
    // Preserve an edit after an uncertain commit for inspection; never blindly retry it.
    if (editUrl && !commitStarted) {
      try { await request('DELETE', editUrl) } catch (error) {
        if (!failure) throw new Error(`Could not discard temporary Play edit: ${error.message}`)
      }
    }
  }
}

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { record: { type: 'string' } } })
  const mode = positionals[0]
  if (positionals.length !== 1 || !['check', 'tracks', 'validate', 'publish'].includes(mode)) {
    throw new Error('Usage: node android-app/publishing/play.mjs check|tracks|validate|publish [--record <build.json>]')
  }
  if (mode !== 'tracks' && !values.record) throw new Error('--record is required.')
  const artifact = mode === 'tracks' ? undefined : await loadArtifact(resolve(values.record))
  const notes = mode === 'tracks' ? undefined : await loadNotes()
  if (mode === 'check') {
    console.log(JSON.stringify({ state: 'local-check-passed', packageName, name: artifact.name,
      versionCode: artifact.versionCode, sha256: artifact.sha256, releaseNotes: notes }, null, 2))
    return
  }
  let track
  if (mode !== 'tracks') {
    const configPath = resolve(secrets, 'play-publishing.json')
    let config
    try { config = JSON.parse(await readFile(configPath, 'utf8')) } catch {
      throw new Error(`Select the coworkers’ closed test track in ${configPath}; see publishing/config.example.json.`)
    }
    track = validateTrack(config.testTrack)
  }
  await mkdir(secrets, { recursive: true })
  const lockPath = resolve(secrets, 'play-publishing.lock')
  let lock
  try { lock = await open(lockPath, 'wx') } catch { throw new Error('Another Play operation holds the local lock. Check it before removing a stale lock.') }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAtUtc: new Date().toISOString(), mode }))
    const request = await googleRequest()
    const receiptDir = resolve(secrets, 'play-receipts')
    const receiptPath = resolve(receiptDir, `${Date.now()}-${mode}.json`)
    const result = await runPlay({ request, mode, track, artifact, notes, persist: async (receipt) => {
      await mkdir(receiptDir, { recursive: true })
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    } })
    console.log(JSON.stringify(result, null, 2))
  } finally { await lock.close(); await unlink(lockPath) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
