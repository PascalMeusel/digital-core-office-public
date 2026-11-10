import assert from 'node:assert/strict'
import test from 'node:test'
import { operatorPage } from '../server/operatorPages.ts'

test('operator pages use installation settings and escape supplied content', () => {
  const page = operatorPage('privacy', { DCO_OPERATOR_NAME: 'Example <Company>', DCO_OPERATOR_ADDRESS: 'Example Street 1', DCO_SUPPORT_EMAIL: 'support@example.com', DCO_PRIVACY_DETAILS: '<script>alert(1)</script>' })
  assert.match(page, /Example &lt;Company&gt;/)
  assert.doesNotMatch(page, /<script>/)
  assert.match(page, /mailto:support@example.com/)
  assert.doesNotMatch(operatorPage('privacy', {}), /review\.example\.test|Developer Example/)
  assert.match(operatorPage('privacy', {}), /Not configured yet/)
})
