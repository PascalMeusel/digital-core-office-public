import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const encryptedPrefix = 'enc:v1:'
let cachedKey: Buffer | undefined
let cachedSecret: string | undefined

function requireEncryption() {
  return process.env.REQUIRE_DATA_ENCRYPTION === 'true'
}

function encryptionSecret() {
  const secret = process.env.DATA_ENCRYPTION_KEY?.trim()
  if (!secret) {
    if (requireEncryption()) {
      throw new Error('DATA_ENCRYPTION_KEY is required when REQUIRE_DATA_ENCRYPTION=true.')
    }
    return undefined
  }

  if (secret.length < 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be at least 32 characters long.')
  }

  return secret
}

function encryptionKey() {
  const secret = encryptionSecret()
  if (!secret) {
    return undefined
  }

  if (!cachedKey || cachedSecret !== secret) {
    cachedSecret = secret
    cachedKey = createHash('sha256').update(secret).digest()
  }

  return cachedKey
}

export function dataEncryptionEnabled() {
  return Boolean(encryptionKey())
}

export function isEncryptedText(value: unknown) {
  return typeof value === 'string' && value.startsWith(encryptedPrefix)
}

export function encryptText(value: string | null | undefined) {
  if (value === null || value === undefined || value === '' || isEncryptedText(value)) {
    return value ?? null
  }

  const key = encryptionKey()
  if (!key) {
    return value
  }

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${encryptedPrefix}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptText(value: string | null | undefined) {
  if (value === null || value === undefined || value === '' || !isEncryptedText(value)) {
    return value ?? null
  }

  const key = encryptionKey()
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY is required to read encrypted data.')
  }

  const [ivPart, tagPart, encryptedPart] = value.slice(encryptedPrefix.length).split(':')
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Encrypted field is malformed.')
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedPart, 'base64')), decipher.final()]).toString('utf8')
}

export function decryptRequiredText(value: string | null | undefined) {
  return decryptText(value) ?? ''
}
