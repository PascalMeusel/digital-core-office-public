import type { EmploymentTerm, User } from './domain.ts'
import { toDateKey } from './dates.ts'

export const defaultTermStartDate = '1970-01-01'

export function fallbackEmploymentTerm(user: Pick<User, 'id' | 'expectedWeeklyMinutes' | 'yearlyVacationDays'>): EmploymentTerm {
  return {
    id: `legacy-${user.id}`,
    effectiveFrom: defaultTermStartDate,
    expectedWeeklyMinutes: user.expectedWeeklyMinutes,
    yearlyVacationDays: user.yearlyVacationDays,
    createdAt: defaultTermStartDate,
  }
}

export function employmentTermsFor(user: Pick<User, 'id' | 'expectedWeeklyMinutes' | 'yearlyVacationDays' | 'employmentTerms'>) {
  const terms = user.employmentTerms?.length ? user.employmentTerms : [fallbackEmploymentTerm(user)]
  return [...terms].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))
}

export function termForDate(
  user: Pick<User, 'id' | 'expectedWeeklyMinutes' | 'yearlyVacationDays' | 'employmentTerms'>,
  dateKey: string,
) {
  const terms = employmentTermsFor(user)
  return terms.reduce((active, term) => (term.effectiveFrom <= dateKey ? term : active), terms[0])
}

export function currentEmploymentTerm(user: Pick<User, 'id' | 'expectedWeeklyMinutes' | 'yearlyVacationDays' | 'employmentTerms'>) {
  return termForDate(user, toDateKey(new Date()))
}
