export interface ReceivingImportRow {
  rowNumber: number
  receivedAt: string
  itemName: string
  itemId?: string
  quantity?: number
  quantityLabel?: string
  locationName: string
  locationId?: string
  notes?: string
  receiverLabel?: string
  supplier?: string
  orderReference?: string
  deliveryNoteNumber?: string
  barcode?: string
  sourceReference?: string
  errors: string[]
  warnings: string[]
}

const aliases = {
  receivedAt: ['date', 'datum', 'received', 'receivedat', 'receiptdate', 'eingang', 'wareneingang'],
  itemName: ['item', 'article', 'artikel', 'description', 'beschreibung', 'part', 'material'],
  quantity: ['quantity', 'qty', 'menge', 'amount', 'anzahl'],
  quantityLabel: ['packaging', 'packagingdescription', 'quantitylabel', 'gebinde', 'verpackung'],
  locationName: ['location', 'storage', 'place', 'lagerort', 'ort', 'ablage'],
  notes: ['notes', 'note', 'remarks', 'remark', 'notiz', 'bemerkung', 'kommentar'],
  receiverLabel: ['receiver', 'receivedby', 'initials', 'bearbeiter', 'kuerzel', 'kürzel'],
  supplier: ['supplier', 'vendor', 'lieferant'],
  orderReference: ['order', 'orderreference', 'po', 'bestellung', 'bestellnummer'],
  deliveryNoteNumber: ['deliverynote', 'deliverynotenumber', 'lieferschein', 'lieferscheinnummer'],
  barcode: ['barcode', 'qr', 'ean', 'gtin'],
} as const

function normalizedHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('de-DE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function columnIndexes(header: unknown[]) {
  const normalized = header.map(normalizedHeader)
  return Object.fromEntries(
    Object.entries(aliases).map(([field, choices]) => [field, normalized.findIndex((value) => (choices as readonly string[]).map(normalizedHeader).includes(value))]),
  ) as Record<keyof typeof aliases, number>
}

function cell(row: unknown[], index: number) {
  if (index < 0) return ''
  const value = row[index]
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '').trim()
}

function parseDate(value: string) {
  if (!value) return ''
  if (/^\d{5}(?:\.\d+)?$/.test(value)) {
    const serial = Number(value)
    if (serial > 20_000 && serial < 80_000) return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString()
  }
  const german = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/)
  if (german) {
    const year = Number(german[3]) < 100 ? 2000 + Number(german[3]) : Number(german[3])
    const date = new Date(Date.UTC(year, Number(german[2]) - 1, Number(german[1]), 12))
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  const direct = new Date(value)
  if (!Number.isNaN(direct.getTime()) && /[T\-/]/.test(value)) return direct.toISOString()
  return ''
}

export function parseQuantity(value: string) {
  const normalized = value.trim().replace(',', '.')
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized)
  const leading = normalized.match(/^\s*(\d+(?:\.\d+)?)\b/i)
  return leading ? Number(leading[1]) : undefined
}

export function rowsFromMatrix(matrix: unknown[][], sourceName: string, sheetName = 'Sheet1'): ReceivingImportRow[] {
  const headerIndex = matrix.findIndex((row) => {
    const values = row.map(normalizedHeader)
    return values.some((value) => aliases.itemName.includes(value as never)) && values.some((value) => aliases.quantity.includes(value as never))
  })
  if (headerIndex < 0) throw new Error('No header row with item/article and quantity columns was found.')
  const indexes = columnIndexes(matrix[headerIndex])
  return matrix.slice(headerIndex + 1).flatMap((row, offset) => {
    const rowNumber = headerIndex + offset + 2
    const itemName = cell(row, indexes.itemName)
    const quantityRaw = cell(row, indexes.quantity)
    const locationName = cell(row, indexes.locationName)
    if (!itemName && !quantityRaw && !locationName) return []
    const receivedAt = parseDate(cell(row, indexes.receivedAt))
    const quantity = parseQuantity(quantityRaw)
    const explicitQuantityLabel = cell(row, indexes.quantityLabel)
    const errors: string[] = []
    const warnings: string[] = []
    if (!receivedAt) errors.push('Receipt date is missing or invalid.')
    if (!itemName) errors.push('Item/article is missing.')
    if (quantity === undefined || quantity <= 0 || !/^-?\d+(?:[.,]\d+)?$/.test(quantityRaw)) warnings.push('Quantity needs review; the original text is preserved.')
    if (!locationName) errors.push('Storage location is missing.')
    return [{
      rowNumber,
      receivedAt,
      itemName,
      quantity,
      quantityLabel: explicitQuantityLabel || (quantity === undefined || quantityRaw !== String(quantity) ? quantityRaw : undefined),
      locationName,
      notes: cell(row, indexes.notes) || undefined,
      receiverLabel: cell(row, indexes.receiverLabel) || undefined,
      supplier: cell(row, indexes.supplier) || undefined,
      orderReference: cell(row, indexes.orderReference) || undefined,
      deliveryNoteNumber: cell(row, indexes.deliveryNoteNumber) || undefined,
      barcode: cell(row, indexes.barcode) || undefined,
      sourceReference: `${sourceName} · ${sheetName}!row ${rowNumber}`,
      errors,
      warnings,
    }]
  })
}

export function parseCsv(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === delimiter && !quoted) {
      row.push(value)
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }
  if (value || row.length) {
    row.push(value)
    rows.push(row)
  }
  return rows
}
