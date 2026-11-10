import type { RequestItem } from './domain.ts'

export function balanceDeductionsForRange(requests: RequestItem[], userId: string, startDate: string, endDate: string) {
  return requests.filter((request) => request.userId === userId && request.status === 'approved')
    .flatMap((request) => request.balanceEffects ?? [])
    .filter((effect) => effect.date >= startDate && effect.date <= endDate)
    .reduce((total, effect) => total + effect.minutes, 0)
}
