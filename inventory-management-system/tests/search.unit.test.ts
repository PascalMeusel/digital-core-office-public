import assert from 'node:assert/strict'
import test from 'node:test'
import { inventorySearchScore } from '../shared/search.ts'

test('search requires every term, across fields, without unrelated fuzzy matches', () => {
  assert.ok(inventorySearchScore('bosch drill', ['Cordless drill', 'Bosch']))
  assert.equal(inventorySearchScore('bosch resistor', ['Cordless drill', 'Bosch']), 0)
  assert.equal(inventorySearchScore('zzzzzz', ['Test device', 'a', 'in_stock']), 0)
  assert.equal(inventorySearchScore('unavailable', ['a', 'new', 'in use']), 0)
  assert.ok(inventorySearchScore('  ', ['Anything']))
})

test('search supports accents, German text, non-Latin names, part numbers and project codes', () => {
  for (const [query, value] of [['grosse', 'Größe'], ['munchen', 'München'], ['stm 32', 'STM-32'], ['C1234', 'LCSC C123456'], ['東京', '東京倉庫'], ['bau 007', 'BAU-007']]) {
    assert.ok(inventorySearchScore(query, [value]), query)
  }
  assert.equal(inventorySearchScore('大阪', ['東京倉庫']), 0)
})
