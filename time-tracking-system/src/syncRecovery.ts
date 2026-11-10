/** Only failed reads are retried. Clock writes must never be replayed automatically. */
export function syncRetryDelay(failures: number) {
  return Math.min(15_000, 2_000 * 2 ** Math.min(Math.max(0, failures - 1), 3))
}

export function isDefinitiveActionRejection(error: unknown) {
  if (!(error instanceof Error) || !('status' in error)) return false
  const status = Number(error.status)
  return status >= 400 && status < 500 && status !== 408
}
