import { randomUUID } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { Database } from './store.ts'
import { nowIso } from './store.ts'
import type { ImportBatch, TimeEntry } from '../shared/domain.ts'
import { isoFromDateAndTime, isSensibleDateKey, toDateKey } from '../shared/dates.ts'

interface ImportOptions {
  userId: string
  importedBy: string
  csv: string
  fileName: string
}

interface CsvRecord {
  [key: string]: string | undefined
}

const headerCandidates = {
  date: ['date', 'datum', 'day', 'tag', 'arbeitstag', 'work date'],
  start: ['start', 'beginn', 'von', 'start work', 'clock in', 'arbeitsbeginn', 'kommen', 'startzeit'],
  end: ['end', 'ende', 'bis', 'stop work', 'clock out', 'arbeitsende', 'gehen', 'endzeit'],
  break: ['break', 'pause', 'pausen', 'pausenzeit', 'break minutes', 'pause minutes'],
  duration: ['duration', 'dauer', 'arbeitszeit', 'worked', 'total', 'stunden', 'gesamt'],
  note: ['note', 'notes', 'notiz', 'kommentar', 'description', 'beschreibung', 'project', 'projekt'],
}

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findHeader(headers: string[], candidates: string[]) {
  return headers.find((header) => candidates.some((candidate) => normalizeHeader(header).includes(candidate)))
}

function readValue(record: CsvRecord, header?: string) {
  return header ? record[header]?.trim() ?? '' : ''
}

function parseDate(value: string) {
  const trimmed = value.trim()
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  }

  const german = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/)
  if (german) {
    const year = german[3].length === 2 ? `20${german[3]}` : german[3]
    return `${year}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`
  }

  const slashed = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (slashed) {
    const year = slashed[3].length === 2 ? `20${slashed[3]}` : slashed[3]
    return `${year}-${slashed[2].padStart(2, '0')}-${slashed[1].padStart(2, '0')}`
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? undefined : toDateKey(parsed)
}

function parseTime(value: string) {
  const trimmed = value.trim()
  const match = trimmed.match(/(\d{1,2})[:.](\d{2})/)
  if (!match) {
    return undefined
  }

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    return undefined
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseDurationMinutes(value: string, defaultUnit: 'hours' | 'minutes') {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return 0
  }

  const colon = trimmed.match(/^(-?\d{1,3}):(\d{2})$/)
  if (colon) {
    return Number(colon[1]) * 60 + Number(colon[2])
  }

  const text = trimmed.match(/(?:(-?\d+(?:[,.]\d+)?)\s*h)?\s*(?:(\d+)\s*m)?/)
  if (text && (text[1] || text[2])) {
    return Math.round(Number((text[1] ?? '0').replace(',', '.')) * 60 + Number(text[2] ?? 0))
  }

  const numeric = Number(trimmed.replace(',', '.'))
  if (!Number.isFinite(numeric)) {
    return 0
  }

  if (defaultUnit === 'hours' && Math.abs(numeric) <= 24) {
    return Math.round(numeric * 60)
  }

  return Math.round(numeric)
}

function stopFromDuration(startedAt: string, workedMinutes: number, breakMinutes: number) {
  const stop = new Date(startedAt)
  stop.setMinutes(stop.getMinutes() + workedMinutes + breakMinutes)
  return stop.toISOString()
}

function normalizeRecords(csv: string) {
  return parse(csv, {
    bom: true,
    columns: true,
    delimiter: [',', ';', '\t'],
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRecord[]
}

function duplicateExists(entries: TimeEntry[], entry: TimeEntry) {
  return entries.some(
    (existing) =>
      existing.userId === entry.userId &&
      existing.date === entry.date &&
      existing.startedAt === entry.startedAt &&
      existing.stoppedAt === entry.stoppedAt,
  )
}

export function importTimeCsv(database: Database, options: ImportOptions): ImportBatch {
  const records = normalizeRecords(options.csv)
  const headers = records.length > 0 ? Object.keys(records[0]) : []
  const dateHeader = findHeader(headers, headerCandidates.date)
  const startHeader = findHeader(headers, headerCandidates.start)
  const endHeader = findHeader(headers, headerCandidates.end)
  const breakHeader = findHeader(headers, headerCandidates.break)
  const durationHeader = findHeader(headers, headerCandidates.duration)
  const noteHeader = findHeader(headers, headerCandidates.note)
  const errors: string[] = []
  let importedRows = 0
  let skippedRows = 0
  let earliestImportedDate: string | undefined
  const batchId = randomUUID()
  const createdAt = nowIso()

  if (!dateHeader && !startHeader) {
    throw new Error('Could not find a date column in the CSV.')
  }

  records.forEach((record, index) => {
    const line = index + 2
    const date = parseDate(readValue(record, dateHeader) || readValue(record, startHeader))
    const startTime = parseTime(readValue(record, startHeader)) ?? '09:00'
    const endTime = parseTime(readValue(record, endHeader))
    const breakMinutes = parseDurationMinutes(readValue(record, breakHeader), 'minutes')
    const durationMinutes = parseDurationMinutes(readValue(record, durationHeader), 'hours')

    if (!date || !isSensibleDateKey(date)) {
      skippedRows += 1
      errors.push(`Line ${line}: missing, impossible, or unsupported date.`)
      return
    }

    if (!endTime && durationMinutes <= 0) {
      skippedRows += 1
      errors.push(`Line ${line}: missing end time or duration.`)
      return
    }

    const startedAt = isoFromDateAndTime(date, startTime)
    let stoppedAt = endTime ? isoFromDateAndTime(date, endTime) : stopFromDuration(startedAt, durationMinutes, breakMinutes)
    if (new Date(stoppedAt).getTime() < new Date(startedAt).getTime()) {
      const nextDay = new Date(stoppedAt)
      nextDay.setDate(nextDay.getDate() + 1)
      stoppedAt = nextDay.toISOString()
    }

    const noteParts = [readValue(record, noteHeader)]
    if (!endTime) {
      noteParts.push('Imported from duration-only CSV row.')
    }

    const entry: TimeEntry = {
      id: randomUUID(),
      userId: options.userId,
      date,
      startedAt,
      stoppedAt,
      breaks: [],
      manualBreakMinutes: Math.max(0, breakMinutes),
      source: 'imported_csv',
      note: noteParts.filter(Boolean).join(' '),
      importBatchId: batchId,
      createdAt,
      updatedAt: createdAt,
    }

    if (duplicateExists(database.timeEntries, entry)) {
      skippedRows += 1
      errors.push(`Line ${line}: duplicate time entry skipped.`)
      return
    }

    database.timeEntries.push(entry)
    earliestImportedDate = earliestImportedDate && earliestImportedDate < date ? earliestImportedDate : date
    importedRows += 1
  })

  const user = database.users.find((candidate) => candidate.id === options.userId)
  if (user && earliestImportedDate && (!user.trackingStartDate || earliestImportedDate < user.trackingStartDate)) {
    user.trackingStartDate = earliestImportedDate
  }

  const batch: ImportBatch = {
    id: batchId,
    userId: options.userId,
    importedBy: options.importedBy,
    fileName: options.fileName || 'time-import.csv',
    importedRows,
    skippedRows,
    errors,
    createdAt,
  }
  database.importBatches.unshift(batch)
  return batch
}
