import { readFileSync, writeFileSync } from 'node:fs'
import { createPrivateKey, sign } from 'node:crypto'
import { resolve } from 'node:path'
import { canonicalJson, type LicensePayload } from '../server/core.ts'

const payloadPath = process.argv[2]
const privateKeyPath = process.argv[3] ?? process.env.DCO_LICENSE_PRIVATE_KEY_FILE
const outputPath = process.argv[4]

if (!payloadPath || !privateKeyPath) {
  console.error('Usage: npm run license:issue -- payload.json private-key.pem [output.txt]')
  process.exit(2)
}

const payload = JSON.parse(readFileSync(resolve(payloadPath), 'utf8')) as LicensePayload
const privateKey = createPrivateKey(readFileSync(resolve(privateKeyPath), 'utf8'))
const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url')
const licenseKey = `DCO-${Buffer.from(JSON.stringify({ payload, signature })).toString('base64url')}`

if (outputPath) {
  writeFileSync(resolve(outputPath), `${licenseKey}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(`Wrote signed license ${payload.licenseId} to ${resolve(outputPath)}.`)
} else {
  console.log(licenseKey)
}
