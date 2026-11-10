/** Supported measurement units. Existing custom units remain readable/editable. */
export const catalogUnits = ['pcs', 'set', 'pair', 'm', 'm²', 'cm', 'mm', 'kg', 'g', 'l', 'ml', 'sheet', 'roll', 'pack'] as const
const unitAliases: Record<string, string> = { stück: 'pcs', stueck: 'pcs', stk: 'pcs', piece: 'pcs', pieces: 'pcs', m2: 'm²', sqm: 'm²', liter: 'l', metre: 'm', meter: 'm', blatt: 'sheet', rolle: 'roll', paar: 'pair', packung: 'pack' }
export function catalogUnit(value: unknown, existing?: string) {
  const raw = String(value ?? '').trim() || 'pcs'
  const unit = unitAliases[raw.toLowerCase()] ?? raw.toLowerCase()
  if (!(catalogUnits as readonly string[]).includes(unit) && raw !== existing) throw new Error('Choose a supported unit / Bitte eine gültige Einheit wählen.')
  return raw === existing && !(catalogUnits as readonly string[]).includes(unit) ? raw : unit
}
/** No thousands separators: both decimal conventions are accepted without guessing. */
export interface EuroFormat { decimalPlaces?: 2 | 4 | 6; maximum?: number }
export function euroPrice(value: unknown, { decimalPlaces = 4, maximum = 1e7 }: EuroFormat = {}): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const raw = String(value).trim()
  if (!new RegExp(`^\\d+(?:[.,]\\d{1,${decimalPlaces}})?$`).test(raw)) throw new Error('EUR price: use 12,50 or 12.50, without thousands separators or currency symbols.')
  const result = Number(raw.replace(',', '.'))
  if (!Number.isFinite(result) || result > maximum) throw new Error('Invalid EUR price.')
  return result
}
export function catalogLink(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  if (text.length > 2000) throw new Error('Link is too long.')
  try { const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); return url.href } catch { throw new Error('Enter a valid http(s) article link.') }
}
