import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const privateKeyPath = resolve(process.argv[2] ?? '../deploy/private-licenses/license-signing-private.pem')
const publicKeyPath = resolve(process.argv[3] ?? '../deploy/licenses/license-public.pem')

if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
  console.error('Refusing to overwrite an existing license signing key. Pass unused paths to rotate deliberately.')
  process.exit(2)
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
mkdirSync(dirname(privateKeyPath), { recursive: true })
mkdirSync(dirname(publicKeyPath), { recursive: true })
writeFileSync(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
writeFileSync(publicKeyPath, publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 })
console.log(`Created a private signing key at ${privateKeyPath}; keep it offline and never commit it.`)
console.log(`Created the distributable public verification key at ${publicKeyPath}.`)
