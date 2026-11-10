import { catalogLink, catalogUnit, euroPrice } from './catalog.ts'
import { roundQuantity } from './workflows.ts'

export type PurchasePart = { id: string; itemId?: string; name: string; unit: string; sku?: string; active?: boolean; supplierUrl?: string; estimatedUnitCost?: number }
export type PurchaseListRow = { rows: number[]; name: string; quantity: number; unit: string; partId?: string; itemId?: string; supplierUrl?: string; estimatedUnitCost?: number; alreadySelected: boolean; errors: string[] }
export type PurchaseListPreview = { rows: PurchaseListRow[]; errors: string[] }
const key = (value: string) => value.trim().toLocaleLowerCase()
const headerKey = (value: string) => key(value).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '')
const columns = {
  name: ['name', 'artikel', 'article', 'item', 'teil', 'part', 'bezeichnung', 'itemname'],
  sku: ['sku', 'artikelnummer', 'partnumber'],
  quantity: ['menge', 'quantity', 'qty', 'anzahl', 'amount'],
  unit: ['einheit', 'unit'],
  link: ['link', 'url', 'lieferantenlink', 'supplierurl'],
  price: ['preis', 'preiseur', 'price', 'priceeur', 'unitprice', 'estimatedunitcost'],
} as const

/** Clipboard TSV and quoted CSV, with separators detected outside quoted cells. */
function matrix(text: string) {
  let quoted = false
  const counts = new Map([['\t', 0], [';', 0], [',', 0]])
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' && quoted && text[i + 1] === '"') { i++; continue }
    if (char === '"') quoted = !quoted
    else if (!quoted && ['\n', '\r'].includes(char)) break
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0]
  const result: string[][] = [], row: string[] = []
  let value = '', closed = false
  quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else value += char
    } else if (char === delimiter) { row.push(value.trim()); value = ''; closed = false }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(value.trim()); result.push([...row]); row.length = 0; value = ''; closed = false
    } else if (char === '"' && !value.trim() && !closed) quoted = true
    else if (closed && char.trim()) throw new Error('quotes')
    else value += char
  }
  if (quoted) throw new Error('quotes')
  if (value || row.length) { row.push(value.trim()); result.push(row) }
  return result
}

