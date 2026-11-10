import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const origin = process.argv[2]
const enabledModules = new Set((process.env.DCO_ENABLED_MODULES ?? 'time,inventory,agile').split(',').map(value => value.trim()).filter(Boolean))
assert(enabledModules.size && [...enabledModules].every(module => ['time', 'inventory', 'agile'].includes(module)), 'Invalid DCO_ENABLED_MODULES')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const [folder, base] of [
  ['core-service', '/'], ['time-tracking-system', '/time/'],
  ['inventory-management-system', '/inventory/'], ['agile-project-management-prototype', '/agile/'],
]) {
  if (base !== '/' && !enabledModules.has(base.slice(1, -1))) continue
  const localHtml = readFileSync(resolve(root, folder, 'dist/index.html'), 'utf8')
  let html = localHtml
  if (origin) {
    const response = await fetch(new URL(`${base}index.html`, origin), { signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200, `${base}: page unavailable`)
    html = await response.text()
  }
  const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"?]+)"/g)].map(match => match[1])
  assert(assets.some(asset => asset.endsWith('.js')), `${base}: no JavaScript entry`)
  assert(assets.some(asset => asset.endsWith('.css')), `${base}: no stylesheet`)
  for (const asset of assets) {
    assert(asset.startsWith(`${base}assets/`), `${folder}: wrong deployment path ${asset}`)
    const localPath = resolve(root, folder, 'dist', asset.slice(base.length))
    assert(existsSync(localPath), `Missing asset: ${localPath}`)
    if (origin) {
      const response = await fetch(new URL(asset, origin), { signal: AbortSignal.timeout(15000) })
      assert.equal(response.status, 200, `${asset}: unavailable`)
      assert.match(response.headers.get('content-type') ?? '', asset.endsWith('.js') ? /javascript/ : /text\/css/, `${asset}: wrong MIME type`)
      assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(readFileSync(localPath)), `${asset}: deployed content differs`)
    }
  }
  console.log(`${folder}: ${assets.length} assets verified${origin ? ' over HTTPS' : ''}`)
}
