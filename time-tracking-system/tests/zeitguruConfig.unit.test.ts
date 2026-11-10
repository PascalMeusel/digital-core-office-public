import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zeitguruEvaluationEnabled, zeitguruEvaluationOrigin } from '../server/zeitguruConfig.ts'

const company = {
  ZEITGURU_EVALUATION_ENABLED: 'true',
  DCO_CORE_LOGIN_URL: zeitguruEvaluationOrigin,
  DCO_CORE_URL: 'http://127.0.0.1:4167',
  REQUIRE_DATA_ENCRYPTION: 'true',
  DATA_ENCRYPTION_KEY: 'synthetic-encryption-secret-for-test-only',
}

test('Zeitguru evaluation is absent unless explicitly enabled for the company', () => {
  assert.equal(zeitguruEvaluationEnabled({}), false)
  assert.equal(zeitguruEvaluationEnabled({ ...company, ZEITGURU_EVALUATION_ENABLED: 'false' }), false)
  assert.equal(zeitguruEvaluationEnabled(company), true)
})

test('an enabled configuration rejects public review and other deployment origins', () => {
  for (const origin of ['https://review.example.test', 'https://example.org', 'http://office.example.test',
    'https://office.example.test.example.org', 'https://office.example.test:444',
    'https://someone@office.example.test', 'https://office.example.test/other', '']) {
    assert.throws(() => zeitguruEvaluationEnabled({ ...company, DCO_CORE_LOGIN_URL: origin }))
  }
})

test('an enabled configuration requires mandatory encryption and authoritative Core identity', () => {
  assert.throws(() => zeitguruEvaluationEnabled({ ...company, DCO_CORE_URL: '' }))
  assert.throws(() => zeitguruEvaluationEnabled({ ...company, REQUIRE_DATA_ENCRYPTION: 'false' }))
  assert.throws(() => zeitguruEvaluationEnabled({ ...company, DATA_ENCRYPTION_KEY: '' }))
})