export function previewPurchaseList(text: string, parts: PurchasePart[], quantities: Record<string, string>, options: { language?: 'en' | 'de'; pendingName?: string } = {}): PurchaseListPreview {
  const t = (en: string, de: string) => options.language === 'de' ? de : en
  const errors: string[] = [], rows: PurchaseListRow[] = []
  if (text.length > 200_000) return { rows, errors: [t('Paste at most 100 parts (200 KB).', 'Höchstens 100 Teile einfügen (200 KB).')] }
  let cells: string[][]
  try { cells = matrix(text.replace(/^\uFEFF/, '').trim()) } catch { return { rows, errors: [t('The quotation marks are incomplete. Check the pasted cells.', 'Anführungszeichen sind unvollständig. Bitte die eingefügten Zellen prüfen.')] } }
  if (!cells.length) return { rows, errors: [t('Paste the parts and quantities first.', 'Zuerst Teile und Mengen einfügen.')] }
  const indexes = Object.fromEntries(Object.entries(columns).map(([name, aliases]) => [name, cells[0].findIndex(cell => (aliases as readonly string[]).includes(headerKey(cell)))])) as Record<keyof typeof columns, number>
  const hasHeader = indexes.quantity >= 0 || indexes.name >= 0 || indexes.sku >= 0
  if (hasHeader) {
    if (indexes.quantity < 0 || (indexes.name < 0 && indexes.sku < 0)) errors.push(t('Use Article (or SKU) and Quantity columns.', 'Die Spalten Artikel (oder SKU) und Menge werden benötigt.'))
    for (const [name, aliases] of Object.entries(columns)) if (cells[0].filter(cell => (aliases as readonly string[]).includes(headerKey(cell))).length > 1) errors.push(t(`Column ${name} occurs more than once.`, `Spalte ${name} ist mehrfach vorhanden.`))
  } else Object.assign(indexes, { name: 0, quantity: 1, unit: 2, link: 3, price: 4, sku: -1 })
  if (errors.length) return { rows, errors }
  const data = cells.slice(hasHeader ? 1 : 0).map((row, i) => ({ row, number: i + (hasHeader ? 2 : 1) })).filter(({ row }) => row.some(Boolean))
  if (!data.length || data.length > 100) return { rows, errors: [t('Use between 1 and 100 part rows.', 'Zwischen 1 und 100 Teilezeilen einfügen.')] }
  const byName = new Map<string, PurchasePart[]>(), bySku = new Map<string, PurchasePart[]>()
  for (const part of parts) {
    const name = key(part.name); byName.set(name, [...(byName.get(name) ?? []), part])
    if (part.sku) { const sku = key(part.sku); bySku.set(sku, [...(bySku.get(sku) ?? []), part]) }
  }
  const byKey = new Map<string, PurchaseListRow>()
  for (const { row, number } of data) {
    const cell = (name: keyof typeof columns) => row[indexes[name]] ?? ''
    const name = cell('name'), sku = cell('sku'), rowErrors: string[] = []
    // A decimal comma in unquoted comma-separated CSV can otherwise become
    // an extra cell: "Mat material,2,5" must never silently request only 2 m².
    if (row.slice(hasHeader ? cells[0].length : 5).some(Boolean)) rowErrors.push(t('More columns than expected. In comma-separated CSV, quote decimal values such as "2,5", or use tabs/semicolons.', 'Mehr Spalten als erwartet. In komma-getrennter CSV Dezimalwerte wie "2,5" in Anführungszeichen setzen oder Tabulator/Semikolon verwenden.'))
    const named = byName.get(key(name)) ?? [], numbered = bySku.get(key(sku || name)) ?? []
    const candidates = sku ? numbered : named.length ? named : numbered
    const part = candidates.length === 1 ? candidates[0] : undefined
    if (candidates.length > 1) rowErrors.push(t('Several articles match. Use a unique SKU.', 'Mehrere Artikel passen. Eine eindeutige SKU verwenden.'))
    if (sku && !part) rowErrors.push(t('Unknown SKU. For a new part, put its name and part number together in Article.', 'Unbekannte SKU. Bei einem neuen Teil Name und Teilenummer zusammen unter Artikel eintragen.'))
    if (sku && name && part && key(name) !== key(part.name)) rowErrors.push(t('The name and SKU refer to different articles. Use the catalog name or leave Name blank.', 'Name und SKU stimmen nicht überein. Katalognamen verwenden oder Name leer lassen.'))
    if (!name && !part) rowErrors.push(t('Enter a part name or an existing SKU.', 'Teilnamen oder eine vorhandene SKU angeben.'))
    if (name.length > 160) rowErrors.push(t('Use a name up to 160 characters.', 'Teilnamen auf 160 Zeichen begrenzen.'))
    if (part?.active === false) rowErrors.push(t('This article is archived. Choose an active article.', 'Dieser Artikel ist archiviert. Einen aktiven Artikel wählen.'))
    const rawQuantity = cell('quantity'), quantity = Number(rawQuantity.replace(',', '.'))
    if (!/^\d+(?:[.,]\d{1,6})?$/.test(rawQuantity) || quantity <= 0 || quantity > 1e9) rowErrors.push(t('Enter a positive quantity, with comma or dot decimals and no thousands separators.', 'Eine positive Menge mit Komma oder Punkt, ohne Tausendertrennzeichen, eingeben.'))
    let unit = part?.unit ?? 'pcs', supplierUrl: string | undefined, estimatedUnitCost: number | undefined
    try { unit = catalogUnit(cell('unit') || part?.unit, part?.unit); if (part && unit !== part.unit) throw new Error() } catch { rowErrors.push(t(`Choose a valid unit${part ? ` (${part.unit})` : ''}.`, `Eine gültige Einheit wählen${part ? ` (${part.unit})` : ''}.`)) }
    try { supplierUrl = catalogLink(cell('link')) } catch { rowErrors.push(t('Use a valid http(s) supplier link.', 'Einen gültigen http(s)-Lieferantenlink verwenden.')) }
    try { estimatedUnitCost = euroPrice(cell('price')) } catch { rowErrors.push(t('Enter the EUR unit price without currency symbols or thousands separators.', 'EUR-Stückpreis ohne Währungssymbol oder Tausendertrennzeichen eingeben.')) }
    const partKey = part ? `part:${part.id}` : `new:${key(name)}`
    const previous = byKey.get(partKey)
    if (previous) {
      previous.rows.push(number); previous.errors.push(...rowErrors)
      if (previous.unit !== unit || (previous.supplierUrl && supplierUrl && previous.supplierUrl !== supplierUrl) || (previous.estimatedUnitCost !== undefined && estimatedUnitCost !== undefined && previous.estimatedUnitCost !== estimatedUnitCost)) previous.errors.push(t('Repeated part has different units, links or prices. Combine it into one row.', 'Wiederholtes Teil hat unterschiedliche Einheiten, Links oder Preise. In einer Zeile zusammenfassen.'))
      previous.quantity = roundQuantity(previous.quantity + (Number.isFinite(quantity) ? quantity : 0))
      if (previous.quantity > 1e9) previous.errors.push(t('Combined quantity is too large.', 'Die zusammengefasste Menge ist zu groß.'))
      previous.supplierUrl ??= supplierUrl; previous.estimatedUnitCost ??= estimatedUnitCost
    } else {
      const value: PurchaseListRow = { rows: [number], name: part?.name ?? name, partId: part?.id, itemId: part?.itemId, unit, quantity: Number.isFinite(quantity) ? quantity : 0, supplierUrl, estimatedUnitCost, alreadySelected: Boolean(part && Number(quantities[part.id]) > 0) || Boolean(options.pendingName && key(options.pendingName) === key(part?.name ?? name)), errors: rowErrors }
      rows.push(value); byKey.set(partKey, value)
    }
  }
  const selectedCount = Object.values(quantities).filter(value => Number(value) > 0).length + Number(Boolean(options.pendingName?.trim()))
  if (selectedCount + rows.filter(row => !row.alreadySelected).length > 100) errors.push(t('A request can contain at most 100 parts, including your existing selection.', 'Eine Anfrage darf einschließlich deiner bisherigen Auswahl höchstens 100 Teile enthalten.'))
  return { rows, errors }
}
