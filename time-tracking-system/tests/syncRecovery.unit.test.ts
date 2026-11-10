import assert from 'node:assert/strict'
import test from 'node:test'
import { isDefinitiveActionRejection, syncRetryDelay } from '../src/syncRecovery.ts'

test('read failures retry promptly with a bounded backoff', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 100].map(syncRetryDelay), [2000, 4000, 8000, 15000, 15000, 15000])
})

test('server rejections do not masquerade as a lost connection', () => {
  for (const status of [400, 401, 403, 409, 422, 429]) {
    assert.equal(isDefinitiveActionRejection(Object.assign(new Error('Rejected'), { status })), true)
  }
  for (const error of [new TypeError('Failed to fetch'), new Error('Timeout'), Object.assign(new Error('Timeout'), { status: 408 }), Object.assign(new Error('Unavailable'), { status: 503 })]) {
    assert.equal(isDefinitiveActionRejection(error), false)
  }
})
