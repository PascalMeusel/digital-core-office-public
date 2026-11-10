import assert from 'node:assert/strict'
import test from 'node:test'
import { createServerClock } from '../src/serverClock.ts'

test('different PC dates produce the same advancing server time, including after a wall-clock change', () => {
  let elapsed = 100, pcA = Date.parse('2026-09-09T09:04:30Z'), pcB = pcA - 86400000
  const a = createServerClock(() => elapsed, () => pcA), b = createServerClock(() => elapsed, () => pcB)
  a.synchronize('2026-09-09T09:04:30Z'); b.synchronize('2026-09-09T09:04:30Z')
  assert.equal(a.now().getTime(), b.now().getTime())
  elapsed += 30000; pcA += 3600000; pcB -= 86400000
  assert.equal(a.now().toISOString(), '2026-09-09T09:05:00.000Z')
  assert.equal(b.now().getTime(), a.now().getTime())
})

test('invalid, duplicated and delayed time samples cannot rewind an already running timer', () => {
  let elapsed = 0
  const clock = createServerClock(() => elapsed, () => 0)
  clock.synchronize('2026-09-09T09:04:30Z'); elapsed = 30000
  for (const value of [undefined, null, '', 'invalid', 123, '2026-09-09T09:04:30Z', '2026-09-09T09:04:00Z']) clock.synchronize(value)
  assert.equal(clock.now().toISOString(), '2026-09-09T09:05:00.000Z')
  clock.synchronize('2026-09-09T09:04:45Z') // A newer sample can still be delayed in transit.
  assert.equal(clock.now().toISOString(), '2026-09-09T09:05:00.000Z')
  clock.synchronize('2026-09-09T09:06:00Z'); elapsed += 10000
  assert.equal(clock.now().toISOString(), '2026-09-09T09:06:10.000Z')
})

test('a fresh server sample updates subscribed displays immediately and removed subscribers stay inactive', () => {
  const clock = createServerClock(() => 0, () => 0), seen: string[] = []
  assert.equal(clock.now().getTime(), 0) // Compatibility before an older backend supplies time.
  const unsubscribe = clock.subscribe(() => seen.push(clock.now().toISOString()))
  clock.synchronize('2026-09-09T09:04:30Z')
  unsubscribe(); clock.synchronize('2026-09-09T09:05:00Z')
  assert.deepEqual(seen, ['2026-09-09T09:04:30.000Z'])
})
