import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

// Intentionally separate from JS/CSS verification: a 200 HTML SPA fallback is
// not a successfully deployed plan. Validate each referenced plan and photo.
const [origin, referencePath, mediaDirectory] = process.argv.slice(2)
assert(origin && referencePath && mediaDirectory, 'Usage: node scripts/verifyInventoryMedia.mjs ORIGIN REFERENCE_JSON STATIC_MEDIA_DIRECTORY')
const reference = JSON.parse(readFileSync(referencePath, 'utf8'))
const mediaRoot = resolve(mediaDirectory)
const files = new Set()
function collect(value) {
  if (typeof value === 'string' && value.startsWith('/inventory-media/')) files.add(value)
  else if (Array.isArray(value)) value.forEach(collect)
  else if (value && typeof value === 'object') Object.values(value).forEach(collect)
}
collect(reference)
assert(files.size > 0, 'No inventory media in the supplied reference data')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const path of files) {
  const file = resolve(mediaRoot, path.slice('/inventory-media/'.length))
  assert(file.startsWith(mediaRoot + sep), 'Media path leaves the configured directory')
  const expected = readFileSync(file)
  const response = await fetch(new URL('/inventory' + path, origin), { signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200, 'Image unavailable: ' + path)
  assert.match(response.headers.get('content-type') ?? '', /^image\//, 'Image URL returned non-image content: ' + path)
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(expected), 'Image bytes differ: ' + path)
}
console.log(JSON.stringify({ inventoryMediaVerified: true, images: files.size, plans: reference.rooms?.length ?? 0, contentTypesAndChecksums: true }))
