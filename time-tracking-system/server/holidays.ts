import { randomUUID } from 'node:crypto'
import Holidays from 'date-holidays'
import type { HolidaysTypes } from 'date-holidays'
import type { Holiday, HolidayOverride, HolidaySettings, HolidayTemplateOption, HolidayTemplateOptions } from '../shared/domain.ts'
import { toDateKey } from '../shared/dates.ts'

export const defaultHolidaySettings: HolidaySettings = {
  country: 'DE',
  state: 'NW',
  language: 'de',
}

function asOptions(values: Record<string, string> | undefined): HolidayTemplateOption[] {
  return Object.entries(values ?? {})
    .map(([code, name]) => ({ code, name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function normalizeHolidaySettings(settings: Partial<HolidaySettings> | undefined): HolidaySettings {
  const country = (settings?.country || defaultHolidaySettings.country).trim().toUpperCase()
  const state = settings?.state?.trim() || undefined
  const region = state ? settings?.region?.trim() || undefined : undefined
  const language = (settings?.language || defaultHolidaySettings.language).trim().slice(0, 2).toLowerCase() || 'de'

  return {
    country,
    state,
    region,
    language,
    updatedAt: settings?.updatedAt,
    updatedBy: settings?.updatedBy,
  }
}

function holidayEngine(settings: HolidaySettings) {
  const normalized = normalizeHolidaySettings(settings)
  const holidays = new Holidays({ languages: [normalized.language], types: ['public'] })

  if (normalized.state && normalized.region) {
    holidays.init(normalized.country, normalized.state, normalized.region)
  } else if (normalized.state) {
    holidays.init(normalized.country, normalized.state)
  } else {
    holidays.init(normalized.country)
  }

  return holidays
}

export function holidayTemplateOptions(settings: Partial<HolidaySettings> | undefined): HolidayTemplateOptions {
  const normalized = normalizeHolidaySettings(settings)
  const holidays = new Holidays()
  const countries = asOptions(holidays.getCountries(normalized.language))
  const countrySupported = countries.some((country) => country.code === normalized.country)
  const states = countrySupported ? asOptions(holidays.getStates(normalized.country, normalized.language)) : []
  const stateSupported = states.some((state) => state.code === normalized.state)
  const regions =
    countrySupported && normalized.state && stateSupported
      ? asOptions(holidays.getRegions(normalized.country, normalized.state, normalized.language))
      : []

  return { countries, states, regions }
}

export function holidaySettingsSupported(settings: HolidaySettings) {
  const normalized = normalizeHolidaySettings(settings)
  const options = holidayTemplateOptions(normalized)

  if (!options.countries.some((country) => country.code === normalized.country)) {
    return false
  }

  if (normalized.state && !options.states.some((state) => state.code === normalized.state)) {
    return false
  }

  if (normalized.region && !options.regions.some((region) => region.code === normalized.region)) {
    return false
  }

  return true
}

function templateHolidayId(settings: HolidaySettings, holiday: HolidaysTypes.Holiday) {
  const scope = [settings.country, settings.state, settings.region].filter(Boolean).join('-')
  return `template-${scope}-${holiday.date.slice(0, 10)}-${holiday.name.toLowerCase().replace(/[^\w]+/g, '-')}`
}

function templateHolidaysForYear(year: number, settings: HolidaySettings): Holiday[] {
  const normalized = normalizeHolidaySettings(settings)
  const holidays = holidayEngine(normalized)
  const byDate = new Map<string, Holiday>()

  for (const holiday of holidays.getHolidays(year, normalized.language).filter((item) => item.type === 'public')) {
    const date = holiday.date.slice(0, 10)
    const existing = byDate.get(date)
    if (existing) {
      existing.name = existing.name.includes(holiday.name) ? existing.name : `${existing.name} / ${holiday.name}`
      continue
    }

    byDate.set(date, {
      id: templateHolidayId(normalized, holiday),
      date,
      name: holiday.name,
      source: 'template',
      freePercent: 100,
    })
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

export function holidaysForYears(
  years: number[],
  overrides: HolidayOverride[],
  settings: HolidaySettings = defaultHolidaySettings,
) {
  const normalized = normalizeHolidaySettings(settings)
  const yearSet = [...new Set(years)]
  const holidays = yearSet.flatMap((year) => templateHolidaysForYear(year, normalized))

  const effectiveOverrides = new Map<string, HolidayOverride>()
  for (const override of overrides) {
    if (!effectiveOverrides.has(override.date)) {
      effectiveOverrides.set(override.date, override)
    }
  }

  const effectiveOverrideList = [...effectiveOverrides.values()]
  const disabledDates = new Set(effectiveOverrideList.filter((override) => override.type === 'disabled').map((override) => override.date))
  const custom = effectiveOverrideList
    .filter((override) => override.type === 'custom')
    .map<Holiday>((override) => ({
      id: override.id,
      date: override.date,
      name: override.name,
      source: 'custom',
      freePercent: override.freePercent,
    }))
  const customDates = new Set(custom.map((holiday) => holiday.date))

  return [
    ...holidays.filter((holiday) => !disabledDates.has(holiday.date) && !customDates.has(holiday.date)),
    ...custom,
  ].sort((left, right) => left.date.localeCompare(right.date))
}

export function makeHolidayOverride(
  date: string,
  name: string,
  type: HolidayOverride['type'],
  freePercent: number,
  createdBy: string,
): HolidayOverride {
  return {
    id: randomUUID(),
    date,
    name,
    type,
    freePercent,
    createdBy,
    createdAt: new Date().toISOString(),
  }
}

export function currentHolidayYears() {
  const year = new Date().getFullYear()
  return [year - 1, year, year + 1]
}

export function holidaySet(holidays: Holiday[]) {
  return new Set(holidays.map((holiday) => holiday.date))
}

export function holidayByDate(holidays: Holiday[]) {
  return new Map(holidays.map((holiday) => [holiday.date, holiday]))
}

export function holidayNameByDate(holidays: Holiday[]) {
  return new Map(holidays.map((holiday) => [holiday.date, holiday.name]))
}

export function yearFromDateKey(dateKey: string) {
  return Number(dateKey.slice(0, 4))
}

export function yearsForDateRange(startDate: string, endDate: string) {
  const years: number[] = []
  for (let year = yearFromDateKey(startDate); year <= yearFromDateKey(endDate); year += 1) {
    years.push(year)
  }
  return years
}

export function todayYear() {
  return Number(toDateKey(new Date()).slice(0, 4))
}
