import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv, parseQuantity, rowsFromMatrix } from '../server/receivingImport.ts'

test('parses the German semicolon-separated incoming inventory layout', () => {
  const matrix = parseCsv('Datum;Artikel;Menge;Lagerort;Bemerkung;Kürzel\r\n05.01.2026;USB-C Kabel;4 Kartons à 25;DemoStorage box;unbeschädigt;PM')
  const [row] = rowsFromMatrix(matrix, 'incoming.csv', 'Jan26')
  assert.equal(row.receivedAt.slice(0, 10), '2026-01-05')
  assert.equal(row.itemName, 'USB-C Kabel')
  assert.equal(row.quantity, 4)
  assert.equal(row.quantityLabel, '4 Kartons à 25')
  assert.equal(row.locationName, 'DemoStorage box')
  assert.equal(row.receiverLabel, 'PM')
  assert.deepEqual(row.errors, [])
})

test('preserves ambiguous quantities for reconciliation', () => {
  const [row] = rowsFromMatrix([
    ['Date', 'Item', 'Quantity', 'Location'],
    ['2026-01-06', 'Mixed headers', 'several boxes', 'Production'],
  ], 'incoming.xlsx')
  assert.equal(row.quantity, undefined)
  assert.equal(row.quantityLabel, 'several boxes')
  assert.equal(row.warnings.length, 1)
})

test('parses exact numeric and common packaging prefixes', () => {
  assert.equal(parseQuantity('10'), 10)
  assert.equal(parseQuantity('2 pcs in each box'), 2)
  assert.equal(parseQuantity('unknown'), undefined)
})
