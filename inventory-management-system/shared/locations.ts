import type { InventoryLocation } from './inventory.ts'

export function locationLabel(location: InventoryLocation | undefined) {
  return location ? (location.code ? `${location.code} · ${location.name}` : location.name) : '-'
}
function pathFromMap(location: InventoryLocation | undefined, byId: Map<string, InventoryLocation>) {
  if (!location) return '-'
  const path: InventoryLocation[] = [], visited = new Set<string>()
  let current: InventoryLocation | undefined = location
  while (current && !visited.has(current.id)) {
    path.unshift(current); visited.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  const labels = path.map(locationLabel)
  // Imported places may retain a room description before their parent is linked.
  if (!path.some(place => place.kind === 'room') && location.roomName) labels.unshift([location.roomCode, location.roomName].filter(Boolean).join(' · '))
  return labels.join(' › ')
}
export function locationPath(location: InventoryLocation | undefined, locations: InventoryLocation[]) {
  return pathFromMap(location, new Map(locations.map(place => [place.id, place])))
}
export function locationPaths(locations: InventoryLocation[]) {
  const byId = new Map(locations.map(place => [place.id, place]))
  return new Map(locations.map(place => [place.id, pathFromMap(place, byId)]))
}
export function locationDescendantIds(locationId: string, locations: InventoryLocation[]) {
  const children = new Map<string, string[]>()
  for (const location of locations) if (location.parentId) children.set(location.parentId, [...(children.get(location.parentId) ?? []), location.id])
  const ids = new Set<string>(), pending = [locationId]
  while (pending.length) {
    const id = pending.pop()!
    if (ids.has(id)) continue
    ids.add(id); pending.push(...(children.get(id) ?? []))
  }
  return ids
}
