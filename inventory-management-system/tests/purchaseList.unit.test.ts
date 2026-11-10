import assert from 'node:assert/strict'
import test from 'node:test'
import { previewPurchaseList, type PurchasePart } from '../shared/purchaseList.ts'

const parts: PurchasePart[] = [
  { id: 'pcb', itemId: 'pcb', name: 'DemoDevice ESP PCB', sku: 'DEMO-ESP', unit: 'pcs', active: true },
  { id: 'mat', itemId: 'mat', name: 'Mat material', sku: 'DEMO-MAT', unit: 'm²', active: true },
  { id: 'old', itemId: 'old', name: 'Old board', sku: 'OLD-1', unit: 'pcs', active: false },
]
const preview = (text: string, quantities: Record<string, string> = {}, extra = parts) => previewPurchaseList(text, extra, quantities)
const valid = (result: ReturnType<typeof preview>) => { assert.deepEqual(result.errors, []); assert(result.rows.every(row => !row.errors.length), JSON.stringify(result)); return result.rows }

test('pasted Excel and German CSV distinguish catalog references, new parts, square metres and EUR prices', () => {
  const rows = valid(preview('Artikel\tMenge\tEinheit\tLink\tPreis EUR\nDEMO-ESP\t4\tpcs\thttps://example.com/pcb\t0,125\nMat material\t2,5\tm2\nNew experimental sensor\t3\tpcs\thttps://example.com/new\t12.50'))
  assert.equal(rows[0].partId, 'pcb'); assert.equal(rows[0].name, 'DemoDevice ESP PCB'); assert.equal(rows[0].estimatedUnitCost, 0.125)
  assert.equal(rows[1].quantity, 2.5); assert.equal(rows[1].unit, 'm²'); assert.equal(rows[1].partId, 'mat')
  assert.equal(rows[2].partId, undefined); assert.equal(rows[2].estimatedUnitCost, 12.5)
  assert.equal(valid(preview('Artikel;Menge;Einheit;Preis EUR\nMat material;1,25;m²;2,50'))[0].quantity, 1.25)
  assert.equal(valid(preview('DEMO-ESP\t2\nNew cable\t4'))[0].partId, 'pcb')
  assert.equal(valid(preview('SKU,Quantity\nDEMO-ESP,2'))[0].partId, 'pcb')
})

test('quoted cells, comma delimiters, embedded newlines and escaped quotes preserve article names', () => {
  const rows = valid(preview('Name,Quantity,Unit,Link\r\n"Sensor, external",2,pcs,https://example.com\r\n"Case ""small""",1,pcs,\r\n"Cable\nRS485",3,pcs,'))
  assert.equal(rows.length, 3); assert.equal(rows[0].name, 'Sensor, external'); assert.equal(rows[1].name, 'Case "small"'); assert.equal(rows[2].name, 'Cable\nRS485')
  assert(preview('Name;Quantity\n"Unclosed;1').errors.length)
  assert(preview('Name;Quantity\n"Closed"extra;1').errors.length)
})

test('ragged CSV cannot silently truncate decimal quantities or omit supplier links', () => {
  for (const text of [
    'Artikel,Menge\nMat material,2,5',
    'Artikel;Menge\nNew cable;2;https://example.com/cable',
    'New cable\t2\tpcs\thttps://example.com\t1\textra',
  ]) assert(preview(text).rows[0].errors.some(error => error.includes('More columns')), text)
  assert.equal(valid(preview('Artikel,Menge\nMat material,"2,5"'))[0].quantity, 2.5)
  assert.equal(valid(preview('Artikel;Menge\nMat material;2,5'))[0].quantity, 2.5)
  assert.equal(valid(preview('Artikel\tMenge\nMat material\t2,5\t\t'))[0].quantity, 2.5, 'Empty trailing spreadsheet cells are harmless')
})

test('repeated parts combine explicitly, while conflicting links, units and prices block import', () => {
  const rows = valid(preview('Name;Quantity;Unit;Price EUR\nDEMO-ESP;2;pcs;2,50\nDemoDevice ESP PCB;3;pcs;2,50\nNew cable;1;pcs;\nnew cable;2;pcs;'))
  assert.equal(rows.length, 2); assert.equal(rows[0].quantity, 5); assert.deepEqual(rows[0].rows, [2, 3]); assert.equal(rows[1].quantity, 3)
  for (const text of [
    'Name;Quantity;Link\nDEMO-ESP;1;https://one.test\nDEMO-ESP;1;https://two.test',
    'Name;Quantity;Price EUR\nDEMO-ESP;1;2\nDEMO-ESP;1;3',
    'Name;Quantity;Unit\nNew part;1;pcs\nNew part;1;m²',
    'Name;Quantity\nNew part;1000000000\nNew part;1',
  ]) assert(preview(text).rows.some(row => row.errors.length), text)
})

test('existing selections and the unfinished new-part entry are preserved', () => {
  const before = { pcb: '4' }, result = previewPurchaseList('Name;Quantity\nDEMO-ESP;2\nNew cable;3\nMat material;0,5', parts, before, { pendingName: 'New cable' })
  assert.deepEqual(before, { pcb: '4' }); const rows = valid(result)
  assert(rows[0].alreadySelected); assert(rows[1].alreadySelected); assert.equal(rows[2].alreadySelected, false)
  const custom = { id: 'custom', name: 'Custom cable', unit: 'pcs' }
  assert.equal(valid(preview('Custom cable\t2', {}, [...parts, custom]))[0].partId, 'custom')
})

test('ambiguous or archived catalog matches, conflicting units and unknown SKU fields need correction', () => {
  for (const text of [
    'Artikel;Menge;Einheit\nMat material;2;pcs',
    'Artikel;Menge\nOld board;2',
    'SKU;Menge\nUNKNOWN-1;2',
    'Name;SKU;Menge\nMat material;DEMO-ESP;2',
    'Artikel;Menge;Einheit\nNew part;2;invalid',
  ]) assert(preview(text).rows.some(row => row.errors.length), text)
  assert(preview('DemoDevice ESP PCB\t2', {}, [...parts, { id: 'duplicate', name: parts[0].name, unit: 'pcs' }]).rows[0].errors.length)
  assert.equal(valid(preview('SKU;Quantity\nDEMO-ESP;2', {}, [...parts, { id: 'duplicate', name: parts[0].name, unit: 'pcs' }]))[0].partId, 'pcb')
})

test('reject invalid quantities, unsafe links, ambiguous prices, duplicate headers and excessive lists', () => {
  for (const quantity of ['0', '-1', '1e3', 'NaN', '1.000,50', '1,000.50', '0.0000001', '1000000001', '']) assert(preview(`Artikel;Menge\nNew part;${quantity}`).rows[0].errors.length, quantity)
  for (const link of ['javascript:alert(1)', 'https://user:secret@example.test/', 'not-a-link']) assert(preview(`Artikel;Menge;Link\nNew part;1;${link}`).rows[0].errors.length, link)
  for (const price of ['2€', '$3', '1.000,50', '-1', 'Infinity']) assert(preview(`Artikel;Menge;Preis EUR\nNew part;1;${price}`).rows[0].errors.length, price)
  assert(preview('Artikel;Name;Menge\nA;B;1').errors.length)
  assert(preview('Artikel;Einheit\nA;pcs').errors.length)
  assert(preview('Name;Quantity\n' + Array.from({ length: 101 }, (_, i) => `Part ${i};1`).join('\n')).errors.length)
  const selected = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`id-${i}`, '1']))
  assert(preview('New part\t1', selected).errors.length)
  assert(preview('a'.repeat(200001)).errors.length)
})
