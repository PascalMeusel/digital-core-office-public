export const mobileServerStorageKey = 'inventorySystem.serverUrl'
export const mobileServerSetupStorageKey = 'inventorySystem.changeServer'

function storageValue(storage: Storage | undefined, key: string) {
  if (!storage) return ''
  try {
    return storage.getItem(key)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function readMobileServerUrl() {
  return storageValue(typeof window === 'undefined' ? undefined : window.localStorage, mobileServerStorageKey)
}

export function writeMobileServerUrl(value: string) {
  window.localStorage.setItem(mobileServerStorageKey, value)
}

export function mobileServerSetupRequested() {
  return storageValue(typeof window === 'undefined' ? undefined : window.sessionStorage, mobileServerSetupStorageKey) === '1'
}

export function requestMobileServerSetup() {
  window.sessionStorage.setItem(mobileServerSetupStorageKey, '1')
}

export function finishMobileServerSetup() {
  window.sessionStorage.removeItem(mobileServerSetupStorageKey)
}

export function normalizeMobileServerUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('empty')

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withProtocol)
  } catch {
    throw new Error('invalid')
  }

  if (url.username || url.password || url.search || url.hash) throw new Error('invalid')
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(localHost && url.protocol === 'http:')) throw new Error('https')

  const pathSegments = url.pathname.split('/').filter(Boolean)
  if (pathSegments.at(-1)?.toLowerCase() !== 'inventory') pathSegments.push('inventory')
  url.pathname = `/${pathSegments.join('/')}`
  return url.toString().replace(/\/$/, '')
}

export function mobileServerDisplayName(value: string) {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return value
  }
}
