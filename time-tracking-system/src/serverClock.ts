/** Server time advances with elapsed browser time, independently of the PC's date or clock. */
export function createServerClock(monotonicNow = () => performance.now(), wallNow = () => Date.now()) {
  let sample: { utc: number; received: number } | undefined
  const listeners = new Set<() => void>()
  return {
    now() {
      return new Date(sample ? sample.utc + Math.max(0, monotonicNow() - sample.received) : wallNow())
    },
    synchronize(timestamp: unknown) {
      if (typeof timestamp !== 'string') return
      const utc = Date.parse(timestamp)
      // Delayed responses and repeated renders must not rewind an advancing timer.
      if (!Number.isFinite(utc) || (sample && utc <= sample.utc)) return
      const received = monotonicNow()
      sample = { utc: sample ? Math.max(utc, sample.utc + Math.max(0, received - sample.received)) : utc, received }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const serverClock = createServerClock()
