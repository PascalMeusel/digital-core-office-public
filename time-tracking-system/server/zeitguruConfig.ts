/** ExampleCompany evaluation only. This is not a generally available integration. */
export const zeitguruEvaluationOrigin = 'https://office.example.test'
export const zeitguruLoginOrigin = 'https://web.zeitguru.de'

export function zeitguruEvaluationEnabled(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.ZEITGURU_EVALUATION_ENABLED !== 'true') return false
  let origin: URL
  try {
    origin = new URL(environment.DCO_CORE_LOGIN_URL ?? '')
  } catch {
    throw new Error('Zeitguru evaluation requires the ExampleCompany Core login origin.')
  }
  if (origin.origin !== zeitguruEvaluationOrigin || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/') {
    throw new Error('Zeitguru evaluation is restricted to the ExampleCompany company installation.')
  }
  if (!environment.DCO_CORE_URL?.trim()) {
    throw new Error('Zeitguru evaluation requires centralized Core account authentication.')
  }
  if (environment.REQUIRE_DATA_ENCRYPTION !== 'true' || (environment.DATA_ENCRYPTION_KEY?.trim().length ?? 0) < 32) {
    throw new Error('Zeitguru evaluation requires configured mandatory data encryption.')
  }
  return true
}
