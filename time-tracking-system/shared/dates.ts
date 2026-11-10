export const minutesPerHour = 60
export const dayMs = 24 * 60 * 60 * 1000
export const sensibleDateYearMin = 2000
export const sensibleDateFutureYears = 5
let configuredTimezone = 'Europe/Berlin'

export function setOrganizationTimezone(value: string) {
  new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date())
  configuredTimezone = value
}

export function organizationTimezone() {
  return configuredTimezone
}

export function businessDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: configuredTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function businessTimeMinutes(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: configuredTimezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(date)
  return Number(parts.find((item) => item.type === 'hour')!.value) * 60 + Number(parts.find((item) => item.type === 'minute')!.value)
}

export function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function padYear(value: number) {
  return String(value).padStart(4, '0')
}

export function toDateKey(date: Date) {
  return `${padYear(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function dateKeyParts(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) {
    return undefined
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

export function parseDateKey(dateKey: string) {
  const parts = dateKeyParts(dateKey) ?? { year: 1970, month: 1, day: 1 }
  const date = new Date(0)
  date.setFullYear(parts.year, parts.month - 1, parts.day)
  date.setHours(0, 0, 0, 0)
  return date
}

export function isValidDateKey(dateKey: string) {
  const parts = dateKeyParts(dateKey)
  if (!parts || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    return false
  }

  const date = parseDateKey(dateKey)
  return date.getFullYear() === parts.year && date.getMonth() === parts.month - 1 && date.getDate() === parts.day
}

export function sensibleDateYearMax(referenceDate = new Date()) {
  return referenceDate.getFullYear() + sensibleDateFutureYears
}

export function sensibleDateBounds(referenceDate = new Date()) {
  return {
    min: `${sensibleDateYearMin}-01-01`,
    max: `${sensibleDateYearMax(referenceDate)}-12-31`,
  }
}

export function isSensibleDateKey(dateKey: string, referenceDate = new Date()) {
  const parts = dateKeyParts(dateKey)
  return Boolean(parts && isValidDateKey(dateKey) && parts.year >= sensibleDateYearMin && parts.year <= sensibleDateYearMax(referenceDate))
}

export function addDays(dateKey: string, days: number) {
  const date = parseDateKey(dateKey)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

export function dateKeysBetween(startDate: string, endDate: string) {
  const dates: string[] = []
  const cursor = parseDateKey(startDate)
  const end = parseDateKey(endDate)

  while (cursor <= end) {
    dates.push(toDateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  return dates
}

export function isWeekend(dateKey: string) {
  const day = parseDateKey(dateKey).getDay()
  return day === 0 || day === 6
}

export function isoFromDateAndTime(dateKey: string, time: string) {
  if (!isValidDateKey(dateKey) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid date or time')
  const { year, month, day } = dateKeyParts(dateKey)!
  const [hours, minutes] = time.split(':').map(Number)
  const wallTime = Date.UTC(year, month - 1, day, hours, minutes)
  let timestamp = wallTime
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: configuredTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(timestamp))
    const part = (type: string) => Number(parts.find((item) => item.type === type)!.value)
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'))
    const next = timestamp + wallTime - represented
    if (next === timestamp) break
    timestamp = next
  }
  const date = new Date(timestamp)
  if (businessDateKey(date) !== dateKey || businessTimeMinutes(date) !== hours * 60 + minutes) {
    throw new Error('This local time does not exist because of a daylight-saving transition')
  }
  return date.toISOString()
}

export function startOfWeek(date: Date) {
  const copy = new Date(date)
  const day = copy.getDay() || 7
  copy.setDate(copy.getDate() - day + 1)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function endOfWeek(date: Date) {
  const copy = startOfWeek(date)
  copy.setDate(copy.getDate() + 6)
  copy.setHours(23, 59, 59, 999)
  return copy
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
}

export function startOfYear(date: Date) {
  return new Date(date.getFullYear(), 0, 1)
}

export function endOfYear(date: Date) {
  return new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999)
}

export function clampDateRange(start: Date, end: Date) {
  return [toDateKey(start), toDateKey(end)] as const
}

export function formatMinutes(minutes: number) {
  const sign = minutes < 0 ? '-' : ''
  const absolute = Math.abs(Math.round(minutes))
  const hours = Math.floor(absolute / 60)
  const mins = absolute % 60
  return `${sign}${hours}:${pad2(mins)}`
}

export function formatDecimalHours(minutes: number) {
  return (minutes / 60).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })
}
