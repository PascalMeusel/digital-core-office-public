import assert from 'node:assert/strict'
import test from 'node:test'
import type { InventoryLocation } from '../shared/inventory.ts'
import { locationDescendantIds, locationLabel, locationPath, locationPaths } from '../shared/locations.ts'

const place = (id: string, name: string, kind: InventoryLocation['kind'], parentId?: string): InventoryLocation => ({ id, name, code: id.toUpperCase(), kind, parentId, active: true, createdAt: '', updatedAt: '' })
test('room scopes include nested shelves and boxes without including another room with identical names', () => {
  const places = [place('room1', 'Lab', 'room'), place('shelf1', 'Shelf', 'fixture', 'room1'), place('box1', 'Box', 'container', 'shelf1'), place('room2', 'Office', 'room'), place('shelf2', 'Shelf', 'fixture', 'room2'), place('box2', 'Box', 'container', 'shelf2')]
  assert.deepEqual([...locationDescendantIds('room1', places)].sort(), ['box1', 'room1', 'shelf1'])
  assert.deepEqual([...locationDescendantIds('shelf1', places)].sort(), ['box1', 'shelf1'])
  assert.equal(locationPath(places[2], places), 'ROOM1 · Lab › SHELF1 · Shelf › BOX1 · Box')
  assert.equal(locationPaths(places).get('box2'), 'ROOM2 · Office › SHELF2 · Shelf › BOX2 · Box')
  assert.equal(locationLabel(undefined), '-')
})
test('location traversal handles cycles, missing parents, archived descendants and retained room descriptions', () => {
  const places = [place('a', 'Shelf A', 'fixture', 'b'), { ...place('b', 'Box B', 'container', 'a'), active: false }, { ...place('orphan', 'Box', 'container', 'missing'), roomName: 'Soldering room', roomCode: '001' }]
  assert.deepEqual([...locationDescendantIds('a', places)].sort(), ['a', 'b'])
  assert.equal(locationPath(places[0], places), 'B · Box B › A · Shelf A')
  assert.equal(locationPaths(places).get('orphan'), '001 · Soldering room › ORPHAN · Box')
  assert.deepEqual([...locationDescendantIds('missing', places)].sort(), ['missing', 'orphan'])
})
